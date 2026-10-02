/**
 * uiHide.ts — keep an app the agent started for itself off the user's screen.
 *
 * When the agent launches an app to test it, the app's window opens wherever the app
 * puts it, on top of whatever the user is doing. The agent does not need to see it
 * there: the page route streams it and the window route reads it wherever it is. So the
 * window is moved off every monitor while the agent works, and put back where it was
 * when the test is closed.
 *
 * Only apps the agent started are moved, told apart by process ancestry: the app's
 * process (or, for a WebView2 app, the host that owns the web view's process) must
 * descend from this process, which is true of anything a background shell launched and
 * of nothing the user started. A window the user opened is never touched, and neither is
 * the window this process itself runs in.
 *
 * Moved, not minimised: a minimised window stops drawing, and a window that does not
 * draw cannot be watched, clicked through its page, or recorded.
 *
 * This is the fallback. An app started for testing normally runs on the hidden desktop
 * (hiddenDesktop.ts) and never reaches the screen at all; moving a window after it opened
 * cannot promise that, since it has already been seen. The check here also says when the
 * app is on the hidden desktop, so the caller can tell the model what that means.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { CdpConnection, listTargets, pageTargets } from "./cdp.js";
import { HIDDEN_MARK, hiddenDesktopName } from "./hiddenDesktop.js";

/** A window that was moved, and where it was. */
export interface MovedWindow {
  handle: string;
  x: number;
  y: number;
}

/** What hiding found: the windows it moved, and whether the app is on the hidden desktop
 *  (where nothing needs moving, and nothing can be brought onto the screen). */
export interface HideResult {
  moved: MovedWindow[];
  hiddenDesktop: boolean;
}

const SCRIPT = String.raw`
param([string]$Mode = "hide", [int]$Port = 0, [string]$Handle = "", [int]$Owner = 0, [string]$Windows = "", [string]$Hidden = "")
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class MwHide {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr d, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;

    public static void Dpi() { SetProcessDPIAware(); }

    /** Visible top-level windows of these processes. */
    public static List<IntPtr> WindowsOf(HashSet<uint> pids) {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid) && IsWindowVisible(h)) found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /** Whether any of these processes has a window on the named desktop. */
    public static bool OnDesktop(string name, HashSet<uint> pids) {
        if (string.IsNullOrEmpty(name)) return false;
        IntPtr d = OpenDesktop(name, 0, false, 0x0041 /* DESKTOP_READOBJECTS | DESKTOP_ENUMERATE */);
        if (d == IntPtr.Zero) return false;
        bool found = false;
        EnumDesktopWindows(d, delegate(IntPtr h, IntPtr l) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid)) { found = true; return false; }
            return true;
        }, IntPtr.Zero);
        CloseDesktop(d);
        return found;
    }

    /** Past the right edge of every monitor, so it is on none of them. */
    public static string Hide(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return null;
        int right = GetSystemMetrics(76) + GetSystemMetrics(78); // SM_XVIRTUALSCREEN + SM_CXVIRTUALSCREEN
        int top = GetSystemMetrics(77); // SM_YVIRTUALSCREEN
        if (r.Left >= right) return null; // already off-screen
        bool hadFocus = GetForegroundWindow() == h;
        SetWindowPos(h, IntPtr.Zero, right + 200, top + 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        // The app took focus when it opened: hand it back to the window under it, which
        // is what the user was using. Keys must never go to a window they cannot see.
        if (hadFocus) {
            for (IntPtr w = GetWindow(h, 2 /* GW_HWNDNEXT */); w != IntPtr.Zero; w = GetWindow(w, 2)) {
                RECT wr;
                if (IsWindowVisible(w) && GetWindowRect(w, out wr) && wr.Right - wr.Left > 120 && wr.Bottom - wr.Top > 120) {
                    SetForegroundWindow(w);
                    break;
                }
            }
        }
        return h.ToInt64() + "\t" + r.Left + "\t" + r.Top;
    }

    public static bool Restore(IntPtr h, int x, int y) {
        if (!IsWindow(h)) return false;
        return SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}
"@
[MwHide]::Dpi() | Out-Null

if ($Mode -eq "restore") {
    foreach ($w in ($Windows -split ",")) {
        $p = $w -split ":"
        if ($p.Count -eq 3) { [void][MwHide]::Restore([IntPtr][Int64]$p[0], [int]$p[1], [int]$p[2]) }
    }
    Write-Output "OK"
    exit 0
}

# Which process to start from: the one listening on the port, or the window's own.
$start = 0
if ($Port -gt 0) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $start = [int]$c.OwningProcess }
} elseif ($Handle) {
    [uint32]$wp = 0
    [void][MwHide]::GetWindowThreadProcessId([IntPtr][Int64]$Handle, [ref]$wp)
    $start = [int]$wp
}
if ($start -eq 0) { Write-Output "NONE"; exit 0 }

# Up the family tree from there. It is ours only if the walk reaches this process; every
# process passed on the way (the app, the host of a web view) may own the window.
$parent = @{}
foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }
$chain = New-Object 'System.Collections.Generic.HashSet[uint32]'
$seen = @{}
$ours = $false
$p = $start
while ($p -gt 0 -and -not $seen.ContainsKey($p)) {
    if ($p -eq $Owner) { $ours = $true; break }
    $seen[$p] = $true
    [void]$chain.Add([uint32]$p)
    $p = $parent[$p]
}
if (-not $ours) { Write-Output "NOTOURS"; exit 0 }
# Children of the start too: an Electron main process owns its windows, but a host
# that launched the web view may have a sibling that does.
foreach ($k in $parent.Keys) { if ($parent[$k] -eq $start) { [void]$chain.Add([uint32]$k) } }

# "check" only says where the app is, for an app the user asked to see.
if ($Mode -ne "check") {
    foreach ($h in [MwHide]::WindowsOf($chain)) {
        $moved = [MwHide]::Hide($h)
        if ($moved) { Write-Output ("MOVED" + [char]9 + $moved) }
    }
}
# Started for testing on the hidden desktop: nothing to move, and it is never on screen.
if ([MwHide]::OnDesktop($Hidden, $chain)) { Write-Output "HIDDEN" }
exit 0
`;

let scriptPath: string | null = null;

async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const dir = await mkdtemp(join(tmpdir(), "mindweave-hide-"));
  const path = join(dir, "hide.ps1");
  await writeFile(path, SCRIPT, "utf8");
  scriptPath = path;
  return path;
}

async function run(args: string[]): Promise<string> {
  const script = await ensureScript();
  return await new Promise<string>((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

/** Parse the script's MOVED lines. Pure. */
export function parseMoved(stdout: string): MovedWindow[] {
  const out: MovedWindow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split("\t");
    if (f[0] !== "MOVED" || f.length < 4) continue;
    const x = Number(f[2]);
    const y = Number(f[3]);
    if (/^\d+$/.test(f[1]!) && Number.isFinite(x) && Number.isFinite(y)) out.push({ handle: f[1]!, x, y });
  }
  return out;
}

/**
 * Move the windows of the app behind `target` off-screen, if this process started it.
 * With `move` false nothing is moved, and it only reports whether the app is on the
 * hidden desktop. Never throws: an app that cannot be hidden is simply left where it is.
 */
export async function hideAppWindows(target: { port: number } | { handle: string }, move = true): Promise<HideResult> {
  if (process.platform !== "win32") return hideByProtocol(target, move);
  // A window listed from the hidden desktop is already where nobody sees it.
  if ("handle" in target && target.handle.startsWith(HIDDEN_MARK)) return { moved: [], hiddenDesktop: true };
  try {
    const mode = move ? "hide" : "check";
    const args = "port" in target ? ["-Mode", mode, "-Port", String(target.port)] : ["-Mode", mode, "-Handle", target.handle];
    const out = await run([...args, "-Owner", String(process.pid), "-Hidden", hiddenDesktopName()]);
    return { moved: parseMoved(out), hiddenDesktop: /^HIDDEN\s*$/m.test(out) };
  } catch {
    return { moved: [], hiddenDesktop: false };
  }
}

/** Put moved windows back where they were. */
export async function restoreAppWindows(windows: MovedWindow[]): Promise<void> {
  const viaProtocol = windows.filter((w) => w.handle.startsWith(PROTOCOL_MARK));
  for (const w of viaProtocol) await restoreByProtocol(w).catch(() => {});
  windows = windows.filter((w) => !w.handle.startsWith(PROTOCOL_MARK));
  if (process.platform !== "win32" || windows.length === 0) return;
  await run(["-Mode", "restore", "-Windows", windows.map((w) => `${w.handle}:${w.x}:${w.y}`).join(",")]).catch(() => {});
}

// ── Linux and macOS: through the app's own debugging port ───────────────────────────────
//
// Neither has a hidden desktop. On Linux an app started for testing normally runs on a
// virtual display (hiddenDesktop.ts), and then there is nothing to move. Otherwise the
// window is asked, over the same debugging port the page route uses, to go somewhere no
// monitor reaches, and to come back when the test ends. Moved, not minimised, for the same
// reason as on Windows: a minimised window stops drawing.
//
// Only an app this process started is touched: the program listening on the port must
// descend from this process. A window the user opened is never moved.

/** Marks a handle that was moved through the protocol, not through the window system. */
const PROTOCOL_MARK = "cdp:";

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out));
    } catch {
      resolve("");
    }
  });
}

/** The process listening on a local port, or null when it cannot be told. */
async function listenerPid(port: number): Promise<number | null> {
  const lsof = (await sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split(/\s+/).find(Boolean);
  if (lsof && /^\d+$/.test(lsof)) return Number(lsof);
  const ss = /pid=(\d+)/.exec(await sh("ss", ["-ltnpH", `sport = :${port}`]));
  return ss ? Number(ss[1]) : null;
}

/** Whether `pid` descends from this process, and whether it was started on a virtual display on the way. */
async function lineage(pid: number): Promise<{ ours: boolean; virtual: boolean }> {
  let at = pid;
  let virtual = false;
  for (let i = 0; i < 40 && at > 1; i++) {
    if (at === process.pid) return { ours: true, virtual };
    if (/xvfb-run|Xvfb/.test(await sh("ps", ["-o", "args=", "-p", String(at)]))) virtual = true;
    const parent = Number((await sh("ps", ["-o", "ppid=", "-p", String(at)])).trim());
    if (!Number.isInteger(parent) || parent <= 0 || parent === at) return { ours: false, virtual };
    at = parent;
  }
  return { ours: false, virtual };
}

/** The display a Linux process draws on, from its environment; null when unreadable or unset. */
function displayOf(pid: number): string | null {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return env.find((e) => e.startsWith("DISPLAY="))?.slice("DISPLAY=".length) || null;
  } catch {
    return null;
  }
}

async function hideByProtocol(target: { port: number } | { handle: string }, move: boolean): Promise<HideResult> {
  const none: HideResult = { moved: [], hiddenDesktop: false };
  if (!("port" in target)) return none;
  try {
    const pid = await listenerPid(target.port);
    if (!pid) return none;
    const from = await lineage(pid);
    if (!from.ours) return none;
    // Started on a virtual display: already where nobody sees it.
    if (from.virtual) return { moved: [], hiddenDesktop: true };
    if (process.platform === "linux" && existsSync("/proc")) {
      const theirs = displayOf(pid);
      if (theirs !== null && theirs !== (process.env.DISPLAY ?? "")) return { moved: [], hiddenDesktop: true };
    }
    if (!move) return none;
    const page = pageTargets(await listTargets(target.port))[0];
    if (!page?.webSocketDebuggerUrl) return none;
    const conn = await CdpConnection.open(page.webSocketDebuggerUrl);
    try {
      const w = (await conn.send("Browser.getWindowForTarget", { targetId: page.id })) as { windowId?: number; bounds?: { left?: number; top?: number } };
      if (typeof w.windowId !== "number") return none;
      const was = { x: Math.round(w.bounds?.left ?? 0), y: Math.round(w.bounds?.top ?? 0) };
      await conn.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "normal" } });
      await conn.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { left: -30000, top: -30000 } });
      // Some window systems refuse to put a window out of reach: then it was not hidden, and is not claimed to be.
      const now = (await conn.send("Browser.getWindowForTarget", { targetId: page.id })) as { bounds?: { left?: number } };
      if ((now.bounds?.left ?? 0) > -10000) {
        await conn.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { left: was.x, top: was.y } });
        return none;
      }
      return { moved: [{ handle: `${PROTOCOL_MARK}${target.port}:${w.windowId}`, ...was }], hiddenDesktop: false };
    } finally {
      conn.close();
    }
  } catch {
    return none;
  }
}

async function restoreByProtocol(w: MovedWindow): Promise<void> {
  const [, port, id] = w.handle.split(":");
  const page = pageTargets(await listTargets(Number(port)))[0];
  if (!page?.webSocketDebuggerUrl) return;
  const conn = await CdpConnection.open(page.webSocketDebuggerUrl);
  try {
    await conn.send("Browser.setWindowBounds", { windowId: Number(id), bounds: { left: w.x, top: w.y } });
  } finally {
    conn.close();
  }
}
