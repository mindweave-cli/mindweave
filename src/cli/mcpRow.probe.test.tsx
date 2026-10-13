/**
 * mcpRow.probe.test.tsx — an MCP tool call is a line in the work row, and says what happened.
 *
 * It used to be a row of its own whose block read "Status: Connected [Latency: 5ms] /
 * Executed: binary_overview() / Received an error result", all in red: the first line
 * described the connection and the last described the call, so a failure looked like a
 * success painted red, and the server's own explanation was nowhere on screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { initialState, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { WorkGroup, commandHeader, openedLines } from "./components/WorkGroup.js";
import { toolDisplay, isGroupable } from "./toolDisplay.js";
import { mcpDetailText, mcpSummary } from "../mcp/resultView.js";

type Work = Extract<Block, { kind: "work" }>;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(d: string): boolean {
    this.frames.push(d);
    return true;
  }
}
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: false, setRawMode() {}, ref() {}, unref() {} });
  return s;
}
async function paint(items: Work["items"], opts: { open?: boolean; live?: boolean } = {}): Promise<string> {
  const out = new FakeStdout();
  const app = render(<WorkGroup id={5} items={items} open={opts.open} live={opts.live} columns={90} />, {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const until = Date.now() + 5000;
  while (out.frames.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}

const run = (actions: Action[]): TranscriptState => actions.reduce(reduce, initialState());
const all = (s: TranscriptState): Block[] => [...s.committed, ...s.tail];
const works = (s: TranscriptState): Work[] => all(s).filter((b): b is Work => b.kind === "work");

/** The start and end of one MCP call, built the way the app builds them. */
function call(id: string, tool: string, args: Record<string, unknown>, text: string, isError: boolean, ms = 5): Action[] {
  const d = toolDisplay(`mcp__rea__${tool}`, args);
  return [
    { type: "toolStart", toolId: id, name: d.name, arg: d.arg, action: d.kind, group: isGroupable(`mcp__rea__${tool}`) },
    {
      type: "toolEnd",
      toolId: id,
      ok: !isError,
      summary: mcpSummary(isError, text, ms),
      detail: mcpDetailText(args, text, 14),
      detailKind: "text",
    },
  ];
}
const runCmd = (id: string): Action[] => [
  { type: "toolStart", toolId: id, name: "Run", arg: "ls", action: "run", group: true },
  { type: "toolEnd", toolId: id, ok: true, summary: "s", detail: "$ ls\n✓ 0 · 1s", detailKind: "shell" },
];

const NO_APP = JSON.stringify({ error: { code: "target_unavailable", message: "No app is open. Ask the user which app to investigate, then call open_binary with its local path." } });

test("one MCP call is a row that says so", () => {
  const s = run([...call("a", "binary_overview", {}, "{}", false), { type: "endTurn" }]);
  const [g] = works(s);
  assert.equal(works(s).length, 1, "a call must not be a row of its own");
  assert.equal(commandHeader(g!.items, g!.live).text, "Called 1 MCP tool");
});

test("MCP calls fold in with commands, in either order, and the header counts each kind", () => {
  const s = run([...runCmd("c"), ...call("a", "open_binary", { path: "x" }, "{}", false), ...call("b", "binary_overview", {}, NO_APP, true), { type: "endTurn" }]);
  assert.equal(works(s).length, 1);
  const g = works(s)[0]!;
  assert.equal(commandHeader(g.items, g.live).text, "Ran 1 command, called 2 MCP tools");
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["ok", "ok", "error"], "a mark per call, and the failure is red without opening anything");
  const flipped = run([...call("a", "open_binary", {}, "{}", false), ...runCmd("c"), { type: "endTurn" }]);
  assert.equal(commandHeader(works(flipped)[0]!.items, false).text, "Called 1 MCP tool, ran 1 command");
});

test("while some are still going the count says which: Calling 1 of 2 MCP tools", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "MCP tool", arg: "rea · x", action: "mcp", group: true },
    { type: "toolStart", toolId: "b", name: "MCP tool", arg: "rea · y", action: "mcp", group: true },
    { type: "toolEnd", toolId: "a", ok: true, summary: "5ms" },
  ]);
  const g = works(s)[0]!;
  assert.equal(commandHeader(g.items, true).text, "Calling 1 of 2 MCP tools");
});

test("a failed call says why, in the server's own words, and is not 'Connected'", async () => {
  const s = run([...call("a", "binary_overview", {}, NO_APP, true), { type: "endTurn" }]);
  const text = await paint(works(s)[0]!.items, { open: true });
  assert.match(text, /Called 1 MCP tool/);
  assert.match(text, /rea · binary_overview/, "the line names the server and the tool");
  assert.match(text, /✗/);
  assert.match(text, /No app is open\./, "the server's reason is on the screen");
  assert.doesNotMatch(text, /Status: Connected/, "the connection is not the verdict");
  assert.doesNotMatch(text, /Received an error result/);
  // A row of one call opens onto what it asked and what came back.
  assert.match(text, /asked\s+no arguments/);
  assert.match(text, /target_unavailable/);
});

test("a call that worked shows a mark and how long it took", async () => {
  const s = run([...call("a", "open_binary", { path: "C:\\Windows\\notepad.exe" }, JSON.stringify({ result: { format: "pe" } }), false, 1400), { type: "endTurn" }]);
  const text = await paint(works(s)[0]!.items, { open: true });
  assert.match(text, /✓ rea · open_binary\s+1\.4s/);
  assert.match(text, /notepad\.exe/, "what it was asked is one click away");
  assert.match(text, /"format": "pe"/, "and the answer is laid out, not run together");
});

test("a chat saved before this kept a status block says so instead of showing it", () => {
  const old: Work["items"][number] = {
    toolId: "o",
    name: "MCP tool",
    arg: "rea",
    kind: "mcp",
    status: "ok",
    summary: "rea · open_binary",
    detail: "Status: Connected [Latency: 5ms]\nExecuted: open_binary()\nReceived 12 B (OK) → 12 chars",
  };
  assert.deepEqual(openedLines(old), ["(this chat was saved before MCP calls kept their details)"]);
});

/** A server change (add, enable, ...), built the way the app builds it. */
function change(id: string, args: Record<string, unknown>, summary: string, ok = true): Action[] {
  const d = toolDisplay("mcp_server", args);
  return [
    { type: "toolStart", toolId: id, name: d.name, arg: d.arg, action: d.kind, group: isGroupable("mcp_server") },
    { type: "toolEnd", toolId: id, ok, summary },
  ];
}

test("tool calls and server changes are ONE row, in the order they happened", () => {
  // The session that prompted this: a call failed, the agent enabled the server, a call
  // failed, it removed and re-added it... each used to be a row of its own.
  const s = run([
    ...call("a", "open_binary", {}, NO_APP, true),
    ...change("b", { action: "enable", name: "rea" }, "connected · 170 tools"),
    ...call("c", "binary_session", {}, NO_APP, true),
    ...change("d", { action: "remove", name: "rea" }, "removed"),
    ...change("e", { name: "rea" }, "connected · 170 tools"),
    { type: "endTurn" },
  ]);
  assert.equal(works(s).length, 1, "one row, not eight");
  assert.equal(all(s).filter((b) => b.kind === "tool").length, 0, "nothing stands alone");
  const g = works(s)[0]!;
  assert.equal(commandHeader(g.items, g.live).text, "Called 2 MCP tools, managed 1 MCP server", "the server is counted once, however many times it was changed");
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["error", "ok", "error", "ok", "ok"]);
});

test("a server change reads as its action, a tick, and what came of it", async () => {
  const s = run([...change("b", { action: "enable", name: "rea" }, "connected · 170 tools"), ...change("c", { action: "reconnect", name: "rea" }, "connected · 170 tools"), { type: "endTurn" }]);
  const text = await paint(works(s)[0]!.items, { open: true });
  assert.match(text, /Managed 1 MCP server/);
  assert.match(text, /✓ enable rea\s+connected · 170 tools/);
  assert.match(text, /✓ reconnect rea\s+connected · 170 tools/);
  assert.doesNotMatch(text, /▸/, "there is nothing behind a server change to open");
});

test("a server that would not connect says why under its line, in red", async () => {
  const s = run([...change("b", { action: "enable", name: "rea" }, "not connected: GHIDRA_INSTALL_DIR must be absolute", false), { type: "endTurn" }]);
  const text = await paint(works(s)[0]!.items, { open: true });
  assert.match(text, /✗ enable rea\s+not connected/);
  assert.match(text, /GHIDRA_INSTALL_DIR must be absolute/);
});

test("a change the user refused is not shown as done", async () => {
  const s = run([...change("b", { action: "remove", name: "rea" }, "declined"), ...change("c", { action: "enable", name: "rea" }, "declined"), { type: "endTurn" }]);
  const g = works(s)[0]!;
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["skipped", "skipped"], "no tick for something that did not happen");
  const text = await paint(g.items, { open: true });
  assert.match(text, /· remove rea\s+declined/);
  assert.doesNotMatch(text, /✓/);
});
