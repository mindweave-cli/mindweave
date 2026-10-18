/**
 * screenshotWin.ts — the Windows half of `screenshot`.
 *
 * Capturing a window on Windows is a pile of Win32 detail, so it lives here and
 * the tool file stays about policy (which window, who approved it, what the model
 * is told). Zero dependencies: the capture runs through PowerShell against .NET,
 * both of which ship with the OS. An npm package for this would mean a native
 * binary per platform for a feature that is Windows-only by design.
 *
 * The script is a STRING rather than a `.ps1` on disk because `tsc` copies no
 * assets — a separate file would work from source and be missing from `dist/`,
 * which is the build the user actually runs.
 *
 * Three Win32 details that are wrong-by-default and each cost a real bug:
 *
 *  1. `SetProcessDPIAware` first, or every measurement is virtualized. Without it
 *     a window on a scaled display reports logical pixels while the bitmap is in
 *     physical ones, and the capture comes out cropped or padded.
 *  2. `PrintWindow` with PW_RENDERFULLCONTENT (2), not 0. The flag exists because
 *     hardware-composited windows — Chrome, Electron, VS Code, most terminals —
 *     capture as an empty rectangle without it. It is Windows 8.1+, which the
 *     supported range already exceeds.
 *  3. `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` for bounds, not
 *     `GetWindowRect`. Since Windows 10 the latter includes an invisible resize
 *     border, so cropping to it leaves a transparent margin around every capture.
 *
 * PrintWindow still fails on some windows (a few renderers refuse to draw into a
 * caller-supplied DC), so a blank result falls back to copying that rectangle off
 * the screen. That fallback captures whatever is physically on top, which is why
 * the tool asks for approval BEFORE any of this runs.
 *
 * Enumeration is the standard "would this window appear in Alt-Tab" test rather than
 * "does it have a title": DWM-cloaked windows (invisible UWP and host windows that still
 * report visible) and tool windows are skipped, and a window with an EMPTY title is kept
 * and labelled by its process. An empty title is the normal state of an app with a custom
 * title bar (Tauri, Electron with decorations off), and dropping those made a window the
 * user was plainly looking at impossible to capture at all.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESK_CS, HIDDEN_MARK, hiddenDesktopName, windowArgs } from "./hiddenDesktop.js";

/** One capturable top-level window. */
export interface WindowInfo {
  /** Win32 HWND, as a decimal string — only ever handed straight back to the script. */
  handle: string;
  title: string;
  /** True for the window that currently has focus: what "the app" usually means. */
  foreground: boolean;
  /**
   * The window this process itself runs in: the terminal Mindweave is typed into, or the desktop app that
   * hosts it. It is where the user is looking while the agent works, so it is the focused window almost
   * every time, and a picture of it is never a picture of the app being tested.
   */
  host?: boolean;
}

const PS_TIMEOUT_MS = 20_000;

const SCRIPT = String.raw`
param([string]$Mode = "list", [string]$Handle = "", [string]$Out = "", [string]$Desktop = "", [string]$Hidden = "", [int]$Owner = 0)
$ErrorActionPreference = "Stop"
# The window list is read back as UTF-8. Without this the console's own code page is used, and every title with a
# dash, an accent or a CJK character reached the model as "?" (real sessions: "Microsoft? Edge", "? Greeting"),
# which made the title impossible to copy back into a call.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class MwCapture {
    // The processes this one runs inside (the terminal, its console host, the app hosting it).
    // Their windows are marked "host" in the list, so the caller can tell them from the app under test.
    public static HashSet<uint> HostPids = new HashSet<uint>();
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetIntAttribute(IntPtr h, int attr, out int v, int size);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static void Dpi() { SetProcessDPIAware(); }

    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

    // The window the console this process is attached to is drawn in. In Windows Terminal the console
    // window is a hidden stand-in owned by the real top-level window, so the owner is what is returned.
    // Empty when there is no console (the desktop app, a service).
    public static string HostWindow() {
        IntPtr c = GetConsoleWindow();
        if (c == IntPtr.Zero) return "";
        IntPtr root = GetAncestor(c, 3 /* GA_ROOTOWNER */);
        return (root == IntPtr.Zero ? c : root).ToInt64().ToString();
    }

    // A DWM-cloaked window passes IsWindowVisible but is not actually on screen — the
    // invisible UWP and host windows that would otherwise flood the list. Any failure to
    // read the attribute is treated as not-cloaked, so a window is never dropped on error.
    static bool Cloaked(IntPtr h) {
        int v;
        return DwmGetIntAttribute(h, 14 /* DWMWA_CLOAKED */, out v, sizeof(int)) == 0 && v != 0;
    }

    // The Shell's own "is this an Alt-Tab window" test: a tool window is a palette or
    // tray surface and is never what "the app" means, unless it also asks for the taskbar.
    static bool AltTabWorthy(IntPtr h) {
        int ex = GetWindowLong(h, -20 /* GWL_EXSTYLE */);
        bool tool = (ex & 0x00000080) != 0; // WS_EX_TOOLWINDOW
        bool app = (ex & 0x00040000) != 0;  // WS_EX_APPWINDOW
        return !tool || app;
    }

    // The window's process name, for a window that has no title of its own. Wrapped
    // because the process can exit between the enum and the lookup.
    static string ProcName(IntPtr h) {
        try {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return "";
            using (var p = System.Diagnostics.Process.GetProcessById((int)pid)) return p.ProcessName;
        } catch { return ""; }
    }

    // DWMWA_EXTENDED_FRAME_BOUNDS. GetWindowRect includes an invisible border on
    // Windows 10+, so it is the fallback rather than the first choice.
    static bool Bounds(IntPtr h, out RECT r) {
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0
            && r.Right > r.Left && r.Bottom > r.Top) return true;
        return GetWindowRect(h, out r);
    }

    // The hidden desktop's windows are marked, so a capture is sent back there.
    public static string ListOn(string desk) {
        return MwDesk.On(desk, () => string.Join("\n", List("${HIDDEN_MARK}").ToArray()));
    }

    public static List<string> List(string mark) {
        var found = new List<string>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            if (Cloaked(h) || !AltTabWorthy(h)) return true;
            RECT r;
            if (!Bounds(h, out r)) return true;
            // Tool windows and tray hosts are real but never what anyone means.
            if (r.Right - r.Left < 120 || r.Bottom - r.Top < 120) return true;
            int len = GetWindowTextLength(h);
            string title = "";
            if (len > 0) {
                var sb = new StringBuilder(len + 1);
                GetWindowText(h, sb, sb.Capacity);
                title = sb.ToString().Trim();
            }
            // An empty title is NOT a reason to drop the window. A custom title bar
            // (Tauri or Electron with decorations off) leaves the OS title blank, as does
            // an app whose web content has not set document.title yet — and dropping it
            // makes a window the user is plainly looking at impossible to capture, by name
            // OR as the foreground. Label it by its process so it stays nameable.
            if (title.Length == 0) {
                string pn = ProcName(h);
                title = pn.Length > 0 ? pn : "(untitled window)";
            }
            // The leading marker is how the caller knows which window the user is
            // actually looking at, so it can name it when asking permission.
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            string hostCol = mark.Length == 0 && HostPids.Contains(wpid) ? "\thost" : "";
            found.Add((h == fg && mark.Length == 0 ? "*" : "-") + mark + h.ToInt64().ToString() + "\t" + title + hostCol);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string CaptureOn(string desk, IntPtr h, string path) {
        return MwDesk.On(desk, () => Capture(h, path, string.IsNullOrEmpty(desk)));
    }

    // screen: whether a blank PrintWindow may fall back to copying the screen. Never for a
    // window on the hidden desktop: the screen is the USER's, and that window is not on it.
    public static string Capture(IntPtr h, string path, bool screen) {
        RECT r;
        if (!Bounds(h, out r)) return "ERR could not measure the window";
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0) return "ERR the window has no visible area";
        using (var bmp = new Bitmap(w, ht)) {
            bool drew = false;
            using (var g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                drew = PrintWindow(h, hdc, 2); // PW_RENDERFULLCONTENT
                g.ReleaseHdc(hdc);
            }
            if (!drew || Blank(bmp)) {
                if (!screen) return "ERR the window drew nothing to capture";
                using (var g = Graphics.FromImage(bmp)) {
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, ht));
                }
            }
            bmp.Save(path, ImageFormat.Png);
            return "OK " + w + " " + ht;
        }
    }

    // PrintWindow can report success and draw nothing. Sampling three corners of a
    // fully transparent bitmap is enough to tell that apart from a real capture.
    static bool Blank(Bitmap b) {
        if (b.Width < 4 || b.Height < 4) return false;
        return b.GetPixel(1, 1).A == 0
            && b.GetPixel(b.Width / 2, b.Height / 2).A == 0
            && b.GetPixel(b.Width - 2, b.Height - 2).A == 0;
    }
}
${DESK_CS}
"@

# Before any measurement, or every rectangle is in the wrong coordinate space.
[MwCapture]::Dpi() | Out-Null

if ($Mode -eq "host") {
    Write-Output ([MwCapture]::HostWindow())
    exit 0
}

if ($Mode -eq "list") {
    # Which windows are the one this process runs in: walk up from it, stopping at the shell that
    # started the whole session (the desktop, services), and take each console host that belongs to
    # one of those on the way. Every process passed may own the window.
    if ($Owner -gt 0) {
        $procs = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
        $parent = @{}
        $name = @{}
        foreach ($p in $procs) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId; $name[[int]$p.ProcessId] = ([string]$p.Name).ToLower() }
        $stop = @("explorer.exe", "services.exe", "wininit.exe", "winlogon.exe", "csrss.exe", "svchost.exe", "system")
        $seen = @{}
        $at = $Owner
        while ($at -gt 0 -and -not $seen.ContainsKey($at)) {
            $seen[$at] = $true
            if ($stop -contains $name[$at]) { break }
            [void][MwCapture]::HostPids.Add([uint32]$at)
            $at = $parent[$at]
        }
        foreach ($p in $procs) {
            $n = ([string]$p.Name).ToLower()
            if (($n -eq "conhost.exe" -or $n -eq "openconsole.exe") -and [MwCapture]::HostPids.Contains([uint32]$p.ParentProcessId)) { [void][MwCapture]::HostPids.Add([uint32]$p.ProcessId) }
        }
    }
    [MwCapture]::List("") | ForEach-Object { Write-Output $_ }
    # The windows of apps started for testing, which are never on the screen.
    if ($Hidden -and [MwDesk]::Exists($Hidden)) { Write-Output ([MwCapture]::ListOn($Hidden)) }
    exit 0
}

if ($Mode -eq "capture") {
    $h = if ($Handle -eq "foreground") { [MwCapture]::GetForegroundWindow() } else { [IntPtr][Int64]$Handle }
    if ($h -eq [IntPtr]::Zero) { Write-Output "ERR no such window"; exit 1 }
    $r = [MwCapture]::CaptureOn($Desktop, $h, $Out)
    Write-Output $r
    if ($r.StartsWith("ERR")) { exit 1 }
    exit 0
}

Write-Output "ERR unknown mode"
exit 1
`;

let scriptPath: string | null = null;

/** Write the capture script to a temp file once per process. */
async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const dir = await mkdtemp(join(tmpdir(), "mindweave-shot-"));
  const path = join(dir, "capture.ps1");
  await writeFile(path, SCRIPT, "utf8");
  scriptPath = path;
  return path;
}

/** Run the script in one of its two modes. Rejects with the script's own message. */
async function runScript(args: string[], signal?: AbortSignal, shareConsole = false): Promise<string> {
  const script = await ensureScript();
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      // Hidden, with a console of its own, unless it must see THIS process's console (see hostWindowHandle).
      shareConsole ? { stdio: ["ignore", "pipe", "pipe"] } : { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the capture took longer than ${PS_TIMEOUT_MS / 1000}s`));
    }, PS_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.setEncoding("utf8"); // a character split across two chunks is joined, not broken
    child.stdout!.on("data", (d: string) => (out += d));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(firstLine(out) || firstLine(err) || `PowerShell exited ${code}`));
    });
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().replace(/^ERR\s*/, "") ?? "";
}

/**
 * Parse the script's `<*|->handle<TAB>title` lines. Pure, so it can be tested
 * without a desktop — which matters because CI has no interactive session at all.
 * Anything that doesn't match the shape is skipped rather than guessed at.
 */
export function parseWindowList(stdout: string): WindowInfo[] {
  const windows: WindowInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const marked = line.slice(0, tab).trim();
    // A third column, "host", marks the window this process runs in.
    const rest = line.slice(tab + 1).split("\t");
    const host = rest.length > 1 && rest[rest.length - 1]!.trim() === "host";
    const title = (host ? rest.slice(0, -1) : rest).join("\t").trim();
    const match = new RegExp(`^([*-])(${HIDDEN_MARK}?\\d+)$`).exec(marked);
    if (!match || !title) continue;
    windows.push({ handle: match[2]!, title, foreground: match[1] === "*", ...(host ? { host: true } : {}) });
  }
  return windows;
}

/**
 * Every visible, non-minimised, reasonably sized top-level window a user could Alt-Tab
 * to — DWM-cloaked ghosts and tool/palette windows excluded, and a window with no OS
 * title (a custom title bar) kept and labelled by its process rather than dropped.
 */
export async function listWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
  const [raw, host] = await Promise.all([
    runScript(["-Mode", "list", "-Hidden", hiddenDesktopName(), "-Owner", String(process.pid)], signal),
    hostWindowHandle(signal),
  ]);
  const windows = parseWindowList(raw);
  // The terminal's own window: found from the console this process is attached to, which the list cannot see
  // (Windows Terminal is not a parent of the shell, only the owner of its window).
  if (host) for (const w of windows) if (w.handle === host) w.host = true;
  return windows;
}

let hostHandleCache: string | null | undefined;

/**
 * The window of the terminal this process is typed into, as a handle, or null when it has none (the desktop
 * app) or it cannot be told. Asked once and kept: it does not change while the process runs. The question
 * is put by a child that shares this console rather than making one of its own, since a console is what
 * names the window, and that is only done when this process has a terminal at all, so a program with none
 * is never made to open a window.
 */
export async function hostWindowHandle(signal?: AbortSignal): Promise<string | null> {
  if (hostHandleCache !== undefined) return hostHandleCache;
  if (!process.stdout.isTTY && !process.stdin.isTTY) return (hostHandleCache = null);
  try {
    const out = (await runScript(["-Mode", "host"], signal, true)).trim().split(/\s+/).pop() ?? "";
    hostHandleCache = /^\d+$/.test(out) ? out : null;
  } catch {
    hostHandleCache = null;
  }
  return hostHandleCache;
}

/** Capture one window to `outPath`. `handle` may be the literal "foreground". */
export async function captureWindow(
  handle: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const target = windowArgs(handle);
  const out = await runScript(["-Mode", "capture", "-Handle", target.handle, "-Out", outPath, ...target.desktop], signal);
  const match = /OK\s+(\d+)\s+(\d+)/.exec(out);
  if (!match) throw new Error(firstLine(out) || "the capture produced no image");
  return { width: Number(match[1]), height: Number(match[2]) };
}
