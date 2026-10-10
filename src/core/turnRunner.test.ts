/**
 * turnRunner.test.ts — the desktop front door's message preparation.
 *
 * A message typed in the app must reach the model exactly as the same message typed in
 * the CLI would: files through the CLI's own attachment rules, pastes through its own
 * wrapper. And the chat must show it the way it was typed, live and after a reload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInterruptedReply, prepareMessage, recordUserMessage, replayHistory, type TurnEvent } from "./turnRunner.js";
import { loadTranscript } from "../memory/store.js";
import { createSession } from "../memory/session.js";
import type { Session } from "../memory/types.js";

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-prep-")));
  const code = join(root, "login.ts");
  writeFileSync(code, "export function login() {\n  return true;\n}\n");
  const blob = join(root, "data.bin");
  writeFileSync(blob, Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  const session = { cwd: root, modelConfig: { model: "deepseek-v4-pro" }, transcript: [] } as unknown as Session;
  return { root, code, blob, session };
}

test("a file from the + button reaches the model like a dropped file, and the chat shows it as a card", async () => {
  const { code, session } = fixture();
  const events: TurnEvent[] = [];
  const out = await prepareMessage(session, { text: "fix the login", filePaths: [code] }, (e) => events.push(e));
  assert.match(out.content, /^fix the login\nlogin\.ts/);
  assert.match(out.content, /<attached_file path="[^"]*login\.ts">\nexport function login\(\)/);
  assert.doesNotMatch(out.displayText, /attached_file|return true/, "the file body must not show in the chat");
  // The file is its own card beside the text, so the text does not repeat its name.
  assert.deepEqual(out.files, [code]);
  assert.equal(out.displayText, "fix the login");
  assert.equal(events.length, 0, "a file that attached fine is not an error");
});

test("a long paste is wrapped for the model and shown as a chip, before and after a reload", async () => {
  const { session } = fixture();
  const paste = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = await prepareMessage(session, { text: "why does this fail?", pastes: [paste] }, () => {});
  assert.match(out.content, /^why does this fail\?\n\n<pasted_text lines="40">\nline 1\n[\s\S]*line 40\n<\/pasted_text>$/);
  assert.equal(out.displayText, "why does this fail?\n\n[Pasted text +40 lines]");
  // Reopening the session shows the same line, not the 40 lines.
  session.transcript.push({ role: "user", content: out.content, ts: 1 } as Session["transcript"][number]);
  const replay = replayHistory(session);
  assert.deepEqual(replay[0], { type: "userMessage", text: "why does this fail?\n\n[Pasted text +40 lines]" });
});

test("a binary file is skipped and SAID, not silently dropped", async () => {
  const { blob, session } = fixture();
  const events: TurnEvent[] = [];
  const out = await prepareMessage(session, { text: "look", filePaths: [blob] }, (e) => events.push(e));
  assert.doesNotMatch(out.content, /attached_file/);
  assert.equal(events.length, 1);
  assert.match((events[0] as { line: string }).line, /skipped data\.bin \(binary file/);
});

test("a paste with nothing typed is still a message", async () => {
  const { session } = fixture();
  const out = await prepareMessage(session, { text: "", pastes: ["a\nb\nc"] }, () => {});
  assert.equal(out.content, '<pasted_text lines="3">\na\nb\nc\n</pasted_text>');
  assert.equal(out.displayText, "[Pasted text +3 lines]");
});

test("attached images show as pictures, so their bare file names leave the chat text", async () => {
  const { hideAttachedNames } = await import("./turnRunner.js");
  const paths = ["C:\\Users\\me\\Pictures\\Screenshot 2026-09-24 174000.png", "C:/x/Screenshot 2026-09-24 174003.png"];
  assert.equal(
    hideAttachedNames("check these photos out\nScreenshot 2026-09-24 174000.png Screenshot 2026-09-24 174003.png", paths),
    "check these photos out",
  );
  // A name used inside a sentence is part of what was said, not a leftover label.
  assert.equal(hideAttachedNames("compare it with design.png please", ["C:\\a\\design.png"]), "compare it with design.png please");
  // Other attached files keep their names; only the pictures go.
  assert.equal(hideAttachedNames("look\nnotes.md shot.png", ["C:\\a\\shot.png"]), "look\nnotes.md");
  assert.equal(hideAttachedNames("no images here", []), "no images here");
});

test("files sent in full come back as their own cards, live and on reopening", async () => {
  const { attachedFiles, hideAttachedNames } = await import("./turnRunner.js");
  const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
  const content = 'fix this\nmain.ts notes.md\n\n<attached_file path="src/main.ts">\nlet a = 1\n</attached_file>\n\n<attached_file path="notes.md">\nhi\n</attached_file>';
  const files = attachedFiles(content, cwd);
  assert.deepEqual(files.map((f) => f.split(/[\\/]/).slice(-2).join("/")), ["src/main.ts", "proj/notes.md"]);
  assert.equal(hideAttachedNames("fix this\nmain.ts notes.md", files), "fix this");
  assert.deepEqual(attachedFiles("no files here", cwd), []);
});

test("a reopened session replays searches, marked quiet, and still drops other quiet results", () => {
  const session = {
    cwd: "C:/p",
    modelConfig: { model: "deepseek-v4-pro" },
    transcript: [
      { role: "assistant", content: "Looking.", toolCalls: [
        { id: "s1", name: "search", arguments: JSON.stringify({ pattern: "GetObjectW" }) },
        { id: "o1", name: "outline", arguments: JSON.stringify({ path: "a.ts" }) },
      ] },
      { role: "tool", toolCallId: "s1", content: "No matches found.", summary: "grep GetObjectW — no matches", quiet: true },
      { role: "tool", toolCallId: "o1", content: "…", summary: "outline a.ts", quiet: true },
    ],
  } as unknown as Session;
  const replays = replayHistory(session).filter((e) => e.type === "toolReplay");
  assert.equal(replays.length, 1);
  const r = replays[0]!;
  assert.equal(r.type === "toolReplay" && r.tool, "search");
  assert.equal(r.type === "toolReplay" && r.quiet, true);
  assert.equal(r.type === "toolReplay" && r.arg, "GetObjectW");
});

test("a reopened session leaves out words that only led to unseen tools, like it did live", () => {
  const session = {
    cwd: "C:/p",
    modelConfig: { model: "deepseek-v4-pro" },
    transcript: [
      { role: "user", content: "fix it" },
      { role: "assistant", content: "Let me find where it lives.", toolCalls: [{ id: "s1", name: "search", arguments: JSON.stringify({ pattern: "x" }) }] },
      { role: "tool", toolCallId: "s1", content: "No matches found.", quiet: true },
      { role: "assistant", content: "Reading the file.", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ paths: ["a.ts"] }) }] },
      { role: "tool", toolCallId: "r1", content: "1 x" },
      { role: "assistant", content: "Reading it again.", toolCalls: [{ id: "r2", name: "read_file", arguments: JSON.stringify({ path: "a.ts", offset: 5 }) }] },
      { role: "tool", toolCallId: "r2", content: "5 y" },
      { role: "assistant", content: "Done." },
    ],
  } as unknown as Session;
  const said = replayHistory(session).filter((e) => e.type === "assistantMessage").map((e) => e.type === "assistantMessage" && e.text);
  assert.deepEqual(said, ["Reading the file.", "Done."]);
});

test("a reopened session's rows carry their call's arguments, so a front end knows which file each is about", () => {
  const session = {
    cwd: "C:/p",
    modelConfig: { model: "deepseek-v4-pro" },
    transcript: [
      { role: "assistant", content: "", toolCalls: [
        { id: "e1", name: "edit", arguments: JSON.stringify({ path: "src/a.ts", old_string: "x", new_string: "y" }) },
        { id: "r1", name: "read_file", arguments: JSON.stringify({ paths: ["src/a.ts", "pkg/tsconfig.json"] }) },
      ] },
      { role: "tool", toolCallId: "e1", content: "ok", summary: "edited src/a.ts" },
      { role: "tool", toolCallId: "r1", content: "…", summary: "read 2 files" },
    ],
  } as unknown as Session;
  const rows = replayHistory(session).filter((e) => e.type === "toolReplay") as { tool?: string; args?: Record<string, unknown> }[];
  assert.equal(rows[0]!.args?.path, "src/a.ts");
  assert.deepEqual(rows[1]!.args?.paths, ["src/a.ts", "pkg/tsconfig.json"]);
});

test("a reopened session hands back the uncut block, so a long row can still be opened", () => {
  const session = {
    cwd: "C:/p",
    modelConfig: { model: "deepseek-v4-pro" },
    transcript: [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "seq 1 60" }) }] },
      { role: "tool", toolCallId: "c1", content: "1\n2", summary: "ran", detail: "$ seq 1 60\n1", detailFull: "$ seq 1 60\n1\n2\n3", detailKind: "shell" },
    ],
  } as unknown as Session;
  const row = replayHistory(session).find((e) => e.type === "toolReplay");
  assert.equal(row?.type === "toolReplay" && row.detailFull, "$ seq 1 60\n1\n2\n3");
});

async function diskSession() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "dur-state-"));
  return createSession(mkdtempSync(join(tmpdir(), "dur-proj-")));
}

test("the user's message is on disk the moment it is recorded, before any model call", async () => {
  const s = await diskSession();
  await recordUserMessage(s, "please fix the build");
  const onDisk = await loadTranscript(s.cwd, s.id);
  assert.equal(onDisk?.at(-1)?.role, "user");
  assert.equal(onDisk?.at(-1)?.content, "please fix the build");
});

test("a reply cut off by a crash is put back, marked, and saved; a duplicate of a saved one is not", async () => {
  const s = await diskSession();
  await recordUserMessage(s, "explain the cache");
  assert.equal(await appendInterruptedReply(s, "The cache works by keeping"), true);
  const onDisk = await loadTranscript(s.cwd, s.id);
  assert.match(String(onDisk?.at(-1)?.content), /^The cache works by keeping\n\n\(interrupted\)$/);
  // The same words already saved as a reply (the kill came just after the save): nothing added.
  const s2 = await diskSession();
  await recordUserMessage(s2, "hi");
  s2.transcript.push({ role: "assistant", content: "Hello there, how can I help?" });
  assert.equal(await appendInterruptedReply(s2, "Hello there, how can I"), false);
  assert.equal(await appendInterruptedReply(s2, "   "), false);
});
