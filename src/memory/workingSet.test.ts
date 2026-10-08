/**
 * workingSet.test.ts — which files the session has been working in, most recent first.
 *
 * Only the selection is left (see workingSet.ts); the block that used to be built from it is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectActiveFiles } from "./workingSet.js";
import type { ReadRecord } from "../tools/types.js";

// ── selection (LRU) ──────────────────────────────────────────────────────────────

test("selectActiveFiles returns the most-recently-touched files, capped", () => {
  const reads = new Map<string, ReadRecord>([
    ["/p/a.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 1 }],
    ["/p/b.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 3 }],
    ["/p/c.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 2 }],
  ]);
  const active = selectActiveFiles(reads, 2);
  assert.deepEqual(active.map((a) => a.path), ["/p/b.ts", "/p/c.ts"]); // by recency, capped at 2
});

test("the read ledger's own order is NOT recency — always go through selectActiveFiles", () => {
  // The trap this helper exists for, written down. `ctx.reads` is a Map, and re-setting
  // an existing key does not move it: `touch()` mutates the record in place and
  // `recordWrite()` re-sets it, so neither reorders anything. Code that sliced the key
  // list to find "the files most recently worked on" got the files first SEEN instead,
  // which is how a file the model kept returning to dropped out of its own relevance
  // feed as soon as five others had been opened.
  const reads = new Map<string, ReadRecord>();
  reads.set("/p/first.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 1 });
  reads.set("/p/second.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 2 });
  reads.set("/p/first.ts", { mtimeMs: 0, size: 0, full: true, touchedAt: 3 }); // worked on again

  assert.deepEqual([...reads.keys()].slice(-1), ["/p/second.ts"], "insertion order is not recency");
  assert.equal(selectActiveFiles(reads, 1)[0]!.path, "/p/first.ts", "recency is what callers actually want");
});
