/**
 * browser.ts — the headless browser `ui` opens web pages in.
 *
 * Headless, so there is never a window: nothing appears on the user's screen, nothing
 * takes focus, and it works the same on a machine nobody is looking at. It uses a browser
 * already installed (Edge ships with Windows; Chrome or Chromium elsewhere) rather than
 * downloading one, and a fresh throwaway profile, so it carries none of the user's
 * logins, cookies or extensions into what the agent does.
 *
 * `MINDWEAVE_BROWSER` points at a specific executable when the usual places are wrong.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { CdpConnection } from "./cdp.js";
import { childEnv } from "./childEnv.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Where Chromium-family browsers live, per platform, most likely first. Pure. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (env.MINDWEAVE_BROWSER) return [env.MINDWEAVE_BROWSER];
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter((r): r is string => !!r);
    const rel = [
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Google\\Chrome\\Application\\chrome.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return rel.flatMap((r) => roots.map((root) => `${root}\\${r}`));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => join(d, n)));
}

/** The first browser that exists, or null. */
export function findBrowser(): string | null {
  return browserCandidates(process.platform, process.env).find((p) => existsSync(p)) ?? null;
}

/** The port a started browser chose, from the file it writes (pure over its text). */
export function parseActivePort(text: string): number | null {
  const port = Number(text.split(/\r?\n/)[0]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** A running headless browser. */
export interface Browser {
  port: number;
  close(): Promise<void>;
}

const running = new Set<ChildProcess>();
let exitHooked = false;

/** A browser outliving Mindweave would be an invisible process nobody knows to stop. */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const child of running) killTree(child);
  });
}

/** Start a headless browser on a free port with a throwaway profile. */
export async function launchBrowser(width = 1280, height = 800): Promise<Browser> {
  const exe = findBrowser();
  if (!exe) {
    throw new Error(
      "no Chrome, Edge or Chromium was found to open pages in. Install one, or set MINDWEAVE_BROWSER to its executable.",
    );
  }
  const profile = await mkdtemp(join(tmpdir(), "mindweave-browser-"));
  const child = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true, env: childEnv() },
  );
  running.add(child);
  hookExit();
  let exited = false;
  child.on("exit", () => {
    exited = true;
    running.delete(child);
  });

  // The browser writes the port it picked into the profile once it is listening.
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  let port: number | null = null;
  while (Date.now() < deadline && !exited) {
    if (existsSync(file)) {
      try {
        port = parseActivePort(readFileSync(file, "utf8"));
      } catch {
        // Half-written; read again.
      }
      if (port) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const close = async () => {
    // Asked first: a browser told to close takes its helper processes (GPU, network,
    // crash reporter) down with it. Killing only the main process orphans them.
    if (port && !exited) await askToClose(port);
    for (let i = 0; i < 30 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    if (!exited) killTree(child);
    running.delete(child);
    // The profile is locked until the browser has really exited.
    for (let i = 0; i < 20 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  if (!port) {
    await close();
    throw new Error(exited ? `the browser at ${exe} quit on start` : `the browser at ${exe} did not start in time`);
  }
  return { port, close };
}

/** Ask the browser to shut down through its own protocol. Never throws. */
async function askToClose(port: number): Promise<void> {
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/json/version", timeout: 2000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve(String((JSON.parse(body) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? ""));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
    if (!wsUrl) return;
    const conn = await CdpConnection.open(wsUrl, 2000);
    await conn.send("Browser.close", {}, 2000).catch(() => {});
    conn.close();
  } catch {
    // Not answering: the forced stop below handles it.
  }
}

/** Stop a process and everything it started. Synchronous so it also works in an exit hook. */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}
