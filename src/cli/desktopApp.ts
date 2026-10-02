/**
 * desktopApp.ts — the pointer from the terminal to the desktop app.
 *
 * The line shown when a session starts, the text of the /app screen, and the one thing that screen
 * does: open the download page in the user's own browser. The browser is the right place for it, because
 * that page says which file to take and what each system will ask before it opens the app, and a
 * terminal cannot download an installer for them.
 */
import { spawn } from "node:child_process";

/** The home page, where the download buttons are. */
export const APP_PAGE_URL = "https://mindweavedev.netlify.app/";

/** The one line shown at the start of every session. */
export function appAnnouncement(): string {
  return "The Mindweave desktop app is out for Windows, macOS and Linux. Run /app to get it. It is free and open source.";
}

/** What the /app screen says above its single choice. */
export const APP_EXPLANATION =
  "The desktop app is out for Windows, macOS and Linux. It is free and open source, and it includes " +
  "this command line, so one download gives you both. Enter opens the download page in your browser.";

type Spawn = typeof spawn;

/** The command that opens a link in the default browser, for each system. */
export function browserCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Open a link in the default browser. Never throws: a machine with no browser (a server over SSH)
 * gets `false` and the caller prints the address instead. Only https links are ever opened.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, spawnFn: Spawn = spawn): boolean {
  if (!/^https:\/\//.test(url)) return false;
  try {
    const { cmd, args } = browserCommand(platform, url);
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
