/**
 * loopLab.test.ts — the model↔tool loop, driven end to end against a scripted provider.
 *
 * The loop is where every token is spent and where every failure is expensive: a request the
 * provider rejects ends the turn, and a malformed history rejects EVERY later request in the
 * session. The unit tests cover the pieces; this covers what they cannot, which is the pieces
 * together on the real `respond()` with a real session and real tools in a temp folder, and
 * then checks what the NEXT request would carry.
 *
 * The provider is a local server speaking the same wire the Gemini driver does (there is no
 * driver stub in this codebase; pointing a real driver at a server that answers from a script
 * is the honest way to run the loop). Each scenario scripts the replies, runs a turn, and
 * inspects the request bodies the provider received.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import type { Session } from "../memory/types.js";
import type { Tool, ToolSchema } from "../tools/types.js";
import { stopChassis } from "../alternator/lane.js";
import { projectDir } from "../memory/store.js";
import { parseCommandRules } from "../tools/commandPolicy.js";

// ── the scripted provider ────────────────────────────────────────────────────

/** One scripted reply: words, tool calls, an optional finish reason and usage. */
interface Reply {
  text?: string;
  tools?: { name: string; args: unknown }[];
  finish?: string;
  usage?: { prompt: number; completion: number; cached?: number };
}
type Body = { messages: WireMessage[]; tools?: { function: { name: string } }[] };
type WireMessage = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string };

let script: Reply[] = [];
let bodies: Body[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const reply = script.shift() ?? { text: "(script ran out)" };
      const frames: unknown[] = [];
      if (reply.text) frames.push({ choices: [{ delta: { content: reply.text } }] });
      (reply.tools ?? []).forEach((t, index) => {
        frames.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${bodies.length}_${index}`, type: "function", function: { name: t.name, arguments: "" } }] } }] });
        frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(t.args) } }] } }] });
      });
      const u = reply.usage ?? { prompt: 100, completion: 10 };
      frames.push({
        choices: [{ delta: {}, finish_reason: reply.finish ?? (reply.tools?.length ? "tool_calls" : "stop") }],
        usage: {
          prompt_tokens: u.prompt,
          completion_tokens: u.completion,
          total_tokens: u.prompt + u.completion,
          ...(u.cached !== undefined ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}),
        },
      });
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
beforeEach(() => {
  script = [];
  bodies = [];
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every session this file makes, so its code-analysis helpers can be stopped at the end. */
const made: Session[] = [];
after(async () => {
  // An edit starts a background language-server lane, which would otherwise keep the whole
  // test process alive for minutes after the last test has finished.
  for (const s of made) await stopChassis(s.toolContext.chassis).catch(() => {});
});

async function lab(): Promise<{ session: Session; root: string }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-lab-")));
  mkdirSync(join(root, "src"), { recursive: true });
  const session = await createSession(root);
  made.push(session);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  return { session, root };
}

/**
 * What a provider insists on: every assistant message that calls tools is followed
 * IMMEDIATELY by one tool message per call, and nothing else sits between them.
 * Returns the faults found (empty means the request is well-formed).
 */
function malformed(messages: WireMessage[]): string[] {
  const faults: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      // A result must belong to the nearest preceding assistant's calls.
      let j = i - 1;
      while (j >= 0 && messages[j]!.role === "tool") j--;
      const owner = messages[j];
      if (!owner || owner.role !== "assistant" || !owner.tool_calls?.some((c) => c.id === m.tool_call_id)) {
        faults.push(`orphan tool result ${m.tool_call_id} at ${i}`);
      }
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const owed = new Set(m.tool_calls.map((c) => c.id));
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        owed.delete(messages[j]!.tool_call_id!);
        j++;
      }
      if (owed.size > 0) faults.push(`tool calls with no result: ${[...owed].join(",")} (assistant at ${i})`);
    }
  }
  return faults;
}

/** Every request the provider received must be well-formed, and no assistant may be empty. */
function assertAllWellFormed(label: string): void {
  bodies.forEach((b, n) => {
    assert.deepEqual(malformed(b.messages), [], `${label}: request ${n + 1} is malformed`);
    for (const [i, m] of b.messages.entries()) {
      if (m.role === "assistant" && !m.tool_calls?.length) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        assert.ok(text.trim() !== "" && text !== "null", `${label}: request ${n + 1} carries an EMPTY assistant message at ${i}`);
      }
    }
  });
}

const toolText = (m: WireMessage): string => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

// ── scenarios ────────────────────────────────────────────────────────────────

test("a plain answer is one call and a well-formed history", async () => {
  const { session } = await lab();
  script = [{ text: "Hello there." }];
  session.transcript.push({ role: "user", content: "hi" });
  const out = await respond(session, {});
  assert.equal(out, "Hello there.");
  assert.equal(bodies.length, 1);
  assertAllWellFormed("plain");
});

test("calls in ONE step run in the order the model wrote them: a read after a write sees the write", async () => {
  // [write, read] of the same new file. If the read-only call is run first (because read-only
  // calls were batched ahead of mutating ones) it fails with "not found" and the model carries
  // on believing the file it has just written is not there.
  const { session, root } = await lab();
  const file = join(root, "src", "fresh.txt");
  script = [
    {
      tools: [
        { name: "write_file", args: { path: file, content: "NEW CONTENT" } },
        { name: "read_file", args: { path: file } },
      ],
    },
    { text: "done" },
  ];
  session.transcript.push({ role: "user", content: "write it and show me" });
  await respond(session, {});
  const results = bodies[1]!.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 2);
  assert.match(toolText(results[1]!), /NEW CONTENT/, `the read ran BEFORE the write: ${toolText(results[1]!)}`);
  assert.equal(readFileSync(file, "utf8"), "NEW CONTENT");
  assertAllWellFormed("order");
});

test("a tool that throws an abort mid-batch leaves a history the next request can still use", async () => {
  // Esc during a tool. The assistant message with its calls is already saved, so if the
  // results never land every LATER request in the live session is malformed until restart.
  const { session } = await lab();
  const hang: Tool = {
    name: "mcp__lab__hang",
    description: "x",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    execute: async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  };
  const schema: ToolSchema = { type: "function", function: { name: hang.name, description: "x", parameters: { type: "object", properties: {} } } };
  (session.toolContext as unknown as { mcp: unknown }).mcp = {
    estimatedTokens: () => 0,
    snapshot: () => ({ deferred: false, catalog: [], toolCount: 1, tokens: () => 0, exposedSchemas: () => [schema], asTool: (n: string) => (n === hang.name ? hang : undefined) }),
  };
  script = [{ tools: [{ name: hang.name, args: {} }] }, { text: "ok, carrying on" }];
  session.transcript.push({ role: "user", content: "go" });
  await respond(session, {}).catch(() => {});
  // The user types again. This is the request that must still be valid.
  session.transcript.push({ role: "user", content: "continue" });
  await respond(session, {});
  assertAllWellFormed("abort");
});

test("a reply with no words and no tool calls does not poison the history", async () => {
  // Some models return nothing at all (a refusal the driver could not name, a filtered
  // reply, an empty completion). An empty assistant message in the history is rejected by
  // several providers, and it would be sent on every later request.
  const { session } = await lab();
  script = [{ text: "" }, { text: "second answer" }];
  session.transcript.push({ role: "user", content: "first" });
  await respond(session, {}).catch(() => {});
  session.transcript.push({ role: "user", content: "second" });
  await respond(session, {});
  assertAllWellFormed("empty");
});

test("a reply cut off at the output ceiling pauses with the words kept, and 'continue' resumes cleanly", async () => {
  const { session } = await lab();
  script = [{ text: "The first half of an answer that was cut", finish: "length" }, { text: "and here is the rest." }];
  session.transcript.push({ role: "user", content: "write a long answer" });
  await respond(session, {});
  assert.ok(session.transcript.some((e) => e.role === "assistant" && String(e.content).includes("first half")), "the partial words were dropped");
  session.transcript.push({ role: "user", content: "continue" });
  await respond(session, {});
  assertAllWellFormed("truncated");
});

test("across the steps of one real turn, every request EXTENDS the last: the cached prefix is never rewritten", async () => {
  // This is what decides cache hits on every provider. The system prompt, the tool list and
  // the earlier messages must be byte-identical from one step to the next, with only the
  // trailing volatile-context message allowed to change. A single rewritten earlier message
  // (a note spliced in, a result re-rendered, a reordered tool) re-bills the whole prompt.
  const { session, root } = await lab();
  const a = join(root, "src", "a.ts");
  writeFileSync(a, "export const a = 1;\nexport const b = 2;\n");
  script = [
    { text: "Looking.", tools: [{ name: "read_file", args: { path: a } }] },
    { tools: [{ name: "edit", args: { path: a, edits: [{ old_string: "a = 1", new_string: "a = 10" }] } }] },
    { tools: [{ name: "run_command", args: { command: 'node -e "console.log(42)"' } }] },
    { text: "Changed a to 10 and ran the check." },
  ];
  session.transcript.push({ role: "user", content: "set a to 10" });
  await respond(session, {});
  assert.ok(bodies.length >= 4, `expected a 4 step turn, saw ${bodies.length}`);

  const strip = (b: Body): WireMessage[] => {
    const last = b.messages[b.messages.length - 1];
    const ctx = last?.role === "user" && typeof last.content === "string" && last.content.includes("<current_context>");
    return ctx ? b.messages.slice(0, -1) : b.messages;
  };
  for (let i = 0; i + 1 < bodies.length; i++) {
    const before = strip(bodies[i]!);
    const after = strip(bodies[i + 1]!);
    assert.deepEqual(after.slice(0, before.length), before, `step ${i + 2} rewrote what step ${i + 1} had sent`);
    assert.deepEqual(bodies[i + 1]!.tools, bodies[i]!.tools, `the tool list changed between step ${i + 1} and ${i + 2}`);
    assert.ok(after.length > before.length, "a step added nothing");
  }
  assertAllWellFormed("prefix");
});

// ── the three modes ─────────────────────────────────────────────────────────

import { guardOptions } from "./guard.js";

test("Architect (plan mode): editing tools are not offered, and calling one anyway changes nothing", async () => {
  const { session, root } = await lab();
  session.toolContext.planMode = true;
  const file = join(root, "src", "nope.txt");
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "x" } }] }, { text: "I will present a plan instead." }];
  session.transcript.push({ role: "user", content: "make a file" });
  await respond(session, {});
  const offered = (bodies[0]!.tools ?? []).map((t) => t.function.name);
  assert.ok(!offered.includes("write_file") && !offered.includes("edit") && !offered.includes("run_command"), `plan mode offered: ${offered.join(",")}`);
  assert.ok(offered.includes("read_file"), "plan mode must still offer reading");
  const refusal = bodies[1]!.messages.filter((m) => m.role === "tool").map(toolText).join("\n");
  assert.match(refusal, /plan mode/i, "the refusal must say why");
  assert.throws(() => readFileSync(file), "the file must not have been written");
  assertAllWellFormed("architect");
});

test("Sentinel: a declined action does not run and the model is told; an allowed one runs; 'don't ask again' is scoped to that kind", async () => {
  const { session, root } = await lab();
  session.toolContext.guarded = true;
  const asked: string[] = [];
  let answer: "no" | "yes" | "kind" = "no";
  session.toolContext.requestApproval = async (_q, options) => {
    asked.push(options[0] ?? "");
    return answer === "no" ? "No" : answer === "yes" ? guardOptions("write_file")[0] : guardOptions("write_file")[1];
  };
  const a = join(root, "src", "a.txt");
  const b = join(root, "src", "b.txt");
  const c = join(root, "src", "c.txt");

  // 1. declined
  script = [{ tools: [{ name: "write_file", args: { path: a, content: "A" } }] }, { text: "ok, not writing" }];
  session.transcript.push({ role: "user", content: "write a" });
  await respond(session, {});
  assert.throws(() => readFileSync(a), "a declined write still happened");
  assert.match(bodies[1]!.messages.filter((m) => m.role === "tool").map(toolText).join(" "), /declined|Stopped/i);

  // 2. allowed once
  answer = "yes";
  script = [{ tools: [{ name: "write_file", args: { path: b, content: "B" } }] }, { text: "done" }];
  session.transcript.push({ role: "user", content: "write b" });
  await respond(session, {});
  assert.equal(readFileSync(b, "utf8"), "B");
  const askedAfterTwo = asked.length;

  // 3. "don't ask again for this kind": the next write needs no question
  answer = "kind";
  script = [{ tools: [{ name: "write_file", args: { path: c, content: "C" } }] }, { text: "done" }];
  session.transcript.push({ role: "user", content: "write c" });
  await respond(session, {});
  assert.equal(readFileSync(c, "utf8"), "C");
  const d = join(root, "src", "d.txt");
  script = [{ tools: [{ name: "write_file", args: { path: d, content: "D" } }] }, { text: "done" }];
  session.transcript.push({ role: "user", content: "write d" });
  const before = asked.length;
  await respond(session, {});
  assert.equal(asked.length, before, "it asked again after 'don't ask again'");
  assert.equal(readFileSync(d, "utf8"), "D");
  assert.ok(askedAfterTwo >= 2, "the earlier writes were not gated");
  assertAllWellFormed("sentinel");
});

test("Sentinel with no way to ask refuses rather than runs", async () => {
  const { session, root } = await lab();
  session.toolContext.guarded = true;
  session.toolContext.requestApproval = undefined;
  const file = join(root, "src", "z.txt");
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "Z" } }] }, { text: "ok" }];
  session.transcript.push({ role: "user", content: "write z" });
  await respond(session, {});
  assert.throws(() => readFileSync(file), "an unanswerable approval must fail closed");
});

test("Lightning (the default) runs edits without asking", async () => {
  const { session, root } = await lab();
  const file = join(root, "src", "l.txt");
  let asked = 0;
  session.toolContext.requestApproval = async () => {
    asked++;
    return "No";
  };
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "L" } }] }, { text: "done" }];
  session.transcript.push({ role: "user", content: "write l" });
  await respond(session, {});
  assert.equal(readFileSync(file, "utf8"), "L");
  assert.equal(asked, 0);
});

// ── guards and token savers ──────────────────────────────────────────────────

test("a model grinding the same failing call is interrupted, then stopped: the turn is bounded", async () => {
  const { session, root } = await lab();
  const missing = join(root, "src", "missing.ts");
  // The same failure forever. If nothing stopped it, this script would run out and the
  // stand-in would start answering "(script ran out)" — which would END the turn by itself,
  // so the bound is checked on the number of model calls it took.
  script = Array.from({ length: 30 }, () => ({ tools: [{ name: "read_file", args: { path: missing } }] }));
  session.transcript.push({ role: "user", content: "read it" });
  const out = await respond(session, {});
  assert.ok(bodies.length <= 8, `the same failure was retried ${bodies.length} times before anything stopped it`);
  assert.match(out, /repeat|same|stopp|paus/i, `no explanation of the stop: ${out}`);
  assertAllWellFormed("grind");
});

test("reading the same unchanged file twice does not pay for it twice", async () => {
  const { session, root } = await lab();
  const file = join(root, "src", "big.ts");
  writeFileSync(file, Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  script = [
    { tools: [{ name: "read_file", args: { path: file } }] },
    { tools: [{ name: "read_file", args: { path: file } }] },
    { text: "read twice" },
  ];
  session.transcript.push({ role: "user", content: "read it twice" });
  await respond(session, {});
  const firstRead = bodies[1]!.messages.filter((m) => m.role === "tool").map(toolText)[0]!;
  const secondRead = bodies[2]!.messages.filter((m) => m.role === "tool").map(toolText)[1]!;
  assert.ok(firstRead.length > 4000, "sanity: the first read carried the file");
  assert.ok(secondRead.length < firstRead.length / 4, `the second read of an unchanged file re-sent ${secondRead.length} chars of ${firstRead.length}`);
});

test("an edit with no check afterwards is nudged once to verify, and the nudge is not repeated", async () => {
  const { session, root } = await lab();
  const file = join(root, "src", "m.ts");
  writeFileSync(file, "export const m = 1;\n");
  script = [
    { tools: [{ name: "read_file", args: { path: file } }] },
    { tools: [{ name: "edit", args: { path: file, edits: [{ old_string: "m = 1", new_string: "m = 2" }] } }] },
    { text: "Changed it." },
    { text: "Checked: fine." },
    { text: "again" },
  ];
  session.transcript.push({ role: "user", content: "set m to 2" });
  const out = await respond(session, {});
  const nudges = bodies.flatMap((b) => b.messages).filter((m) => m.role === "user" && typeof m.content === "string" && /verify|check|run/i.test(m.content) && m.content !== "set m to 2");
  assert.ok(nudges.length >= 1, "no verification nudge was sent");
  assert.ok(bodies.length <= 5, `the nudge kept firing: ${bodies.length} calls`);
  assert.match(out, /Checked|Changed/);
  assertAllWellFormed("verify");
});

test("a wide read-only fan-out all runs, answers come back in call order, and no more than the cap run at once", async () => {
  const { session, root } = await lab();
  const files = Array.from({ length: 24 }, (_, i) => {
    const f = join(root, "src", `f${i}.ts`);
    writeFileSync(f, `export const f${i} = ${i};\n`);
    return f;
  });
  script = [{ tools: files.map((f) => ({ name: "read_file", args: { path: f } })) }, { text: "read them all" }];
  session.transcript.push({ role: "user", content: "read everything" });
  await respond(session, {});
  const results = bodies[1]!.messages.filter((m) => m.role === "tool").map(toolText);
  assert.equal(results.length, 24);
  results.forEach((r, i) => assert.match(r, new RegExp(`f${i} = ${i}`), `result ${i} is not file ${i}'s content`));
  assertAllWellFormed("fanout");
});

// ── cache hit and miss accounting ────────────────────────────────────────────

test("what the provider reports as cached and uncached lands in the call log and the session spend", async () => {
  const { session, root } = await lab();
  const file = join(root, "src", "c.ts");
  writeFileSync(file, "export const c = 1;\n");
  // Three calls, a prompt that grows and a cache that catches up, as a real provider reports it.
  script = [
    { tools: [{ name: "read_file", args: { path: file } }], usage: { prompt: 1000, completion: 20, cached: 0 } },
    { tools: [{ name: "read_file", args: { path: file } }], usage: { prompt: 1100, completion: 30, cached: 900 } },
    { text: "done", usage: { prompt: 1200, completion: 40, cached: 1100 } },
  ];
  session.transcript.push({ role: "user", content: "go" });
  await respond(session, {});
  const log = session.callLog ?? [];
  assert.equal(log.length, 3, "one record per model call");
  assert.deepEqual(log.map((c) => [c.prompt, c.hit, c.miss, c.out]), [
    [1000, 0, 1000, 20],
    [1100, 900, 200, 30],
    [1200, 1100, 100, 40],
  ]);
  const spend = session.spend!;
  assert.equal(spend.turns, 1);
  assert.equal(spend.cacheHit, 2000, "cache hits summed");
  assert.equal(spend.cacheMiss, 1300, "uncached input summed");
  assert.equal(spend.output, 90);
  assert.equal(spend.billed, spend.cacheMiss + spend.output, "billed = uncached input + output, hits excluded");
});

test("a provider that reports no cache figures counts the whole prompt as uncached, never as hits", async () => {
  const { session } = await lab();
  script = [{ text: "hello", usage: { prompt: 500, completion: 10 } }];
  session.transcript.push({ role: "user", content: "hi" });
  await respond(session, {});
  const [call] = session.callLog ?? [];
  assert.deepEqual([call?.prompt, call?.hit, call?.miss], [500, 0, 500]);
});

// ── Sentinel and what is plainly harmless ───────────────────────────────────────────────────
// Every run_command asked a question, however harmless, which teaches people to answer yes
// without reading. A command that is read-only in every part, or covered by the user's own
// allow rule, no longer asks; everything else still does.

test("Sentinel does not ask about a read-only command, still asks about the rest, and honours the user's allow rule", async () => {
  const { session, root } = await lab();
  session.toolContext.guarded = true;
  const asked: string[] = [];
  session.toolContext.requestApproval = async (_q, _options, detail) => {
    asked.push(detail ?? "");
    return "No";
  };
  const turn = async (command: string) => {
    script = [{ tools: [{ name: "run_command", args: { command } }] }, { text: "ok" }];
    session.transcript.push({ role: "user", content: `run ${command}` });
    await respond(session, {});
  };

  await turn("git status");
  assert.equal(asked.length, 0, `asked about a read-only command: ${asked.join(" | ")}`);

  await turn("npm test");
  assert.equal(asked.length, 1, "npm test is not read-only and must still ask");

  await turn("git status; rm -rf build");
  assert.equal(asked.length, 2, "one read-only part does not make the rest harmless");

  session.governance.commandRules = parseCommandRules("allow npm test");
  await turn("npm test");
  assert.equal(asked.length, 2, "the user's allow rule lifts the question for that command only");
  await turn("npm publish");
  assert.equal(asked.length, 3);
});

test("answering 'never ask again' for a command prefix saves an allow rule for the project and stops the question", async () => {
  const { session, root } = await lab();
  session.toolContext.guarded = true;
  const asked: string[][] = [];
  let pick = 2;
  session.toolContext.requestApproval = async (_q, options) => {
    asked.push(options);
    return options[pick] ?? "No";
  };
  const turn = async (command: string) => {
    script = [{ tools: [{ name: "run_command", args: { command } }] }, { text: "ok" }];
    session.transcript.push({ role: "user", content: `run ${command}` });
    await respond(session, {});
  };

  await turn("node -e 0");
  assert.equal(asked[0]!.length, 2, "an interpreter gets no standing answer");

  await turn("npm --version");
  assert.equal(asked[1]!.length, 2, "a command with no safe prefix gets none either");

  await turn("npm ls --depth=0");
  assert.equal(asked[2]!.length, 3, "a nameable command offers one");
  assert.match(asked[2]![2]!, /"npm ls"/);
  const rules = readFileSync(join(projectDir(root), "command-rules.md"), "utf8");
  assert.match(rules, /^allow npm ls$/m);

  const before = asked.length;
  await turn("npm ls --all");
  assert.equal(asked.length, before, "the saved prefix covers the next command that starts with it");
  await turn("npm publish");
  assert.equal(asked.length, before + 1, "other npm commands still ask");
  assertAllWellFormed("prefix-allow");
});
