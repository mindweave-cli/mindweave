/**
 * firstRun.test.ts — what happens the very first time Mindweave is opened.
 *
 * No config, no key, no project state. It is the only path where a rough edge costs the
 * user everything, and it had never been tested: `startupArgs.test.ts` covers flag
 * parsing and stops there.
 *
 * The assertion that matters most is the negative one. The template writes a line per
 * provider, and a line like `DEEPSEEK_API_KEY=   # DeepSeek` reads perfectly well and
 * parses as a VALUE of "# DeepSeek" — so every provider reports a key it does not have,
 * no prompt is ever shown, and every request comes back rejected with nothing on screen
 * to explain why. That is a worse first run than having no template at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, globalEnvPath, hasApiKey } from "./bootstrap.js";
import { allProviders, manifestForModel } from "../drivers/registry.js";
import { DEFAULT_MODEL_CONFIG, needsKeySetup, usableFallback } from "../dynamo/model.js";

/** A machine that has never run Mindweave. */
function firstRun(): { env: string; text: string } {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mindweave-firstrun-"));
  for (const p of allProviders()) delete process.env[p.apiKeyEnv];
  loadConfig(mkdtempSync(join(tmpdir(), "mindweave-firstproj-")));
  const env = globalEnvPath();
  return { env, text: readFileSync(env, "utf8") };
}

test("a first run leaves a config template where the user can find it", () => {
  const { env, text } = firstRun();
  assert.ok(existsSync(env), "nothing was written, so there is nowhere to paste a key");
  assert.match(text, /Paste a key/i, "the file does not say what to do with it");
});

test("the template does NOT make every provider look configured", () => {
  // The whole point. A parsed value here means no key prompt and a rejected request.
  firstRun();
  const configured = allProviders().filter((p) => hasApiKey(p.apiKeyEnv));
  assert.deepEqual(
    configured.map((p) => `${p.label}=${process.env[p.apiKeyEnv]}`),
    [],
    "the template set keys nobody typed — the first run will fail with no explanation",
  );
});

test("every provider appears, by name, so a new user can find theirs", () => {
  const { text } = firstRun();
  for (const p of allProviders()) {
    // A local runtime (Ollama) has no key variable; it is named all the same.
    if (!p.local) assert.ok(text.includes(p.apiKeyEnv), `${p.label}'s key variable is missing`);
    // The variable alone is not enough: DASHSCOPE, ZAI and MODEL_API_KEY name nothing a
    // user would recognise as Qwen, GLM or Meta.
    assert.ok(text.includes(p.label), `${p.label} is not named, only its variable`);
  }
});

test("config and state resolve to the SAME relocatable place", () => {
  // They were computed by two different functions and only one honoured the override, so
  // a relocated Mindweave moved its sessions and left the config in the real home — and
  // the test suite wrote a config file into the developer's own ~/.mindweave.
  const root = mkdtempSync(join(tmpdir(), "mindweave-both-"));
  process.env.MINDWEAVE_STATE_DIR = root;
  loadConfig(mkdtempSync(join(tmpdir(), "mindweave-p2-")));
  assert.ok(
    globalEnvPath().startsWith(root),
    `config went to ${globalEnvPath()} while state went to ${root}`,
  );
});


// ── the gate that decides whether the app opens at all ───────────────────────

const DEFAULT_MODEL = DEFAULT_MODEL_CONFIG.model;
const keys = (...set: string[]) => (envVar: string) => set.includes(envVar);

test("a machine with NO key is asked for one", () => {
  assert.equal(needsKeySetup(DEFAULT_MODEL, () => false), true);
});

test("a key for the DEFAULT provider opens the app", () => {
  const theDefault = manifestForModel(DEFAULT_MODEL).apiKeyEnv;
  assert.equal(needsKeySetup(DEFAULT_MODEL, keys(theDefault)), false);
});

test("a key for ANY other provider opens the app too", () => {
  // The dead end: the gate asked about the default provider alone, so someone arriving
  // with a key for one of the other twelve was shown a prompt for a provider they never
  // chose — and the escape is only offered when a switch is pending mid-session, so on
  // first run there was no way past it at all.
  const theDefault = manifestForModel(DEFAULT_MODEL).apiKeyEnv;
  // A local runtime counts as connected only once discovery found models, which a key-shaped
  // stand-in cannot fake; ollama.test.ts covers it.
  const others = allProviders().filter((p) => p.apiKeyEnv !== theDefault && !p.local);
  assert.ok(others.length > 0, "there is only one provider — this test proves nothing");
  for (const p of others) {
    assert.equal(
      needsKeySetup(DEFAULT_MODEL, keys(p.apiKeyEnv)),
      false,
      `a user holding only a ${p.label} key is still locked out`,
    );
    // And the app has somewhere to send them.
    assert.ok(usableFallback(DEFAULT_MODEL, keys(p.apiKeyEnv)), `nothing runnable found for ${p.label}`);
  }
});

/**
 * A React/Ink hook call. Named one by one rather than by the `use[A-Z]` convention: this
 * file also calls plain helpers like `useApiKey` (make this stored key the live one),
 * which follow the same spelling and are not hooks.
 */
const HOOK_CALL =
  /(?:^|[^.\w])(useState|useEffect|useLayoutEffect|useMemo|useRef|useCallback|useReducer|useContext|useTransition|useDeferredValue|useSyncExternalStore|useImperativeHandle|useId|useInput|useApp|useStdin|useStdout|useStderr|useFocus|useFocusManager)\s*\(/;

test("no hook is declared below the first-run gates in App.tsx", () => {
  // The crash that took the first run down, as a source rule the next edit cannot miss.
  //
  // App returns EARLY for the trust gate and the key setup screen. A hook declared after
  // those returns runs only on the renders that reach the chat, so the render right after
  // the user pressed Continue had one MORE hook than the render before it — "Rendered more
  // hooks than during the previous render", which unmounts the whole app. On screen that
  // is the terminal going blank the moment a key is accepted, and a restart hides it: the
  // second launch never opens the gate, so the count never changes.
  //
  // Rendering cannot catch this cheaply — it needs the full App driven through a gate — so
  // the rule is enforced where it is written instead.
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("---- NO HOOKS BELOW THIS LINE ----"));
  assert.notEqual(start, -1, "the marker above the first-run gates is gone — put it back");
  const end = lines.findIndex((l, i) => i > start && l === "}");
  const offenders = lines
    .slice(start + 1, end)
    .map((line, i) => ({ line, n: start + 2 + i }))
    .filter(({ line }) => HOOK_CALL.test(line) && !line.trimStart().startsWith("//"));
  assert.deepEqual(
    offenders.map((o) => `App.tsx:${o.n}: ${o.line.trim()}`),
    [],
    "a hook below the gates changes the hook count when a gate closes — React crashes the app",
  );
});
