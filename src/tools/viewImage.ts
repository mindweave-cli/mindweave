/**
 * viewImage.ts — look at an image file on disk.
 *
 * Without this there was no way for the model to see a picture it had not just captured:
 * `read_file` refuses binaries, and `screenshot` can only photograph a window that is
 * already open. So the model did the only thing left to it — opened the file in whatever
 * viewer or browser the OS handed it, screenshotted that window, and left the window
 * open. On a long task that is a new window every time, none of them closed.
 *
 * This opens nothing. The file is read, validated, and handed to the model as an image,
 * with no process started and nothing appearing on the user's screen.
 *
 * The same validation a dropped attachment goes through (`memory/images.ts`), so the caps
 * and the accepted formats are stated in one place rather than per producer. What happens
 * when the running model CANNOT see images is core's decision, made once in the engine
 * from a manifest fact: the image is named instead of sent, and the model is told plainly
 * that it is being told rather than shown. A tool never asks which provider is running.
 */
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { describeImage, isImage, isRejection, IMAGE_EXTS } from "../memory/images.js";
import { guardedPathReason } from "./guard.js";
import { relativize, resolvePath, touch } from "./paths.js";
import { fail } from "./results.js";

export const viewImage: Tool = {
  name: "view_image",
  // Reads a file and changes nothing, so it is safe to run beside other reads.
  readOnly: true,
  description:
    "Look at an image file on disk — a screenshot, a mockup, a diagram, a photo the user " +
    "pointed you at. Pass `path` and the picture is handed to you directly. " +
    "This is the ONLY way to look at an image file: never open one in a viewer or a " +
    "browser to photograph it, and never use `screenshot` for a file that is already on " +
    "disk. `screenshot` is for a window of a RUNNING app; this is for a file. " +
    "PNG, JPEG, GIF and WebP.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Path to the image file, absolute or relative to the working directory.",
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx): Promise<ToolResult> {
    const raw = typeof args["path"] === "string" ? args["path"].trim() : "";
    if (!raw) return fail("view_image needs a `path`.");

    const path = resolvePath(ctx, raw);

    const blocked = await guardedPathReason(path);
    if (blocked) return fail(`Refusing to open ${raw}: it is ${blocked}.`);

    // Checked BEFORE the file is touched, so a wrong extension gets an answer about the
    // format rather than a not-found about a file that is right there.
    if (!isImage(path)) {
      return fail(
        `${raw} is not an image this can open. Readable formats: ${[...IMAGE_EXTS].sort().join(", ")}. ` +
          `For a text file use read_file.`,
      );
    }

    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      return fail(`Image not found: ${raw}`);
    }
    if (stat.isDirectory()) return fail(`${raw} is a directory, not an image.`);

    // Caps, dimension limits and the sendable-format check, shared with attachments.
    const ref = await describeImage(path, stat.size);
    if (isRejection(ref)) return fail(`Cannot open ${raw}: ${ref.reason}`);

    // Records that this path was looked at, the same as a read, so the working set knows
    // the file is in play rather than treating it as never touched.
    touch(ctx, path);

    const shown = relativize(ctx, path);
    const size = ref.width && ref.height ? `${ref.width}x${ref.height}` : "image";
    return {
      output:
        `Opened ${shown} (${size}). The image follows this result — look at it and say ` +
        `what you see.`,
      summary: `viewed ${basename(path)} (${size})`,
      images: [ref],
      // The picture is the slow part, and it happens AFTER this returns.
      awaitsModel: true,
    };
  },
};
