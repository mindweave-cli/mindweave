/**
 * profile.test.ts — the user's name reaches the prompt clean, or not at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanName, profilePrompt, readProfile, saveProfile } from "./profile.js";

test("a name is trimmed, single-spaced, stripped of control characters and clipped", () => {
  assert.equal(cleanName("  Ada \n\t Lovelace  "), "Ada Lovelace");
  assert.equal(cleanName("x".repeat(200)).length, 60);
  assert.equal(cleanName(42), "");
});

const EMPTY = { name: "", level: "", style: "" } as const;

test("nothing set says nothing at all", () => {
  assert.equal(profilePrompt({ ...EMPTY }), "");
});

test("each level and each style puts its own distinct instruction in the prompt", () => {
  const seen = new Set<string>();
  for (const level of ["beginner", "intermediate", "expert"] as const) {
    const text = profilePrompt({ ...EMPTY, level });
    assert.match(text, /follow these instead/);
    seen.add(text);
  }
  for (const style of ["concise", "balanced", "detailed"] as const) seen.add(profilePrompt({ ...EMPTY, style }));
  assert.equal(seen.size, 6);
  assert.match(profilePrompt({ ...EMPTY, level: "beginner" }), /new to programming/);
  assert.match(profilePrompt({ ...EMPTY, style: "detailed" }), /thorough/);
});

test("name, level and style together are one line each", () => {
  const text = profilePrompt({ name: "Ada", level: "expert", style: "concise" });
  assert.equal(text.split("\n").filter((l) => l.startsWith("- ")).length, 3);
  assert.match(text, /The user's name is Ada\./);
});

test("save then read round-trips the cleaned name; a missing file reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-profile-"));
  try {
    const path = join(dir, "profile.json");
    assert.equal(readProfile(path).name, "");
    assert.equal(saveProfile({ name: "  Ada  " }, path).name, "Ada");
    assert.equal(readProfile(path).name, "Ada");
    // Setting one field keeps the others; an unknown value clears rather than sneaks in.
    saveProfile({ level: "expert" }, path);
    assert.deepEqual(saveProfile({ style: "concise" }, path), { name: "Ada", level: "expert", style: "concise" });
    assert.equal(saveProfile({ style: "shouty" as never }, path).style, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
