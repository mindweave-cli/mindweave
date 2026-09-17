/**
 * refusalNotice.probe.test.tsx — what an account refusal actually looks like.
 *
 * `drivers/providerError.test.ts` proves the classifier picks the right failures and
 * quotes the provider correctly. This proves the result reaches the screen as the
 * calm notice it is supposed to be, by rendering the real block through Ink into a
 * fake stdout and reading the rows back.
 *
 * The defect being replaced, for reference — a red crash carrying a JSON blob for
 * something that is not a crash at all:
 *
 *   ⚠ DeepSeek API error 402: {"error":{"message":"Insufficient Balance", …}}
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BlockView } from "./components/BlockView.js";
import { accessRefusal, providerOutage } from "../drivers/providerError.js";
import { ProviderHttpError } from "../drivers/openaiCompat/wire.js";
import type { Block } from "./transcript.js";

class FakeStdout extends EventEmitter {
  columns = 76;
  rows = 30;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ESC = String.fromCharCode(27);
// The ESC byte belongs in the pattern. Without it the bracket sequence was removed and
// the escape itself stayed in the row, counting a column that nothing occupies, so a row
// measured two wider than it draws wherever colour is switched on.
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

/** Render one block and return its visible rows. */
function rowsOf(block: Block): string[] {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};

  const instance = render(<BlockView block={block} columns={76} tightTop={false} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  // Read BEFORE unmount, not after — Ink 7 writes a final blank frame on unmount,
  // which would otherwise be mistaken for the real last frame.
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return last.replace(ANSI, "").split("\n");
}

/** The notice a real DeepSeek 402 produces, end to end. */
function refusalBlock(status: number, body: string, label: string, canSwitch = true): Block {
  const refusal = accessRefusal(new ProviderHttpError(status, body, label, ""), label, canSwitch)!;
  return { kind: "notice", id: 1, done: true, title: refusal.title, body: refusal.body };
}

test("a spent balance renders as a titled notice, not a JSON dump", () => {
  const rows = rowsOf(
    refusalBlock(402, JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }), "DeepSeek"),
  );
  const text = rows.join("\n");

  assert.match(text, /DeepSeek isn't accepting requests on this key/);
  assert.match(text, /Insufficient Balance/);
  assert.ok(!text.includes("{"), `raw JSON reached the screen:\n${text}`);
  assert.ok(!text.includes("unknown_error"), "the envelope leaked");
  assert.ok(!text.includes("⚠"), "an account state must not render as a crash");
});

test("the provider's sentence sits on the rail, under the title", () => {
  const rows = rowsOf(refusalBlock(402, "Insufficient Balance", "DeepSeek")).filter((r) => r.trim());
  const title = rows.findIndex((r) => r.includes("isn't accepting"));
  const said = rows.findIndex((r) => r.includes("Insufficient Balance"));

  assert.ok(title >= 0 && said > title, `title at ${title}, message at ${said}`);
  assert.match(rows[said]!, /│/, "the quoted line belongs on the rail");
});

test("the actions are on screen and readable", () => {
  const text = rowsOf(refusalBlock(402, "no funds", "Anthropic")).join("\n");
  assert.match(text, /conversation is saved/);
  assert.match(text, /\/provider/);
});

test("with only one key configured, no switch is suggested", () => {
  const text = rowsOf(refusalBlock(402, "no funds", "Anthropic", false)).join("\n");
  assert.ok(!text.includes("/provider"), `offered a switch with nowhere to go:\n${text}`);
  assert.match(text, /conversation is saved/, "there must still be an action");
});

test("a rate limit reads as a rate limit, with no invented advice about money", () => {
  // Both arrive as an account refusal; only the provider knows which. Our wording
  // stays neutral and its sentence does the explaining.
  const text = rowsOf(refusalBlock(429, "Rate limit reached for requests", "Groq")).join("\n");
  assert.match(text, /Rate limit reached for requests/);
  assert.ok(!/top up|credit|billing/i.test(text), `we diagnosed something we do not know:\n${text}`);
});

test("an enormous body cannot push the notice past the frame", () => {
  // The notice renders in the footer region, where an unbounded block evicts the
  // input box. A whole HTML error page must come out short.
  const rows = rowsOf(refusalBlock(403, "<html><body>" + "x".repeat(4000) + "</body></html>", "Qwen"));
  assert.ok(rows.length <= 12, `notice rendered ${rows.length} rows`);
});

test("every line stays inside the terminal width", () => {
  const rows = rowsOf(refusalBlock(402, "Insufficient Balance on your account, please add funds to continue", "GLM"));
  for (const row of rows) {
    assert.ok(row.length <= 76, `row overflowed at ${row.length} columns: ${row}`);
  }
});

test("a provider outage renders as a notice that stays inside the width, with no crash marker", () => {
  const outage = providerOutage(new ProviderHttpError(502, "ERROR", "OpenRouter", ""), "OpenRouter", "Union Alpha")!;
  const rows = rowsOf({ kind: "notice", id: 1, done: true, title: outage.title, body: outage.body });
  const text = rows.join("\n");
  assert.match(text, /Union Alpha isn't responding right now/);
  assert.match(text, /\/model/);
  assert.ok(!text.includes("⚠"), "a provider outage must not render as our crash");
  for (const row of rows) assert.ok(row.length <= 76, `row overflowed at ${row.length} columns: ${row}`);
});
