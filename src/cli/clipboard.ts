/**
 * clipboard.ts — put selected text on the system clipboard.
 *
 * Two routes, because neither alone covers where a terminal runs.
 *
 * OSC 52 asks the TERMINAL to set the clipboard. It is one escape sequence on the stream
 * already open, it needs no child process, and it is the only thing that works over SSH,
 * where the machine running this has no clipboard of its own. Terminals may refuse it,
 * and there is no reply to say whether they did.
 *
 * So a local helper runs as well when there is one. Writing the same text twice is
 * harmless: both routes set the same clipboard to the same string, and whichever the
 * terminal honours, the result is what the user selected.
 *
 * Which helper depends on the machine, and getting it wrong is silent (nothing is copied and nothing says so):
 *   - Windows: `clip`. macOS: `pbcopy`.
 *   - Linux has three in the wild: `wl-copy` under Wayland, `xclip` or `xsel` under X11. Only the first was ever tried, so a
 *     plain X11 desktop got nothing from this route.
 *   - Over SSH none of them is right: they would fill the clipboard of the machine the session runs ON, which nobody is sitting
 *     at. Only OSC 52 reaches the person's own clipboard there.
 *   - Inside tmux the sequence has to be wrapped to get past it, and tmux's own paste buffer is loaded too, so a copy can be
 *     pasted with prefix + ] even when the outer terminal ignores OSC 52.
 */
import { spawn } from "node:child_process";

/** Above this, skip OSC 52. Terminals cap what they accept and a truncated paste is
 *  worse than one route quietly not firing; the local helper has no such limit. */
const OSC52_MAX_BYTES = 100_000;

export interface Helper {
  command: string;
  args: string[];
}

/**
 * The local commands that could own the clipboard on this machine, best first (pure). The first that exists is used; a
 * missing one is skipped, so several are listed where machines differ. Empty over SSH, where there is no right answer.
 */
export function helpers(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Helper[] {
  if (env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"]) return [];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  const list: Helper[] = [];
  if (env["WAYLAND_DISPLAY"]) list.push({ command: "wl-copy", args: [] });
  // X11 helpers are tried even without $DISPLAY being set in this process (a session started from a minimal environment).
  list.push({ command: "xclip", args: ["-selection", "clipboard"] }, { command: "xsel", args: ["--clipboard", "--input"] });
  if (!env["WAYLAND_DISPLAY"]) list.push({ command: "wl-copy", args: [] });
  return list;
}

/**
 * The escape sequence that hands `text` to the terminal.
 *
 * Exported for tests: the encoding is the part that can be wrong, and it is not
 * observable from the outside once written to a stream.
 *
 * Inside tmux (or GNU screen) a bare sequence is swallowed by the multiplexer, so it is wrapped in a DCS passthrough, which
 * hands it to the terminal outside. tmux only honours that when `allow-passthrough` is on, and drops it silently when it is not,
 * which is no worse than not sending it.
 */
export function osc52(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const seq = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  if (env["TMUX"]) return `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  if (env["STY"]) return `\x1bP${seq}\x1b\\`;
  return seq;
}

/** Run `helper`, feeding it `text`. Resolves true when it started and took the text, false when it is not installed. */
function feed(helper: Helper, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(helper.command, helper.args, { stdio: ["pipe", "ignore", "ignore"] });
      // A missing helper surfaces as an error event, not a throw, and means nothing more
      // than "this machine did not have that one".
      child.on("error", () => resolve(false));
      child.on("spawn", () => resolve(true));
      child.stdin.on("error", () => {});
      child.stdin.end(text, "utf8");
    } catch {
      // Spawning can fail outright on a locked-down system. OSC 52 may still have worked.
      resolve(false);
    }
  });
}

/**
 * Copy `text`. Never throws and never rejects: a clipboard that does not take is a
 * disappointment, not an error worth interrupting the session for.
 */
export function copyToClipboard(text: string, out: NodeJS.WriteStream = process.stdout): void {
  if (text === "") return;

  if (Buffer.byteLength(text, "utf8") <= OSC52_MAX_BYTES) {
    try {
      out.write(osc52(text));
    } catch {
      // A closed or non-writable stream is not worth reporting here.
    }
  }

  void (async () => {
    // Inside tmux, its own buffer as well: `-w` (tmux 3.2+) also passes it to the outer terminal's clipboard.
    if (process.env["TMUX"]) await feed({ command: "tmux", args: ["load-buffer", "-w", "-"] }, text);
    // The first local helper this machine has.
    for (const helper of helpers()) if (await feed(helper, text)) return;
  })();
}
