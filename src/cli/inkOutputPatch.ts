/**
 * inkOutputPatch.ts — a faster `Output` for Ink, applied to the stock one only when it is
 * exactly the one this was written against.
 *
 * ## What was slow
 *
 * Every frame, Ink turns its layout tree into text in `ink/build/output.js`. That class is built
 * fresh for each frame, so its caches (widths, tokenised lines) lived for one frame and were
 * thrown away, and it then painted EVERY cell of the screen as an object, built each row's string
 * from those cells, and let the garbage collector clean up ten thousand objects. On a 200x50
 * window with a long transcript, profiled in a real terminal, that was about 60% of all the CPU
 * the app used while scrolling, and the garbage collector alone took more than the whole of our
 * own code. Scrolling reached about 80 frames a second.
 *
 * ## What this does instead
 *
 * Rows do not influence one another: a row is a pure function of the lines written into it, in
 * order. So the patched `get()` collects what each row was written, and looks the row up by that
 * list in a cache that survives between frames. A row that has been drawn before (which is nearly
 * every row of a scroll, since the same lines just move) costs one lookup instead of a paint, and
 * the cells are only built for rows never seen. The width, tokenising and slicing caches also
 * outlive the frame. Measured in the same terminal: scroll at 100 frames a second, with 3.6x less
 * CPU and the garbage collector's share down from 2s to 0.2s.
 *
 * ## Why it is applied this way, and why it can be trusted
 *
 * It is a replacement for the text of one internal module, installed by a loader hook (see
 * inkSpeedLoader.ts) at load time, and only when the stock file's hash is one of
 * `KNOWN_ORIGINALS`. A different Ink changes nothing: the stock renderer runs, a little slower.
 * `inkOutputPatch.test.ts` renders random write sequences through both the stock class and this
 * one and requires byte-identical output, so a new Ink version is caught there rather than on
 * a screen.
 *
 * Set `MINDWEAVE_NO_INK_PATCH=1` to run the stock renderer.
 */
import { createHash } from "node:crypto";

/** SHA-256 of the `ink/build/output.js` this replaces (Ink 7.1.1). */
export const KNOWN_ORIGINALS: readonly string[] = ["54d62805875cc0644787f19038ac6adbd3a01aca367c048ec94f8822485fd2cf"];

/** The replacement module text. Plain JavaScript, resolved from Ink's own folder, so its imports find the same packages the stock file does. */
export const PATCHED_OUTPUT: string = String.raw`import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import { styledCharsFromTokens, styledCharsToString, tokenize, } from '@alcalzone/ansi-tokenize';
// MINDWEAVE-PATCHED: caches live across frames, and each finished row is remembered by what was
// written into it, so a frame that only moves or repeats rows reuses their strings.
const CAP = 6000;
function remember(map, key, value) {
    if (map.size >= CAP) {
        map.clear();
    }
    map.set(key, value);
    return value;
}
class OutputCaches {
    widths = new Map();
    blockWidths = new Map();
    styledChars = new Map();
    slices = new Map();
    getStyledChars(line) {
        let cached = this.styledChars.get(line);
        if (cached === undefined) {
            cached = remember(this.styledChars, line, styledCharsFromTokens(tokenize(line)));
        }
        return cached;
    }
    getStringWidth(text) {
        let cached = this.widths.get(text);
        if (cached === undefined) {
            cached = remember(this.widths, text, stringWidth(text));
        }
        return cached;
    }
    getWidestLine(text) {
        let cached = this.blockWidths.get(text);
        if (cached === undefined) {
            let lineWidth = 0;
            for (const line of text.split('\n')) {
                lineWidth = Math.max(lineWidth, this.getStringWidth(line));
            }
            cached = remember(this.blockWidths, text, lineWidth);
        }
        return cached;
    }
    getSlice(line, from, to) {
        const key = from + '\u0001' + to + '\u0001' + line;
        let cached = this.slices.get(key);
        if (cached === undefined) {
            cached = remember(this.slices, key, sliceAnsi(line, from, to));
        }
        return cached;
    }
}
const SHARED_CACHES = new OutputCaches();
const ROWS = new Map();
export default class Output {
    width;
    height;
    operations = [];
    caches = SHARED_CACHES;
    constructor(options) {
        const { width, height } = options;
        this.width = width;
        this.height = height;
    }
    write(x, y, text, options) {
        const { transformers } = options;
        if (!text) {
            return;
        }
        this.operations.push({
            type: 'write',
            x,
            y,
            text,
            transformers,
        });
    }
    clip(clip) {
        this.operations.push({
            type: 'clip',
            clip,
        });
    }
    unclip() {
        this.operations.push({
            type: 'unclip',
        });
    }
    // One finished row from what was written into it: [x, line, x, line, ...] in write order.
    paintRow(records) {
        const width = this.width;
        const spaceCell = {
            type: 'char',
            value: ' ',
            fullWidth: false,
            styles: [],
        };
        const currentLine = new Array(width);
        for (let x = 0; x < width; x++) {
            currentLine[x] = spaceCell;
        }
        for (let r = 0; r < records.length; r += 2) {
            const x = records[r];
            const line = records[r + 1];
            const characters = this.caches.getStyledChars(line);
            let offsetX = x;
            // Nothing to write (e.g. line was clipped away).
            if (characters.length === 0) {
                continue;
            }
            // Wide characters (e.g. CJK) occupy two cells: a leading
            // cell with the character and a trailing placeholder with
            // value ''. When an overlapping write lands in the middle
            // of a wide character, the boundary cells need cleanup so
            // the terminal never renders a half-visible wide character.
            if (currentLine[offsetX]?.value === '' &&
                offsetX > 0 &&
                this.caches.getStringWidth(currentLine[offsetX - 1]?.value ?? '') >
                    1) {
                currentLine[offsetX - 1] = spaceCell;
            }
            for (const character of characters) {
                currentLine[offsetX] = character;
                // Determine printed width using string-width to align with measurement
                const characterWidth = Math.max(1, this.caches.getStringWidth(character.value));
                // For multi-column characters, clear following cells to avoid stray spaces/artifacts
                if (characterWidth > 1) {
                    for (let index = 1; index < characterWidth; index++) {
                        currentLine[offsetX + index] = {
                            type: 'char',
                            value: '',
                            fullWidth: false,
                            styles: character.styles,
                        };
                    }
                }
                offsetX += characterWidth;
            }
            if (currentLine[offsetX]?.value === '') {
                currentLine[offsetX] = spaceCell;
            }
        }
        // See https://github.com/vadimdemedes/ink/pull/564#issuecomment-1637022742
        const lineWithoutEmptyItems = currentLine.filter(item => item !== undefined);
        return styledCharsToString(lineWithoutEmptyItems).trimEnd();
    }
    get() {
        // Every row's writes, in order. Rows do not influence one another, so a row is a pure
        // function of its own list.
        const rows = new Array(this.height);
        const clips = [];
        for (const operation of this.operations) {
            if (operation.type === 'clip') {
                clips.push(operation.clip);
            }
            if (operation.type === 'unclip') {
                clips.pop();
            }
            if (operation.type === 'write') {
                const { text, transformers } = operation;
                let { x, y } = operation;
                let lines = text.split('\n');
                const clip = clips.at(-1);
                if (clip) {
                    const clipHorizontally = typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number';
                    const clipVertically = typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number';
                    // If text is positioned outside of clipping area altogether,
                    // skip to the next operation to avoid unnecessary calculations
                    if (clipHorizontally) {
                        const width = this.caches.getWidestLine(text);
                        if (x + width < clip.x1 || x > clip.x2) {
                            continue;
                        }
                    }
                    if (clipVertically) {
                        const height = lines.length;
                        if (y + height < clip.y1 || y > clip.y2) {
                            continue;
                        }
                    }
                    if (clipHorizontally) {
                        lines = lines.map(line => {
                            const from = x < clip.x1 ? clip.x1 - x : 0;
                            const width = this.caches.getStringWidth(line);
                            const to = x + width > clip.x2 ? clip.x2 - x : width;
                            return this.caches.getSlice(line, from, to);
                        });
                        if (x < clip.x1) {
                            x = clip.x1;
                        }
                    }
                    if (clipVertically) {
                        const from = y < clip.y1 ? clip.y1 - y : 0;
                        const height = lines.length;
                        const to = y + height > clip.y2 ? clip.y2 - y : height;
                        lines = lines.slice(from, to);
                        if (y < clip.y1) {
                            y = clip.y1;
                        }
                    }
                }
                let offsetY = 0;
                for (let [index, line] of lines.entries()) {
                    const row = y + offsetY;
                    // Line can be missing if the text is taller than height of pre-initialized rows
                    if (row < 0 || row >= this.height) {
                        continue;
                    }
                    for (const transformer of transformers) {
                        line = transformer(line, index);
                    }
                    (rows[row] ??= []).push(x, line);
                    offsetY++;
                }
            }
        }
        const out = new Array(this.height);
        const w = this.width;
        for (let y = 0; y < this.height; y++) {
            const records = rows[y];
            if (records === undefined) {
                out[y] = '';
                continue;
            }
            const key = w + '\u0002' + records.join('\u0001');
            let line = ROWS.get(key);
            if (line === undefined) {
                line = remember(ROWS, key, this.paintRow(records));
            }
            out[y] = line;
        }
        return {
            output: out.join('\n'),
            height: out.length,
        };
    }
}
`;

/** The patched text when `source` is a stock file this knows how to replace, else null. */
export function patchInkOutput(source: string): string | null {
  if (process.env["MINDWEAVE_NO_INK_PATCH"] === "1") return null;
  const hash = createHash("sha256").update(source).digest("hex");
  return KNOWN_ORIGINALS.includes(hash) ? PATCHED_OUTPUT : null;
}
