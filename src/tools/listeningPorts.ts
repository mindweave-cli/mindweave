/**
 * listeningPorts.ts — which TCP ports are listening, and which process owns each.
 *
 * Background commands use this to notice when something they started opens a port: a
 * dev server coming up, or an app finishing its build and opening its debugging port.
 * That is the moment an agent waiting on "the app" can carry on, and nothing in a
 * command's own output reliably says it (a Tauri build prints "Running ..." and then the
 * app's own logs, if any).
 *
 * The listing is the operating system's own (netstat on Windows, ss on Linux, lsof on
 * macOS), and the parent map is how a port is traced back to the command that started
 * the process owning it. Everything is best-effort: a missing tool or an odd line means
 * fewer ports seen, never a thrown error.
 */
import { spawn } from "node:child_process";

export interface Listener {
  port: number;
  pid: number;
}

/** `netstat -ano -p TCP` (Windows). Pure. IPv4 and IPv6 rows, LISTENING only. */
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP/i.test(f[0]!) || !/LISTEN/i.test(f[3]!)) continue;
    const port = Number(/:(\d+)$/.exec(f[1]!)?.[1]);
    const pid = Number(f[4]);
    if (port > 0 && pid > 0) out.push({ port, pid });
  }
  return dedupe(out);
}

/** `ss -ltnpH` (Linux). Pure. */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    // State  Recv-Q  Send-Q  Local:Port  Peer:Port  Process
    const local = line.trim().split(/\s+/)[3] ?? "";
    const port = Number(/:(\d+)$/.exec(local)?.[1]);
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (port > 0 && pid > 0) out.push({ port, pid });
    }
  }
  return dedupe(out);
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` (macOS). Pure: `p<pid>` then `n<addr>:<port>` lines. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port > 0 && pid > 0) out.push({ port, pid });
    }
  }
  return dedupe(out);
}

/** `pid ppid` per line (from PowerShell on Windows, `ps -A -o pid=,ppid=` elsewhere). Pure. */
export function parseParents(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/**
 * The first of `roots` that `pid` descends from, walking up the parent map, or null.
 * Pure. Bounded, and safe against the loops a reused process id can make.
 */
export function ownerOf(pid: number, parents: Map<number, number>, roots: Set<number>): number | null {
  const seen = new Set<number>();
  let p: number | undefined = pid;
  for (let i = 0; i < 64 && p && !seen.has(p); i++) {
    if (roots.has(p)) return p;
    seen.add(p);
    p = parents.get(p);
  }
  return null;
}

function dedupe(list: Listener[]): Listener[] {
  const seen = new Set<string>();
  return list.filter((l) => {
    const k = `${l.port}:${l.pid}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function capture(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

/** Every listening TCP port on this machine, with its owning process. */
export async function listListeners(): Promise<Listener[]> {
  if (process.platform === "win32") return parseNetstat(await capture("netstat", ["-ano", "-p", "TCP"]));
  if (process.platform === "darwin") return parseLsof(await capture("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  return parseSs(await capture("ss", ["-ltnpH"]));
}

/** Every process's parent. The one expensive call here, so it is made only when a
 *  listening process appears that has not been traced yet. */
export async function parentMap(): Promise<Map<number, number>> {
  if (process.platform === "win32") {
    return parseParents(
      await capture("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
      ]),
    );
  }
  return parseParents(await capture("ps", ["-A", "-o", "pid=,ppid="]));
}
