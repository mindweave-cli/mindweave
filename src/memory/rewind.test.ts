/**
 * rewind.test.ts — going back to before a message takes the conversation AND the files.
 *
 * The file half runs on the real Checkpoints against real files on disk; the last test
 * drives a real engine turn against a local stand-in provider, because the seam that
 * matters (a turn's checkpoint knows which message opened it) only exists in the engine.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Checkpoints } from "../tools/checkpoints.js";
import { editableMessage, lineDelta, pasteSlot, rewindPoints, rewindTo } from "./rewind.js";
import { memoryDir, MEMORY_INDEX } from "./autoMemory.js";
import { checkpointDir, projectDir, saveSession } from "./store.js";
import { resumeSession } from "./session.js";
import { wrapPastedText } from "./pastedText.js";
import { respond } from "../dynamo/engine.js";
import type { Entry, Session } from "./types.js";

function session(transcript: Entry[] = []): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-rewind-")));
  return {
    id: randomUUID(),
    cwd: root,
    createdAt: Date.now(),
    transcript,
    projectMemory: "",
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false, checkpoints: new Checkpoints() },
  } as unknown as Session;
}

/** One turn's edit as the tools make it: checkpoint first, then the write, then seal. */
function edit(s: Session, name: string, next: string): string {
  const path = join(s.cwd, name);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  s.toolContext.checkpoints!.backup(path, before, next);
  writeFileSync(path, next);
  return path;
}

test("rewinding to a message removes it and everything after, and puts its files back", async () => {
  const s = session();
  const path = join(s.cwd, "app.ts");
  writeFileSync(path, "original");
  s.transcript.push({ role: "user", content: "first", ts: 100 }, { role: "assistant", content: "ok" });
  s.transcript.push({ role: "user", content: "change app.ts", ts: 200 }, { role: "assistant", content: "changed" });
  edit(s, "app.ts", "changed");
  s.toolContext.checkpoints!.seal("change app.ts", 200);

  const r = await rewindTo(s, 200);

  assert.ok(r);
  assert.equal(readFileSync(path, "utf8"), "original");
  assert.deepEqual(r.restored, [path]);
  assert.equal(s.transcript.length, 2, "the message and its reply should be gone");
  assert.equal(r.message.text, "change app.ts");
  assert.equal(s.toolContext.checkpoints!.hasUndo(), false);
});

test("going back further unwinds every later turn, newest first", async () => {
  const s = session();
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  s.transcript.push({ role: "user", content: "one", ts: 100 });
  edit(s, "a.txt", "v1");
  s.toolContext.checkpoints!.seal("one", 100);
  s.transcript.push({ role: "user", content: "two", ts: 200 });
  edit(s, "a.txt", "v2");
  s.toolContext.checkpoints!.seal("two", 200);

  assert.equal(rewindPoints(s)[1]!.files, 1, "the picker should say going back to 'one' restores a file");
  await rewindTo(s, 100);

  assert.equal(readFileSync(path, "utf8"), "v0");
  assert.equal(s.transcript.length, 0);
});

test("an earlier turn's changes stay when rewinding to a later message", async () => {
  const s = session();
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  s.transcript.push({ role: "user", content: "one", ts: 100 });
  edit(s, "a.txt", "v1");
  s.toolContext.checkpoints!.seal("one", 100);
  s.transcript.push({ role: "user", content: "two", ts: 200 });
  edit(s, "a.txt", "v2");
  s.toolContext.checkpoints!.seal("two", 200);

  await rewindTo(s, 200);

  assert.equal(readFileSync(path, "utf8"), "v1");
  assert.equal(s.toolContext.checkpoints!.list().length, 1, "turn one is still undoable");
});

test("a file someone else changed afterwards is left alone and reported", async () => {
  const s = session();
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  s.transcript.push({ role: "user", content: "one", ts: 100 });
  edit(s, "a.txt", "v1");
  s.toolContext.checkpoints!.seal("one", 100);
  writeFileSync(path, "your own edit");

  const r = await rewindTo(s, 100);

  assert.equal(readFileSync(path, "utf8"), "your own edit");
  assert.deepEqual(r!.conflicts, [path]);
});

test("the message comes back apart: typed text, pastes, files and images", () => {
  const s = session();
  const file = join(s.cwd, "notes.md");
  const image = join(s.cwd, "shot.png");
  const content =
    `look at this\nnotes.md shot.png\n\n${wrapPastedText("line 1\nline 2")}\n\n` +
    `<attached_file path="notes.md">\nhello\n</attached_file>\n\n[Image source: shot.png]`;
  const m = editableMessage(
    { role: "user", content, images: [{ path: image, mediaType: "image/png" }] } as Extract<Entry, { role: "user" }>,
    s.cwd,
  );
  assert.equal(m.text, "look at this");
  assert.deepEqual(m.pastes, ["line 1\nline 2"]);
  assert.deepEqual(m.files, [file]);
  assert.deepEqual(m.images, [image]);
  assert.ok(m.template.includes(pasteSlot(0)), "the paste's place is kept for an inline input");
});

test("only messages the person typed to start a turn are offered", () => {
  const s = session([
    { role: "user", content: "real", ts: 100 },
    { role: "user", content: "nudge", ts: 110, synthetic: true },
    { role: "user", content: "typed mid-turn", ts: 120, arrival: "steered" },
    { role: "user", content: "The user ran /undo. The file changes were rolled back.", ts: 130 },
    { role: "user", content: "after a stop", ts: 140, arrival: "interrupting" },
  ]);
  assert.deepEqual(rewindPoints(s).map((p) => p.text), ["after a stop", "real"]);
});

test("notes and a todo list from the removed turns do not survive the rewind", async () => {
  const s = session([
    { role: "user", content: "one", ts: 100 },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "todo_write", arguments: "{}" }] },
    { role: "tool", toolCallId: "t1", content: "ok" },
  ]);
  s.sessionMemory = "notes about work that is being taken back";
  s.sessionMemoryEntries = 3;
  s.toolContext.todos = [{ content: "stale", status: "pending" }] as never;

  await rewindTo(s, 100);

  assert.equal(s.sessionMemory, undefined);
  assert.deepEqual(s.toolContext.todos, []);
});

test("notes that only cover what stays are kept", async () => {
  const s = session([
    { role: "user", content: "one", ts: 100 },
    { role: "assistant", content: "ok" },
    { role: "user", content: "two", ts: 200 },
  ]);
  s.sessionMemory = "notes about turn one";
  s.sessionMemoryEntries = 2;
  await rewindTo(s, 200);
  assert.equal(s.sessionMemory, "notes about turn one");
});

// ── the engine seam: a real turn's checkpoint is tied to the message that opened it ──

let server: Server;
/** Tool calls the stand-in makes, one per request, before it answers "done". */
let script: { name: string; args: Record<string, unknown> }[] = [];
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const next = script.shift();
      const frames = next
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${script.length}`, type: "function", function: { name: next.name, arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ]
        : [
            { choices: [{ delta: { content: "done" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => void server.close());

test("a real turn's file changes rewind with the message that asked for them", async () => {
  const s = session([{ role: "user", content: "make a file" }]);
  script = [{ name: "write_file", args: { path: "made.txt", content: "hello" } }];
  await respond(s, {});
  const made = join(s.cwd, "made.txt");
  assert.equal(readFileSync(made, "utf8"), "hello", "the stand-in turn should have written the file");

  const [point] = rewindPoints(s);
  assert.ok(point, "the message that opened the turn should be a rewind point");
  assert.equal(point.files, 1);

  const r = await rewindTo(s, point.at);
  assert.equal(existsSync(made), false, "a file the turn created is removed again");
  assert.equal(s.transcript.length, 0);
  assert.equal(r!.message.text, "make a file");
});

test("a memory the agent saved in the removed turns is taken back, and the session reloads", async () => {
  const s = session([{ role: "user", content: "remember this" }]);
  s.memoryIndex = "";
  script = [{ name: "save_memory", args: { name: "Deploy target", description: "where it deploys", type: "project", body: "Deploys go to staging first.", index_line: "deploys go to staging" } }];
  await respond(s, {});
  const dir = memoryDir(s.cwd);
  const saved = readdirSync(dir).filter((f) => f !== MEMORY_INDEX);
  assert.equal(saved.length, 1, "the stand-in turn should have saved one memory");

  const [point] = rewindPoints(s);
  assert.deepEqual(point!.state, { memory: 1 }, "the picker counts it as a memory, not a project file");
  assert.equal(point!.files, 0);

  const r = await rewindTo(s, point!.at);
  assert.deepEqual(readdirSync(dir).filter((f) => f !== MEMORY_INDEX), [], "the memory file is gone again");
  assert.deepEqual(r!.restoredState.map((x) => x.kind), ["memory"]);
  assert.doesNotMatch(s.memoryIndex, /staging/, "the live session no longer shows the memory");
});

test("a rule the user edited after the agent wrote it is left alone", async () => {
  const s = session([{ role: "user", content: "add a rule" }]);
  // Saving a rule asks the user; here they agree.
  s.toolContext.requestApproval = async () => "Yes";
  script = [{ name: "governor", args: { action: "remember_rule", name: "tabs", value: "Indent with tabs." } }];
  await respond(s, {});
  const ruleFile = readdirSync(join(projectDir(s.cwd), "rules")).map((f) => join(projectDir(s.cwd), "rules", f))[0];
  assert.ok(ruleFile, "the stand-in turn should have written a rule");
  writeFileSync(ruleFile, "Indent with two spaces. (edited by hand)");

  const r = await rewindTo(s, rewindPoints(s)[0]!.at);
  assert.equal(readFileSync(ruleFile, "utf8"), "Indent with two spaces. (edited by hand)");
  assert.deepEqual(r!.conflicts, [ruleFile]);
});

test("conversation only keeps the files; files only keeps the conversation and tells the agent", async () => {
  const make = () => {
    const s = session();
    const path = join(s.cwd, "a.txt");
    writeFileSync(path, "v0");
    s.transcript.push({ role: "user", content: "one", ts: 100 }, { role: "assistant", content: "done" });
    edit(s, "a.txt", "v1");
    s.toolContext.checkpoints!.seal("one", 100);
    return { s, path };
  };

  const a = make();
  await rewindTo(a.s, 100, "conversation");
  assert.equal(readFileSync(a.path, "utf8"), "v1");
  assert.equal(a.s.transcript.length, 0);

  const b = make();
  const r = await rewindTo(b.s, 100, "files");
  assert.equal(readFileSync(b.path, "utf8"), "v0");
  assert.equal(b.s.transcript.length, 3, "the conversation stays, plus the note to the agent");
  assert.match(b.s.transcript[2]!.content, /rolled back/);
  assert.equal(r!.mode, "files");
});

test("the size of a change counts lines added and removed", () => {
  assert.deepEqual(lineDelta("a\nb\nc", "a\nc\nd\ne"), { added: 2, removed: 1 });
  assert.deepEqual(lineDelta(null, "x\ny"), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta(null, "draft\n"), { added: 1, removed: 0 }, "a closing newline is not a second line");
  assert.deepEqual(lineDelta("hello\n", "hello\nfirst change\n"), { added: 1, removed: 0 });
});

test("undo history survives closing the app: a reopened session can still rewind its files", async () => {
  const s = session();
  s.toolContext.checkpoints!.persistTo(checkpointDir(s.cwd, s.id));
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  s.transcript.push({ role: "user", content: "change it", ts: 100 }, { role: "assistant", content: "done" });
  edit(s, "a.txt", "v1");
  s.toolContext.checkpoints!.seal("change it", 100);
  await s.toolContext.checkpoints!.flush();
  await saveSession(s);

  const reopened = await resumeSession(s.cwd, s.id);
  assert.ok(reopened);
  assert.equal(rewindPoints(reopened).at(-1)!.files, 1, "the reopened session still knows what the turn changed");
  const r = await rewindTo(reopened, 100);
  assert.equal(readFileSync(path, "utf8"), "v0");
  assert.deepEqual(r!.notRestored, []);
  await reopened.toolContext.checkpoints!.flush();
  assert.equal(existsSync(checkpointDir(s.cwd, s.id)), false, "nothing left to undo leaves nothing on disk");
});

test("only the most recent sessions keep undo history on disk", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-rewind-prune-")));
  const file = join(root, "f.txt");
  for (let i = 0; i < 7; i++) {
    const cp = new Checkpoints();
    cp.persistTo(checkpointDir(root, `s${i}`));
    cp.backup(file, "a", `b${i}`);
    cp.seal(`turn ${i}`, i);
    await cp.flush();
    await new Promise((r) => setTimeout(r, 20)); // distinct times, so "most recent" is defined
  }
  const kept = readdirSync(projectDir(root)).filter((n) => n.endsWith(".checkpoints")).sort();
  assert.deepEqual(kept, ["s2", "s3", "s4", "s5", "s6"].map((n) => `${n}.checkpoints`));
});

test("a session that never changed a file writes no undo history at all", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-rewind-empty-")));
  const cp = new Checkpoints();
  cp.persistTo(checkpointDir(root, "quiet"));
  cp.seal("nothing happened", 1);
  await cp.flush();
  assert.equal(existsSync(checkpointDir(root, "quiet")), false);
});
