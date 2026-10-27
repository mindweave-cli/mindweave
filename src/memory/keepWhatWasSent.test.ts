/**
 * keepWhatWasSent.test.ts — trimming old context for the model never costs the person anything they sent.
 *
 * Trimming shortens what the MODEL reads: an old attached file's body becomes a stub, an image's payload is dropped. It used to
 * do that to the saved message itself, so the picture reference and the file body were gone from the session for good, and
 * the model's note about it (a line about "no longer in context") was printed in the chat as if the person had typed it.
 * The saved message keeps exactly what was sent; the model's copy is derived from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_CLEARED_STUB, microcompact, userAsSent } from "./compaction.js";
import { replayHistory } from "../core/turnRunner.js";
import type { Entry, Session } from "./types.js";

type User = Extract<Entry, { role: "user" }>;
const user = (content: string): Entry => ({ role: "user", content });
const pic = (path: string) => ({ path, mediaType: "image/png" });
const oldTurns = (): Entry[] => Array.from({ length: 12 }, (_, i) => user(`turn ${i}`));
const session = (transcript: Entry[]): Session => ({ cwd: "C:/p", modelConfig: { model: "deepseek-v4-pro" }, transcript }) as unknown as Session;

const SENT = "look at this\n\n[Image source: C:/shots/a.png]";
const withPicture = (): Entry => ({ role: "user", content: SENT, images: [pic("C:/shots/a.png")] }) as Entry;

test("trimming an old message keeps the words and pictures that were sent", () => {
  const { entries } = microcompact([withPicture(), ...oldTurns()], 8);
  const kept = entries[0] as User;
  assert.match(kept.content, /no longer in context/, "the model's copy was trimmed, so this test is about the right entry");
  assert.equal(kept.images, undefined, "the model no longer gets the picture");
  assert.equal(kept.original?.content, SENT);
  assert.deepEqual(kept.original?.images, [pic("C:/shots/a.png")]);
  assert.deepEqual(userAsSent(kept), { content: SENT, images: [pic("C:/shots/a.png")] });
});

test("an attached file's body stays whole on the saved message while the model's copy shrinks", () => {
  const body = "line of the attached file\n".repeat(400);
  const content = `read this\n\n<attached_file path="C:/p/notes.txt">\n${body}\n</attached_file>`;
  const { entries } = microcompact([{ role: "user", content } as Entry, ...oldTurns()], 8);
  const kept = entries[0] as User;
  assert.match(kept.content, /attachment cleared to save context/);
  assert.equal(kept.original?.content, content, "every line of the file is still in the saved message");
});

test("trimming again never replaces the original with the trimmed copy", () => {
  const once = microcompact([withPicture(), ...oldTurns()], 8).entries;
  const twice = microcompact([...once, ...oldTurns()], 8).entries;
  const kept = twice[0] as User;
  assert.equal(kept.original?.content, SENT);
  assert.deepEqual(kept.original?.images, [pic("C:/shots/a.png")]);
});

test("a message nothing was trimmed from gets no copy of itself", () => {
  const { entries } = microcompact([user("short"), ...oldTurns()], 8);
  assert.equal((entries[0] as User).original, undefined);
});

test("a reopened chat shows the picture that was sent, from the kept original, and never the model's note", () => {
  const trimmed = microcompact([withPicture(), ...oldTurns()], 8).entries;
  const first = replayHistory(session(trimmed)).find((e) => e.type === "userMessage");
  assert.ok(first && first.type === "userMessage");
  assert.deepEqual(first.images, ["C:/shots/a.png"]);
  assert.equal(first.text, "look at this");
  assert.doesNotMatch(first.text, /no longer in context/);
});

test("a message trimmed before originals were kept still shows its picture when the file is on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-pic-"));
  const file = join(dir, "shot.png");
  writeFileSync(file, "x");
  const stripped = { role: "user", content: `look at this\n\n[${file} ${IMAGE_CLEARED_STUB}]` } as Entry;
  const first = replayHistory(session([stripped])).find((e) => e.type === "userMessage");
  assert.ok(first && first.type === "userMessage");
  assert.deepEqual(first.images, [file]);
  assert.equal(first.text, "look at this");
  assert.equal(first.expiredImages, undefined);

  const missing = { role: "user", content: `look\n\n[${join(dir, "gone.png")} ${IMAGE_CLEARED_STUB}]` } as Entry;
  const second = replayHistory(session([missing])).find((e) => e.type === "userMessage");
  assert.ok(second && second.type === "userMessage");
  assert.deepEqual(second.expiredImages, ["gone.png"], "a picture that is gone is named, not silently dropped");
});

test("an instruction the engine writes for a command shows as the command the person typed", () => {
  const instruction = 'The user wants this saved as a standing rule for this project. Rewrite it as a clear, imperative rule. Directive: "always commit to main"';
  const entry = { role: "user", content: instruction, original: { content: "/rules always commit to main" } } as Entry;
  const first = replayHistory(session([entry])).find((e) => e.type === "userMessage");
  assert.ok(first && first.type === "userMessage");
  assert.equal(first.text, "/rules always commit to main");
  assert.doesNotMatch(first.text, /The user wants this saved/);
  // and the model still reads the instruction
  assert.equal(entry.content, instruction);
});

test("the commands that hand the model an instruction pass what was typed", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cli/App.tsx", import.meta.url), "utf8");
  assert.match(src, /async function runDirective\(instruction: string, activity: string, typed\?: string\)/);
  for (const activity of ["saving a rule…", "creating a skill…", "writing MINDWEAVE.md…"]) {
    const at = src.indexOf(`"${activity}"`);
    assert.ok(at > 0, activity);
    assert.match(src.slice(at, at + 80), /^"[^"]+",\s*raw,/, `${activity} passes the typed command`);
  }
});

test("the kept original is never part of what the model is sent or counted as context", async () => {
  const { estimateEntriesTokens } = await import("./compaction.js");
  const plain = estimateEntriesTokens([user("hi")]);
  const huge = { role: "user", content: "hi", original: { content: "x".repeat(50_000) } } as Entry;
  assert.equal(estimateEntriesTokens([huge]), plain);
});
