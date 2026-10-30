/**
 * parallelWorkers.test.ts — workers that edit side by side, end to end.
 *
 * The real engine loop and the real tools against a local provider that plays the lead and its workers. What this proves, with
 * files on disk rather than by reading the code:
 *   - two editing workers with their own scopes really run AT THE SAME TIME (neither is answered until both have asked),
 *   - each writes only inside its scope, and an attempt to write elsewhere, or to run a command, is refused and changes nothing,
 *   - overlapping scopes are refused before the second worker starts,
 *   - the turn's ceiling on workers holds, a repeated slice is refused, and a task too short to need a worker is sent back,
 *   - the lead is told what each worker changed and what the turn has spent.
 */
process.env["MINDWEAVE_SUBAGENT_MAX_PER_TURN"] = "3";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { respond } = await import("../dynamo/engine.js");
const { createSession } = await import("../memory/session.js");
const { projectDir } = await import("../memory/store.js");
const { sendToAgent } = await import("./delegation.js");
const { stopChassis } = await import("../alternator/lane.js");

const SEP = String.fromCharCode(10, 10);
type Call = { name: string; args: Record<string, unknown> };
type Step = { calls?: Call[]; text?: string; /** Held until this resolves: lets a test write to a worker while it is mid-step. */ hold?: Promise<void> };

/** What each actor says, in order. An actor is found by the marker in the first message it was given. */
let script: Record<string, Step[]> = {};
let seen: Record<string, number> = {};
let bodies: Record<string, string[]> = {};
let server: Server;
/** Two workers are "at the same time" when each has asked before either is answered. */
let barrier: { want: Set<string>; arrived: Set<string>; open: () => void; promise: Promise<void>; both: boolean } | null = null;

const markerOf = (body: string): string => {
  const first = (JSON.parse(body).messages as Array<{ role: string; content: unknown }>).find((m) => m.role === "user");
  const text = JSON.stringify(first?.content ?? "");
  for (const key of Object.keys(script)) if (key !== "LEAD" && text.includes(key)) return key;
  return "LEAD";
};

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const who = markerOf(body);
      const n = seen[who] ?? 0;
      seen[who] = n + 1;
      (bodies[who] ??= []).push(body);
      if (barrier && n === 0 && barrier.want.has(who)) {
        barrier.arrived.add(who);
        if (barrier.arrived.size === barrier.want.size) {
          barrier.both = true;
          barrier.open();
        }
        await Promise.race([barrier.promise, new Promise((r) => setTimeout(r, 4000))]);
      }
      const step = script[who]?.[n] ?? { text: "STATUS: done\nNothing more." };
      if (step.hold) await step.hold;
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = step.calls
        ? [
            { choices: [{ delta: { tool_calls: step.calls.map((c, i) => ({ index: i, id: `${who}-${n}-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
          ]
        : [{ choices: [{ delta: { content: step.text ?? "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }];
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function project() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-parallel-")));
  mkdirSync(projectDir(root), { recursive: true });
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  (session.toolContext.activatedTools ??= new Set()).add("spawn_subagent");
  return { root, session };
}
const spawn = (task: string, extra: Record<string, unknown>): Call => ({ name: "spawn_subagent", args: { task, ...extra } });
const reset = (s: Record<string, Step[]>, wait?: string[]) => {
  script = s;
  seen = {};
  bodies = {};
  barrier = null;
  if (wait) {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    barrier = { want: new Set(wait), arrived: new Set(), open, promise, both: false };
  }
};
/** What the lead was told by its tools on its second request: the text of every tool result in the conversation. */
const resultsSeenByLead = (): string => {
  const messages = (JSON.parse(bodies["LEAD"]?.[1] ?? "{\"messages\":[]}").messages ?? []) as Array<{ role: string; content?: unknown }>;
  return messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n---\n");
};
const JOBS: Record<string, string> = {
  alpha: "Create the sign-in form component with its validation rules, wire the submit handler to the session store, and write the empty-state copy.",
  beta: "Implement the billing summary table: columns for plan, renewal date and amount, sorting by date, and the currency formatting helpers.",
  gamma: "Draft the onboarding checklist content as markdown, one section per milestone, each with its own short intro paragraph.",
  delta: "Port the notification preferences screen to the new layout grid, keeping every toggle and its saved state intact across reloads.",
  epsilon: "Rebuild the audit log export so that it streams rows to disk instead of holding them in memory, with a progress callback.",
  solo: "Generate the initial changelog file from the release notes, one entry per version in reverse chronological order.",
};
const LONG = (what: string) => JOBS[what] ?? what;

test("two editing workers with their own scopes run at the same time and each writes only in its own", async () => {
  const { root, session } = await project();
  reset(
    {
      LEAD: [
        { calls: [spawn("ALPHA " + LONG("alpha"), { slice: "alpha part", write_scope: ["alpha"] }), spawn("BETA " + LONG("beta"), { slice: "beta part", write_scope: ["beta/"] })] },
        { text: "Both parts are built." },
      ],
      ALPHA: [{ calls: [{ name: "write_file", args: { path: "alpha/a.txt", content: "from alpha\n" } }] }, { text: "STATUS: done\nWrote alpha/a.txt." }],
      BETA: [{ calls: [{ name: "write_file", args: { path: "beta/b.txt", content: "from beta\n" } }] }, { text: "STATUS: done\nWrote beta/b.txt." }],
    },
    ["ALPHA", "BETA"],
  );
  session.transcript.push({ role: "user", content: "LEAD build both parts" });
  try {
    await respond(session, {});
    assert.equal(barrier!.both, true, "both workers asked before either was answered, so they ran at the same time");
    assert.equal(readFileSync(join(root, "alpha/a.txt"), "utf8"), "from alpha\n");
    assert.equal(readFileSync(join(root, "beta/b.txt"), "utf8"), "from beta\n");
    const lead = resultsSeenByLead();
    assert.match(lead, /Files changed: alpha\/a\.txt/);
    assert.match(lead, /Files changed: beta\/b\.txt/);
    assert.match(lead, /Delegation this turn: 2 of 3 workers/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a worker cannot write outside its scope or run a command, and nothing outside changes", async () => {
  const { root, session } = await project();
  reset({
    LEAD: [{ calls: [spawn("GAMMA " + LONG("gamma"), { slice: "gamma part", write_scope: ["gamma"] })] }, { text: "ok" }],
    GAMMA: [
      {
        calls: [
          { name: "write_file", args: { path: "outside.txt", content: "no" } },
          { name: "write_file", args: { path: "../escape.txt", content: "no" } },
          { name: "run_command", args: { command: "echo no > shell.txt" } },
          { name: "write_file", args: { path: "gamma/ok.txt", content: "yes\n" } },
        ],
      },
      { text: "STATUS: done\nOnly gamma/ok.txt." },
    ],
  });
  session.transcript.push({ role: "user", content: "LEAD build gamma" });
  try {
    await respond(session, {});
    assert.equal(existsSync(join(root, "outside.txt")), false, "a file outside the scope was written");
    assert.equal(existsSync(join(root, "..", "escape.txt")), false);
    assert.equal(existsSync(join(root, "shell.txt")), false, "a command ran");
    assert.equal(readFileSync(join(root, "gamma/ok.txt"), "utf8"), "yes\n", "the file inside its scope was written");
    const childSaw = (bodies["GAMMA"]?.[1] ?? "");
    assert.match(childSaw, /outside your scope/);
    assert.match(childSaw, /could change files outside your scope/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("overlapping scopes in one message: the second worker is refused before it starts", async () => {
  const { root, session } = await project();
  reset({
    LEAD: [{ calls: [spawn("DELTA " + LONG("delta"), { slice: "delta part", write_scope: ["shared"] }), spawn("EPSILON " + LONG("epsilon"), { slice: "epsilon part", write_scope: ["shared/inner"] })] }, { text: "ok" }],
    DELTA: [{ calls: [{ name: "write_file", args: { path: "shared/d.txt", content: "d\n" } }] }, { text: "STATUS: done\nd" }],
  });
  session.transcript.push({ role: "user", content: "LEAD build delta and epsilon" });
  try {
    await respond(session, {});
    assert.equal(seen["EPSILON"] ?? 0, 0, "the refused worker never asked the model anything");
    assert.equal(existsSync(join(root, "shared/d.txt")), true, "the first worker did its work");
    assert.match(resultsSeenByLead(), /overlaps shared, which the worker "delta part" is editing right now/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a turn cannot start more workers than its ceiling, a repeated slice or a one-line task is refused", async () => {
  const { session } = await project();
  const read = (id: string, slice: string, text = `Read the ${id} module end to end and list every function that touches the network, with its file and line.`) => spawn(`${id.toUpperCase()}-JOB ` + text, { read_only: true, slice });
  reset({
    LEAD: [
      {
        calls: [
          read("one", "one"),
          read("two", "two"),
          read("repeat", "ONE"), // the same slice as the first, in other letters
          spawn("check it", { read_only: true, slice: "short" }), // far too short to need a worker
          read("three", "three"),
          read("four", "four"), // the fourth worker of a turn that allows three
        ],
      },
      { text: "ok" },
    ],
    // The workers say nothing special: they are listed so their requests are told apart from the lead's.
    "ONE-JOB": [],
    "TWO-JOB": [],
    "THREE-JOB": [],
    "FOUR-JOB": [],
    "REPEAT-JOB": [],
  });
  session.transcript.push({ role: "user", content: "LEAD look at everything" });
  try {
    await respond(session, {});
    const lead = resultsSeenByLead();
    assert.match(lead, /already owns the slice/, "a slice cannot be given twice");
    assert.match(lead, /quicker to do yourself/, "a one-line task is sent back");
    assert.match(lead, /used its 3 workers/, "the turn's ceiling holds");
    assert.ok((seen["ONE-JOB"] ?? 0) > 0 && (seen["TWO-JOB"] ?? 0) > 0 && (seen["THREE-JOB"] ?? 0) > 0, "the three that were allowed did run");
    assert.equal(seen["REPEAT-JOB"] ?? 0, 0);
    assert.equal(seen["FOUR-JOB"] ?? 0, 0, "the worker over the ceiling never ran");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("an editing worker without a scope still runs alone, as before", async () => {
  const { root, session } = await project();
  reset({
    LEAD: [{ calls: [spawn("SOLO " + LONG("solo"), {})] }, { text: "ok" }],
    SOLO: [{ calls: [{ name: "write_file", args: { path: "anywhere/s.txt", content: "s\n" } }] }, { text: "STATUS: done\ns" }],
  });
  session.transcript.push({ role: "user", content: "LEAD build solo" });
  try {
    await respond(session, {});
    assert.equal(readFileSync(join(root, "anywhere/s.txt"), "utf8"), "s\n", "an unscoped worker keeps its full tools");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

/** What a worker was sent on request `n`: the text of its user messages. */
const userTextOf = (who: string, n: number): string => {
  const messages = (JSON.parse(bodies[who]?.[n] ?? "{\"messages\":[]}").messages ?? []) as Array<{ role: string; content?: unknown }>;
  return messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join("\n---\n");
};

test("the person can write to a running worker: it reads the message between its steps", async () => {
  const { root, session } = await project();
  writeFileSync(join(root, "notes.txt"), "some notes\n");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  reset({
    LEAD: [{ calls: [spawn("MSGJOB Read notes.txt and tell me what the first line says, then report what else is in the project folder.", { read_only: true, slice: "notes" })] }, { text: "ok" }],
    MSGJOB: [{ calls: [{ name: "read_file", args: { paths: ["notes.txt"] } }], hold: held }, { text: "STATUS: done\nRead it." }],
  });
  session.transcript.push({ role: "user", content: "LEAD read the notes" });
  let id = "";
  try {
    await respond(session, {
      onEvent: (e) => {
        if (e.type === "subagent" && e.phase === "start") {
          id = e.id;
          // The worker is mid-step (its first call is held): the person writes to it now.
          setTimeout(() => {
            assert.equal(sendToAgent(id, "also check the footer of the page"), "queued");
            release();
          }, 80);
        }
      },
    });
    assert.ok(id, "the worker started");
    assert.match(userTextOf("MSGJOB", 1), /also check the footer of the page/, "its next request carried what the person wrote");
    assert.equal(sendToAgent(id, "too late"), "gone", "once the worker has ended it cannot be written to");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a message that arrives while the worker is writing its answer gets a round of its own", async () => {
  const { session } = await project();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  reset({
    LEAD: [{ calls: [spawn("LATEJOB Summarise what the project folder contains and say whether anything looks out of place in it.", { read_only: true, slice: "folder" })] }, { text: "ok" }],
    // It answers at once, with no tool calls, so nothing steers it: the message is the next request.
    LATEJOB: [{ text: "STATUS: done\nThe folder is empty.", hold: held }, { text: "STATUS: done\nAnd the footer is fine." }],
  });
  session.transcript.push({ role: "user", content: "LEAD look at the folder" });
  try {
    await respond(session, {
      onEvent: (e) => {
        if (e.type === "subagent" && e.phase === "start") {
          setTimeout(() => {
            sendToAgent(e.id, "please also look at the footer");
            release();
          }, 80);
        }
      },
    });
    assert.equal(seen["LATEJOB"], 2, "the worker was asked again");
    assert.match(userTextOf("LATEJOB", 1), /please also look at the footer/);
    assert.match(resultsSeenByLead(), /footer is fine/, "the lead gets the worker's last word");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
