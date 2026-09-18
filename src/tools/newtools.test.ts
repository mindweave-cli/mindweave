/**
 * newtools.test.ts — todo_write and web_fetch.
 *
 * todo_write is pure/deterministic and fully tested. web_fetch's network path is
 * gated behind MINDWEAVE_TEST_NETWORK (kept offline-green by default); its URL
 * validation and SSRF guard run always since they don't touch the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { todoWrite } from "./todo.js";
import { webFetch, normalizeUrl, ssrfReason } from "./webFetch.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] };
}

const TODOS = [
  { content: "Read the config", activeForm: "Reading the config", status: "completed" },
  { content: "Fix the bug", activeForm: "Fixing the bug", status: "in_progress" },
  { content: "Run the tests", activeForm: "Running the tests", status: "pending" },
];

test("todo_write stores the list and reflects it in the prompt block", async () => {
  const c = ctx();
  const r = await todoWrite.execute({ todos: TODOS }, c);
  assert.equal(r.isError, undefined);
  assert.equal(c.todos.length, 3);
  // Asserted on the TOOL RESULT, because that is now the only place the model sees the
  // list. It used to be re-rendered into the per-turn context on every step; it is not
  // any more, so a helper that renders it separately would prove nothing.
  assert.match(r.output, /\[x\] Read the config/);
  assert.match(r.output, /\[~\] Fixing the bug/); // in-progress shows active form
  assert.match(r.output, /\[ \] Run the tests/);
});

test("todo_write clears the list when everything is completed", async () => {
  const c = ctx();
  await todoWrite.execute({ todos: TODOS }, c);
  const allDone = TODOS.map((t) => ({ ...t, status: "completed" }));
  const r = await todoWrite.execute({ todos: allDone }, c);
  assert.equal(c.todos.length, 0);
  assert.match(r.output, /All tasks completed/);
});

test("todo_write validates status and required fields", async () => {
  const c = ctx();
  const bad = await todoWrite.execute({ todos: [{ content: "x", activeForm: "x", status: "doing" }] }, c);
  assert.equal(bad.isError, true);
  assert.match(bad.output, /status must be one of/);
  const noContent = await todoWrite.execute({ todos: [{ activeForm: "x", status: "pending" }] }, c);
  assert.equal(noContent.isError, true);
  assert.match(noContent.output, /content is required/);
});

test("todo_write accepts a task without activeForm and shows its content instead", async () => {
  // A real session lost a whole round to "todos[0].activeForm is required". The list is
  // never drawn on screen, so the wording of the task in progress is not worth a retry.
  const c = ctx();
  const r = await todoWrite.execute({ todos: [{ content: "Scaffold the project", status: "in_progress" }] }, c);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /Scaffold the project/);
  assert.equal(c.todos[0]!.activeForm, "Scaffold the project");
});

test("todo_write notes more than one in_progress", async () => {
  const c = ctx();
  const two = [
    { content: "A", activeForm: "Aing", status: "in_progress" },
    { content: "B", activeForm: "Bing", status: "in_progress" },
  ];
  const r = await todoWrite.execute({ todos: two }, c);
  assert.match(r.output, /in_progress/);
});

test("web_fetch rejects a missing url", async () => {
  const r = await webFetch.execute({}, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /url. is required/);
});

test("web_fetch refuses localhost and private addresses (SSRF guard)", async () => {
  for (const url of ["http://localhost:3000", "http://127.0.0.1", "https://192.168.1.5", "http://10.0.0.1", "https://169.254.169.254/latest/meta-data"]) {
    const r = await webFetch.execute({ url }, ctx());
    assert.equal(r.isError, true, `${url} should be refused`);
    assert.match(r.output, /Refusing to fetch/);
  }
});

test("web_fetch rejects a non-http scheme", async () => {
  const r = await webFetch.execute({ url: "file:///etc/passwd" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /scheme|Unsupported/);
});

test(
  "web_fetch reads a real page and returns markdown (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 30_000 },
  async () => {
    const r = await webFetch.execute({ url: "https://example.com" }, ctx());
    assert.equal(r.isError, undefined);
    assert.match(r.output, /Example Domain/i);
  },
);

// ── web_fetch: the two claims that save a wasted call ────────────────────────

test("a bare host really is accepted and upgraded to https", () => {
  // The description now promises this; if normalizeUrl stopped defaulting the scheme,
  // a model following the text would send a URL the tool rejects.
  const out = normalizeUrl("example.com");
  assert.ok(typeof out !== "string", `expected a URL, got error: ${out}`);
  assert.equal((out as URL).protocol, "https:");
  assert.match(webFetch.description, /bare host is fine/i);
});

test("http is upgraded and private addresses are refused", () => {
  const upgraded = normalizeUrl("http://example.com");
  assert.ok(typeof upgraded !== "string");
  assert.equal((upgraded as URL).protocol, "https:");
  for (const host of ["http://localhost/x", "http://127.0.0.1/x", "http://192.168.1.5/x"]) {
    const u = normalizeUrl(host);
    assert.ok(typeof u !== "string");
    assert.equal(typeof ssrfReason(u as URL), "string", `${host} must be refused`);
  }
});

test("web_fetch's stated distill threshold is the real constant", () => {
  assert.match(webFetch.description, /longer than 12,000 characters/i);
});

// ── todo_write: the list lives in its own tool result ────────────────────────
// It is NOT re-injected into the per-turn context any more. That injection re-sent the
// whole list on every step, uncached, for a list the tool result already carries — and
// a tool result sits in the append-only conversation, where the provider caches it.
// So the description must not promise a per-turn echo that no longer happens.

test("the list is returned by the tool, and not promised as a per-turn echo", async () => {
  const c = ctx();
  const r = await todoWrite.execute(
    {
      todos: [
        { content: "Run the tests", activeForm: "Running the tests", status: "in_progress" },
        { content: "Fix the bug", activeForm: "Fixing the bug", status: "pending" },
      ],
    },
    c,
  );
  assert.match(r.output, /Running the tests/, "the active task shows its present-continuous form");
  assert.match(r.output, /Fix the bug/);
  assert.doesNotMatch(
    todoWrite.description,
    /put back in front of you every turn/i,
    "the description cannot claim an echo the engine no longer performs",
  );
});

test("todo_write clears the list once everything is completed", async () => {
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await todoWrite.execute(
    { todos: [{ content: "a", activeForm: "doing a", status: "completed" }] },
    ctx,
  );
  assert.match(r.output, /All tasks completed/i);
  assert.deepEqual(ctx.todos, [], "a finished list must disappear rather than linger");
  assert.match(todoWrite.description, /the list clears itself/i);
});
