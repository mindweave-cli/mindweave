/**
 * userBandAlign.probe.test.tsx — your message lines up with the agent's.
 *
 * Reported from a real screen: the ">" of a message sat one column to the right of the agent's
 * dot, and the words started two columns deeper than the agent's words, so a conversation
 * zigzagged down the screen. The ">" now sits in the first column, where the dot is, and the
 * words start where the agent's words start, on the first row and on every wrapped row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Box, render } from "ink";
import { BlockView } from "./components/BlockView.js";
import type { Block } from "./transcript.js";

class Term extends EventEmitter {
  columns = 60;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

async function lines(blocks: Block[]): Promise<string[]> {
  const stdout = new Term();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  const instance = render(
    <Box flexDirection="column">
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} columns={60} />
      ))}
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false, interactive: true },
  );
  const deadline = Date.now() + 10_000;
  let frame: string | undefined;
  for (;;) {
    frame = stdout.frames.filter((f) => /REPLYWORD/.test(f)).at(-1);
    if (frame || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();
  assert.ok(frame, "nothing rendered");
  return frame.replace(ANSI, "").split(/\r?\n/);
}

test("the > of your message starts in the dot's column, and the words line up", async () => {
  const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
  const out = await lines([
    { kind: "user", id: 1, done: true, text: long },
    { kind: "assistant", id: 2, done: true, text: "REPLYWORD from the agent" },
  ]);
  const user = out.filter((l) => /^[> ] /.test(l) && /\S/.test(l.slice(2)));
  const first = user.find((l) => l.startsWith(">"));
  assert.ok(first, `no user row starts with ">":\n${out.join("\n")}`);
  const agent = out.find((l) => l.includes("REPLYWORD"));
  assert.ok(agent, "no agent row");
  const dot = agent.search(/\S/);
  assert.equal(first.indexOf(">"), dot, "the > starts in the same column as the agent's marker");
  assert.equal(first.indexOf("alpha"), agent.indexOf("REPLYWORD"), "the words start in the same column as the agent's");
  const wrapped = out.filter((l) => /^ {2}\S/.test(l) && !l.includes("REPLYWORD"));
  assert.ok(wrapped.length >= 1, "the long message wrapped onto more rows");
  for (const w of wrapped) assert.equal(w.search(/\S/), agent.indexOf("REPLYWORD"), `wrapped row is aligned: "${w}"`);
});
