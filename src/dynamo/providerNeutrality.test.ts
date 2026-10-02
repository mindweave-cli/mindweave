/**
 * providerNeutrality.test.ts — core must not name a specific model.
 *
 * The architectural rule (BOUNDARY.md): core never knows which model is running.
 * Only `drivers/<provider>/` may name a provider's models, endpoints, or wire
 * fields.
 *
 * This is enforced here rather than trusted, because it has already been broken
 * twice and neither break failed loudly:
 *   - `/model`'s autocomplete read "choose the model (DeepSeek V4 Flash / Pro)"
 *     long after a second provider shipped four models. Simply false, and shown to
 *     the user every session.
 *   - the `/think` overlay fell back to a hardcoded `"deepseek-v4-flash"`.
 *
 * Both type-checked, both passed every test, and neither would ever throw. A
 * source-level invariant is the only thing that catches this class.
 *
 * Scope note: MODEL IDS are banned outright, since core has no legitimate reason to
 * name one. Provider BRAND names are not — `tools/guard.ts` names other coding
 * tools on purpose (to avoid reading their private data), which is correct.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allModels } from "../drivers/registry.js";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Model-id shapes. Every real model id carries a version digit
 * (`deepseek-v4-flash`, `claude-sonnet-5`, `gpt-4o`), and requiring one is what
 * keeps this from firing on a product name like "Claude Code" — which core is
 * allowed to mention, because the agent-data guard names other tools on purpose.
 *
 * This list is a SAFETY NET, not the authority. It has to stay hand-written to
 * cover ids for providers that are not installed (a half-finished driver, a model
 * name pasted into a comment), but a hand-written list is exactly what rots: three
 * providers were once added without extending it, and the guard went on reporting
 * green while covering half the lineup. The authority is `allModels()` below, and
 * the coverage test keeps the two honest.
 */
const VENDOR_PREFIXES = [
  "deepseek-",
  "claude-",
  "gemini-",
  "qwen",
  "kimi-",
  "glm-",
  "moonshot-v",
  "grok-",
  "mistral-",
  "ministral-",
  "llama-",
  "muse-spark-",
  "minimax-",
  // Tencent's ids carry no vendor word at all — `hy3`, `hy4-preview` — so the prefix
  // is the family name itself. Short, and deliberately anchored by `\b` below so it
  // cannot match inside an ordinary word.
  "hy",
  "gpt-oss-",
  "gpt-",
];

/**
 * Ids that carry NO version digit, which the shape pattern requires, and so have to be
 * named: DeepSeek's canonical name for its Flash model is just `deepseek-flash`.
 */
const DIGITLESS_IDS = ["deepseek-flash"];

const MODEL_ID = new RegExp(
  `\\b(${VENDOR_PREFIXES.join("|")})[a-z0-9./-]*\\d[a-z0-9./-]*\\b|\\b(${DIGITLESS_IDS.join("|")})\\b`,
  "i",
);

/**
 * Every model id an installed provider actually serves.
 *
 * Read from the registry rather than transcribed, so adding a provider extends
 * this guard automatically instead of silently narrowing it. Sorted longest-first
 * so a report names the most specific id that matched rather than a prefix of it.
 */
const REGISTERED_IDS: string[] = allModels()
  .map((m) => m.id)
  .sort((a, b) => b.length - a.length);

/** Whether a line names a model id, by either route. Returns the id when it does. */
function namesModel(line: string): string | null {
  const lower = line.toLowerCase();
  for (const id of REGISTERED_IDS) {
    if (lower.includes(id.toLowerCase())) return id;
  }
  return line.match(MODEL_ID)?.[0] ?? null;
}

/** Directories under src/ that MAY name models. */
const ALLOWED = ["drivers"];

/** Walk core source files (everything except the driver folders). */
function coreFiles(dir: string, rel = ""): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) {
      if (ALLOWED.includes(name)) continue;
      out.push(...coreFiles(abs, r));
    } else if (/\.tsx?$/.test(name)) {
      out.push({ path: abs, rel: r });
    }
  }
  return out;
}

test("the detector actually catches the strings that shipped broken", () => {
  // Proves this test can fail. Without this, a regex typo would make every
  // assertion below vacuously pass and the guard would be worthless.
  assert.ok(MODEL_ID.test('description: "choose the model (DeepSeek V4 Flash / Pro)"') === false);
  assert.ok(MODEL_ID.test('const model = cur?.modelConfig.model ?? "deepseek-v4-flash";'));
  assert.ok(MODEL_ID.test('thinkLevels("claude-sonnet-5")'));
  assert.ok(MODEL_ID.test("gpt-4o"));
  // Ordinary core code must not trip it.
  assert.ok(!MODEL_ID.test("const model = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;"));
  assert.ok(!MODEL_ID.test('note(`model → ${modelLabel(s.modelConfig.model)}`)'));
  // A tool's PRODUCT name is not a model id — the agent-data guard names these
  // deliberately, so matching them here would be a false positive.
  assert.ok(!MODEL_ID.test("* This is the Claude-Code split: the model sees the bytes"));
  assert.ok(!MODEL_ID.test('{ test: /(^|\\/)\\.claude(\\/|$)/i, what: "Claude Code" },'));
  // A provider's BRAND name carries no version digit and must not trip the guard,
  // or a comment explaining the driver seam would become an offender.
  for (const brand of ["Qwen", "Kimi", "GLM", "DeepSeek", "OpenAI", "Anthropic"]) {
    assert.ok(!MODEL_ID.test(`// the ${brand} driver owns this`), `${brand} is a brand, not an id`);
  }
});

test("the detector covers every model every INSTALLED provider serves", () => {
  // The meta-guard, and the one that would have caught the real regression: three
  // providers were added and the hand-written pattern was not extended, so ids like
  // `qwen3.7-plus` sailed past a guard that still reported green. Adding a provider
  // now fails HERE until it is genuinely covered.
  const missed = allModels()
    .map((m) => m.id)
    .filter((id) => namesModel(`const model = "${id}";`) === null);
  assert.deepEqual(missed, [], `these model ids would leak into core undetected:\n${missed.join("\n")}`);
});

test("the shape pattern alone covers every installed provider, not just the id list", () => {
  // `REGISTERED_IDS` catches exact ids; the shape pattern is what catches a
  // NEIGHBOURING id of the same provider — a model we do not offer, a dated
  // snapshot, a typo'd variant. Both routes have to work, or dropping a model from
  // a manifest would quietly reopen the hole for that whole family.
  const missed = allModels()
    .map((m) => m.id)
    .filter((id) => !MODEL_ID.test(id));
  assert.deepEqual(missed, [], `the shape pattern does not recognise:\n${missed.join("\n")}`);
});

test("no core source file names a concrete model id", () => {
  const offenders: string[] = [];
  for (const { path, rel } of coreFiles(SRC)) {
    // Tests legitimately use model ids as fixtures — they are exercising the
    // driver registry through core's API, not hardcoding a provider into behavior.
    if (rel.includes(".test.")) continue;
    const text = readFileSync(path, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (namesModel(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `core must not name a model id — move it to drivers/, or read it from the registry:\n${offenders.join("\n")}`,
  );
});
