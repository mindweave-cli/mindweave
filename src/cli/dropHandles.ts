/**
 * dropHandles.ts — short names for files dropped into the input.
 *
 * A terminal delivers a dragged file as its full path, so dropping one screenshot puts
 * something like `"C:\Users\me\Pictures\Screenshots\Screenshot 2026-09-06 091037.png"`
 * into the middle of the line you are writing. It wraps, it buries the sentence around
 * it, and editing near it means stepping over sixty characters you did not type.
 *
 * So the path is swapped for a handle the moment it lands: `[mwimg1]`, `[mwfile2]`. The
 * handle is what you see and edit; the real path is kept here and handed back at send
 * time, so nothing downstream has to know this happened.
 *
 * The same trade already exists for large pastes, which collapse to a `[Pasted text #1]`
 * chip and expand on send. This is that idea applied to the other thing that arrives in
 * the buffer at a size nobody wants to look at.
 */
import { isImage } from "../memory/images.js";
import { findDroppedPaths } from "./attachments.js";

export interface DropHandles {
  /**
   * Replace every dropped path in `text` with a handle, registering each one. Text with
   * no path in it comes back untouched, which is the common case for a keystroke.
   */
  register(text: string): string;
  /** The handle this absolute path was registered under, if it was. */
  labelFor(absPath: string): string | undefined;
  /** The path behind a handle. Exposed for expansion and for tests. */
  pathFor(handle: string): string | undefined;
}

/**
 * `resolveAbs` turns the path as it appeared in the text into the absolute form the rest
 * of the app uses, and is injected rather than imported so this module stays independent
 * of any particular session's working directory.
 */
export function createDropHandles(resolveAbs: (path: string) => string): DropHandles {
  const byHandle = new Map<string, string>();
  const byPath = new Map<string, string>();
  const counts = { img: 0, file: 0 };

  return {
    register(text: string): string {
      const found = findDroppedPaths(text);
      if (found.length === 0) return text;

      // Two passes, because the two directions disagree. Numbering has to run LEFT to
      // right or the second file dropped is called mwfile1, while splicing has to run
      // right to left or an earlier replacement shifts every span after it.
      const assigned = found.map((drop) => {
        const abs = resolveAbs(drop.path);
        let handle = byPath.get(abs);
        if (!handle) {
          // Numbered per kind, so the images stay countable at a glance rather than
          // sharing one sequence with every text file in the conversation.
          handle = isImage(abs) ? `mwimg${++counts.img}` : `mwfile${++counts.file}`;
          byPath.set(abs, handle);
          byHandle.set(handle, abs);
        }
        return { ...drop, handle };
      });

      let out = text;
      // Right to left, so a replacement never shifts the spans before it.
      for (let i = assigned.length - 1; i >= 0; i--) {
        const drop = assigned[i]!;
        // Two files dropped together arrive with nothing between them. Their handles must not run together ("mwimg1mwimg2"): one
        // word is not two handles, and the images behind it were never attached.
        const touchesNext = i + 1 < assigned.length && assigned[i + 1]!.start === drop.end;
        out = out.slice(0, drop.start) + `[${drop.handle}]` + (touchesNext ? " " : "") + out.slice(drop.end);
      }
      return out;
    },

    labelFor(absPath: string): string | undefined {
      return byPath.get(absPath);
    },

    pathFor(handle: string): string | undefined {
      return byHandle.get(handle);
    },
  };
}

// A handle as it appears in text: shown in square brackets ("[mwimg1]"), so two dropped side by side read as two. Bare ("mwimg1") is
// still understood, for one that was typed. Not part of a longer word or number, and another may follow with nothing between.
const HANDLE_RE = /(?<![A-Za-z_])\[?(mw(?:img|file)\d+)\]?(?!\d)/g;

/**
 * Put the real paths back before the text is resolved against the disk.
 *
 * Quoted, because a path with spaces in it has to survive as one token. Every path this
 * expands came from a drop, so it is always absolute and always quotable.
 */
export function expandHandles(text: string, handles: DropHandles): string {
  return text.replace(HANDLE_RE, (shown, handle: string) => {
    const path = handles.pathFor(handle);
    return path ? `"${path}"` : shown;
  });
}
