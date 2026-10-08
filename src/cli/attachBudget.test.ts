/**
 * attachBudget.test.ts — what one message may attach, and what happens to an old attachment.
 *
 * Twelve files of 250 KB attached by twelve @mentions made ONE message of about 878K
 * tokens, more than any window, and an attached file was never cleared, so it rode in every
 * request for the rest of the session while the same file read with read_file was cleared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_FILE_TOKENS, resolveAttachments } from "./attachments.js";
import { ATTACHMENT_CLEARED, microcompact } from "../memory/compaction.js";
import type { Entry } from "../memory/types.js";

test("twelve big files cannot make one huge message: the rest are attached by reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-attbudget-"));
  try {
    const body = "const value = 1; // ordinary source\n".repeat(6000); // ~210 KB, ~60K tokens: over the per-file cap
    const small = "const small = 1;\n".repeat(200);
    for (let i = 0; i < 12; i++) await fs.writeFile(join(dir, `big${i}.ts`), body);
    for (let i = 0; i < 6; i++) await fs.writeFile(join(dir, `small${i}.ts`), small);

    const big = await resolveAttachments(Array.from({ length: 12 }, (_, i) => `@big${i}.ts`).join(" "), dir);
    assert.ok(big.modelText.length < 20_000, `one message carried ${big.modelText.length} characters`);
    assert.equal(big.notes.filter((n) => n.startsWith("skipped")).length, 12);
    assert.match(big.modelText, /read_file on big0\.ts with an offset and limit/);

    // Small files still attach, until the message's own total is reached.
    const smalls = await resolveAttachments(Array.from({ length: 6 }, (_, i) => `@small${i}.ts`).join(" "), dir, false, undefined, 2000);
    const attached = (smalls.modelText.match(/const small = 1;/g) ?? []).length > 0 ? smalls.notes.filter((n) => n.startsWith("attached")).length : 0;
    assert.ok(attached >= 1 && attached < 6, `attached ${attached} of 6 under a 2000-token total`);
    assert.ok(ATTACH_FILE_TOKENS > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an old attachment's body is cleared, a recent one is not, and a small one stays", () => {
  const body = "export function f() { return 1; }\n".repeat(400);
  const block = (p: string, b: string) => `look at this\n\n<attached_file path="${p}">\n${b}\n</attached_file>`;
  const entries: Entry[] = [
    { role: "user", content: block("src/a.ts", body) },
    { role: "assistant", content: "ok, read it" },
    { role: "user", content: block("src/tiny.ts", "export const x = 1;") },
    { role: "assistant", content: "ok" },
    ...Array.from({ length: 6 }, (_, i): Entry[] => [
      { role: "user", content: `message ${i}` },
      { role: "assistant", content: "ok" },
    ]).flat(),
    { role: "user", content: block("src/recent.ts", body) },
  ];
  const { entries: out, attachmentsCleared } = microcompact(entries, 2);
  assert.equal(attachmentsCleared, 1);
  const first = out[0]!.content;
  assert.match(first, new RegExp(ATTACHMENT_CLEARED));
  assert.match(first, /src\/a\.ts/);
  assert.match(first, /400 lines/);
  assert.ok(!first.includes("export function f()"), "the body was kept");
  assert.ok(out[2]!.content.includes("export const x = 1;"), "a small attachment should stay");
  assert.ok(out.at(-1)!.content.includes("export function f()"), "the newest message is untouched");
});
