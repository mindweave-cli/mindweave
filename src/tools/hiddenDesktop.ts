/**
 * hiddenDesktop.ts — start an app the agent is about to test where the user can never see it.
 *
 * Windows gives every session more than one desktop: the one on the screen, and any others
 * a program creates. A window opened on another desktop is never drawn on the screen, not
 * even for one frame, but it is still a real window that draws, runs its page, answers the
 * accessibility layer and can be photographed. So an app started there can be tested fully
 * without ever appearing in front of the user.
 *
 * Moving a window off the screen after it opens (uiHide.ts) cannot promise that. Measured
 * on this project: an Electron window stayed on the screen for 30-50ms before any outside
 * move could land, because it is created, centred and shown in one go, and a plain WinForms
 * window was caught on screen in the composited picture. Only starting the app somewhere
 * else closes that gap, and a separate desktop is the one place Windows offers for it.
 *
 * ## What goes there
 *
 * Only commands that start an app FOR TESTING: the ones carrying the debugging-port flags
 * the `ui` tool tells the agent to add (checked in the command and in the package script
 * it runs), or any command the agent marks `hidden: true`. Nothing else, because a program
 * that keeps a single instance (a browser, an editor) first started there would open the
 * user's own later launches there too, where they cannot see them.
 *
 * A window cannot be moved from one desktop to another, so an app started here is shown to
 * the user by starting it again without `hidden`.
 *
 * ## How
 *
 * Node cannot choose a child's desktop, so a tiny launcher does: it creates the desktop,
 * starts the rest of its command line there with the same output handles, waits, and exits
 * with the command's own code. Everything the command starts inherits the desktop. The
 * launcher is compiled once, on first use, with the C# compiler every Windows 10 and 11
 * install ships with, and kept under the state folder. It stays in the process tree, so the
 * usual tree kill stops the app with it.
 *
 * The scripts that read, photograph or move windows reach this desktop through `DESK_CS`.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../memory/store.js";

/** This process's hidden desktop. One per process, so two sessions never share one. */
export function hiddenDesktopName(): string {
  return `mindweave-${process.pid}`;
}

/** A window on the hidden desktop is named by its handle with this in front, so every
 *  script it is handed back to knows where to look for it. */
export const HIDDEN_MARK = "~";

/** The handle and, for a window on the hidden desktop, the script arguments that reach it. */
export function windowArgs(handle: string): { handle: string; desktop: string[] } {
  return handle.startsWith(HIDDEN_MARK)
    ? { handle: handle.slice(HIDDEN_MARK.length), desktop: ["-Desktop", hiddenDesktopName()] }
    : { handle, desktop: [] };
}

/** The flags the `ui` tool asks for to test an app over its debugging port. */
const TEST_FLAGS = /--remote-debugging-port\b|WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/i;

/** `npm start`, `npm run dev`, `pnpm dev`, `yarn tauri dev`, `bun run x`: the script run. */
const PACKAGE_SCRIPT = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run(?:-script)?\s+)?([\w:.-]+)/gi;

/** Scripts that start other scripts are followed this far. */
const SCRIPT_DEPTH = 3;

/**
 * Whether a command starts an app for testing, so it belongs on the hidden desktop.
 *
 * `explicit` is the agent's own `hidden` argument and wins either way. Otherwise the
 * command is checked for the test flags, and so is any package script it runs, since
 * `npm run dev` hides the flags inside package.json.
 */
export function wantsHiddenDesktop(command: string, cwd: string, explicit?: boolean): boolean {
  // Windows: a hidden desktop. Linux: a virtual display, when Xvfb is installed. macOS has
  // neither; there the window is moved off the screen once it is up (uiHide.ts).
  if (process.platform === "linux") {
    if (!virtualDisplay()) return false;
  } else if (process.platform !== "win32") return false;
  if (explicit !== undefined) return explicit;
  if (TEST_FLAGS.test(command)) return true;
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return false;
  }
  return runsFlaggedScript(command, scripts, SCRIPT_DEPTH);
}

/** Whether `text` runs a package script whose body (or a script it runs) has the flags. Pure. */
export function runsFlaggedScript(text: string, scripts: Record<string, unknown>, depth: number): boolean {
  if (depth <= 0) return false;
  for (const m of text.matchAll(PACKAGE_SCRIPT)) {
    const name = m[1]!;
    // `npm test`, `npm install` and the like are commands of npm, not scripts, unless
    // package.json names one that way; a missing name is simply not followed.
    const body = scripts[name];
    if (typeof body !== "string") continue;
    if (TEST_FLAGS.test(body) || runsFlaggedScript(body, scripts, depth - 1)) return true;
  }
  return false;
}

/** The launcher. Its command line is `<launcher> <desktop> <the command line to start>`,
 *  and the rest after the desktop is passed on exactly as it arrived. */
const LAUNCHER_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

static class MwHiddenLaunch {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr sa);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, w, h, xChars, yChars, fill, flags; public short show, reserved2;
        public IntPtr reserved3, stdIn, stdOut, stdErr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    static int Token(string s, int i) {
        if (i < s.Length && s[i] == '"') { int q = s.IndexOf('"', i + 1); return q < 0 ? s.Length : q + 1; }
        while (i < s.Length && s[i] != ' ' && s[i] != '\t') i++;
        return i;
    }
    static int Space(string s, int i) { while (i < s.Length && (s[i] == ' ' || s[i] == '\t')) i++; return i; }

    static int Main() {
        string line = Environment.CommandLine;
        int i = Space(line, Token(line, 0));
        int end = Token(line, i);
        string desk = line.Substring(i, end - i).Trim('"');
        string rest = line.Substring(Space(line, end));
        if (desk.Length == 0 || rest.Length == 0) { Console.Error.WriteLine("usage: <desktop> <command line>"); return 1; }
        // Creates it, or opens it when an earlier command already did.
        IntPtr d = CreateDesktop(desk, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
        if (d == IntPtr.Zero) { Console.Error.WriteLine("Could not create the hidden desktop (error " + Marshal.GetLastWin32Error() + ")."); return 1; }
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.desktop = desk;
        si.flags = 0x100; // STARTF_USESTDHANDLES: the same output file and input as this process
        si.stdIn = GetStdHandle(-10); si.stdOut = GetStdHandle(-11); si.stdErr = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, new StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi)) {
            Console.Error.WriteLine("Could not start the command on the hidden desktop (error " + Marshal.GetLastWin32Error() + ").");
            return 1;
        }
        WaitForSingleObject(pi.process, 0xFFFFFFFF);
        uint code; GetExitCodeProcess(pi.process, out code);
        return unchecked((int)code);
    }
}
`;

let launcher: Promise<string> | null = null;
let xvfb: string | null | undefined;

/** `xvfb-run` when this Linux has a virtual display server to start apps on, else null. */
export function virtualDisplay(): string | null {
  if (xvfb !== undefined) return xvfb;
  xvfb = null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "xvfb-run"))) {
      xvfb = join(dir, "xvfb-run");
      break;
    }
  }
  return xvfb;
}

/** What goes in front of a command started on a virtual display, then the shell and its arguments. */
export const VIRTUAL_DISPLAY_ARGS = ["-a", "-s", "-screen 0 1280x800x24"];

/** The compiled launcher's path, compiling it the first time. Rejects with why it could
 *  not be built. On Linux the "launcher" is xvfb-run. */
export function launcherPath(): Promise<string> {
  if (process.platform === "linux") {
    const x = virtualDisplay();
    return x ? Promise.resolve(x) : Promise.reject(new Error("xvfb-run is not installed (sudo apt install xvfb)"));
  }
  launcher ??= buildLauncher().catch((error) => {
    launcher = null; // try again next time rather than remembering a passing failure
    throw error;
  });
  return launcher;
}

async function buildLauncher(): Promise<string> {
  const hash = createHash("sha256").update(LAUNCHER_CS).digest("hex").slice(0, 12);
  const dir = join(stateRoot(), "bin");
  const exe = join(dir, `mindweave-hidden-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const csc = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((p) => existsSync(p));
  if (!csc) throw new Error("the C# compiler that ships with Windows (.NET Framework 4) was not found");
  await mkdir(dir, { recursive: true });
  const tag = randomBytes(4).toString("hex");
  const src = join(dir, `mindweave-hidden-${tag}.cs`);
  const tmp = join(dir, `mindweave-hidden-${tag}.exe`);
  await writeFile(src, LAUNCHER_CS, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(csc, ["/nologo", "/target:exe", "/optimize+", `/out:${tmp}`, src], { windowsHide: true });
      let text = "";
      child.stdout.on("data", (d: Buffer) => (text += d.toString()));
      child.stderr.on("data", (d: Buffer) => (text += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`compiling the launcher failed: ${text.trim() || `exit ${code}`}`))));
    });
    // Renamed into place, so a second process compiling at the same moment never runs a
    // half-written file; whichever lands last wins, and both are the same program.
    await rename(tmp, exe).catch(async (error) => {
      if (!existsSync(exe)) throw error;
    });
    return exe;
  } finally {
    await rm(src, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * C# for the window scripts: run a piece of work on the hidden desktop. A thread can only
 * list, read or draw the windows of the desktop it is on, and a thread that already owns
 * a window cannot move, so the work runs on a fresh thread placed there. An empty name runs
 * it where it is, unchanged.
 */
export const DESK_CS = String.raw`
public static class MwDesk {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr d);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);

    public static bool Exists(string desk) {
        if (string.IsNullOrEmpty(desk)) return false;
        IntPtr d = OpenDesktop(desk, 0, false, 0x0040 /* DESKTOP_ENUMERATE */);
        if (d == IntPtr.Zero) return false;
        CloseDesktop(d);
        return true;
    }

    public static string On(string desk, Func<string> work) {
        if (string.IsNullOrEmpty(desk)) return work();
        string result = null;
        Exception failed = null;
        var t = new System.Threading.Thread(() => {
            try {
                IntPtr d = OpenDesktop(desk, 0, false, 0x10000000);
                if (d == IntPtr.Zero || !SetThreadDesktop(d)) { result = "ERR the hidden desktop is gone: the app on it has closed"; return; }
                result = work();
            } catch (Exception e) { failed = e; }
        });
        t.SetApartmentState(System.Threading.ApartmentState.MTA);
        t.Start();
        t.Join();
        if (failed != null) throw failed;
        return result;
    }
}
`;
