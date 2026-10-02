/**
 * keySetup.probe.test.tsx — the first screen, rendered.
 *
 * This is the one screen every new user sees before anything else works, and a
 * typecheck says nothing about what reaches the terminal. Rendered to a fake stream and
 * read back, the way every other UI claim in this codebase is checked.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { KeySetup, layoutFor } from "./components/KeySetup.js";
import { setupView } from "./keySetup.js";
import { allProviders } from "../drivers/registry.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 90,
    rows: 40,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false, interactive: true });
  app.unmount();
  return out.join("");
}

/** The first-run screen at a given terminal height. */
const frameAt = (rows: number) =>
  frame(
    <KeySetup
      rows={rows}
      view={setupView(() => false)}
      version=" v1.0.0"
      envPath="~/.mindweave/.env"
      docsUrl="https://example.invalid/docs"
      onSaveKey={() => {}}
      onContinue={() => {}}
      active={false}
    />,
  );

const screen = (hasKey: (v: string) => boolean) =>
  frame(
    <KeySetup
      rows={30}
      view={setupView(hasKey)}
      version=" v1.0.0"
      envPath="~/.mindweave/.env"
      docsUrl="https://example.invalid/docs"
      onSaveKey={() => {}}
      onContinue={() => {}}
      active={false}
    />,
  );

test("a brand new user is offered providers, not one hardcoded name", () => {
  const out = screen(() => false);
  // The first window of providers, numbered and pickable.
  const first = allProviders()[0]!;
  assert.ok(out.includes(first.label), "the provider list is not on screen");
  assert.match(out, /1\s+DeepSeek/, "the list is not numbered for quick picking");
  assert.match(out, /Welcome/i, "a first-time user is not greeted");
});

test("Continue is offered but visibly unavailable until a key exists", () => {
  const empty = screen(() => false);
  assert.match(empty, /Continue/, "there is no visible way out of setup");
  assert.match(empty, /add a key first/i, "Continue looks available when it is not");

  const ready = screen((v) => v === allProviders()[0]!.apiKeyEnv);
  assert.match(ready, /Continue →\s+start chatting/, "Continue never becomes available");
  assert.doesNotMatch(ready, /add a key first/i, "Continue still says a key is needed");
});

test("a provider already set up is marked, so adding more is obvious", () => {
  const first = allProviders()[0]!;
  const out = screen((v) => v === first.apiKeyEnv);
  assert.match(out, /key added/, "a saved key leaves no trace on the screen");
  // NAMED, because the list scrolls and the provider just added is often off-screen —
  // a count tells the user a number when the question is "which one".
  assert.match(out, new RegExp(`Ready: ${first.label}`), "the user is not told WHICH provider is ready");
});

test("the screen never exceeds the terminal, and says what is off it", () => {
  // Thirteen providers plus the welcome, the tips and Continue do not fit a short
  // window, and Continue lives at the BOTTOM — clipping it would hide the way out. The
  // list shrinks to the height available instead.
  for (const rows of [20, 24, 26, 30, 34, 38, 40, 50]) {
    const out = frameAt(rows);
    const lines = out.split(String.fromCharCode(10)).length - 1;
    assert.ok(lines <= rows, `at ${rows} rows the screen rendered ${lines} and will be clipped`);
    assert.match(out, /Continue/, `Continue is off screen at ${rows} rows`);
  }
  assert.match(frameAt(24), /more below/, "providers are cut off with nothing saying so");
});

test("a normal terminal shows EVERY provider at once, not the first nine", () => {
  // The list was capped at nine rows, so with sixteen providers on the books a new user saw
  // a slice and reasonably concluded the rest were not supported. When the height allows,
  // all of them are on screen; the welcome tips give way before any provider does.
  const keyed = allProviders().filter((p) => !p.local);
  for (const rows of [38, 40, 50]) {
    const out = frameAt(rows);
    for (const p of keyed) assert.ok(out.includes(p.label), `${p.label} is not on screen at ${rows} rows`);
    assert.doesNotMatch(out, /more below|more above/, `at ${rows} rows the list still scrolls`);
  }
  // A shorter terminal that cannot hold them all drops the tips first, and lists as many as fit.
  const mid = frameAt(34);
  for (const p of keyed) assert.ok(mid.includes(p.label), `${p.label} is not on screen at 34 rows`);
  assert.doesNotMatch(mid, /Esc to quit|four tips/i);
});

test("layoutFor: all providers when they fit, scrolling only when they cannot", () => {
  assert.deepEqual(layoutFor(50, 15, true), { win: 15, tips: true });
  assert.equal(layoutFor(34, 15, true).win, 15);
  assert.equal(layoutFor(34, 15, true).tips, false, "tips must give way before providers do");
  const short = layoutFor(24, 15, true);
  assert.ok(short.win < 15 && short.win >= 4, "a short terminal scrolls a bounded window");
  assert.equal(layoutFor(24, 15, false).win >= 4, true);
});

test("a first run tells Ollama users they need no key", () => {
  assert.match(frameAt(40), /Ollama needs no key/);
});

test("every provider is reachable by name somewhere in setup", () => {
  // Not all at once — the list scrolls — but the LIST must contain them all.
  // A local runtime (Ollama) takes no key, so it is no row to fill in.
  const keyed = allProviders().filter((p) => !p.local);
  const view = setupView(() => false);
  assert.equal(view.rows.length, keyed.length);
  for (const p of keyed) {
    assert.ok(view.rows.some((r) => r.label === p.label && r.envVar === p.apiKeyEnv), `${p.label} is missing`);
  }
});


test("the number shortcut it advertises is one it actually has", () => {
  // A single keypress commits, so a two-digit row can never be typed: "1" picks row 1
  // before the second key arrives. The footer used to promise the full range, which was
  // a shortcut four providers did not have — Gemini among them.
  const out = screen(() => false);
  const promised = out.match(/1-(\d+) to jump/);
  assert.ok(promised, "the screen no longer says which numbers work");
  assert.ok(Number(promised![1]) <= 9, `it promises 1-${promised![1]}, but only single digits can be typed`);
  // And the rest are still reachable, which is what makes 1-9 honest rather than a limit.
  assert.match(out, /↑\/↓ to move/, "there is no way to reach the rows without a number");
});


test("a first run has no escape; /key does", () => {
  // Opposite defaults on purpose. On a first run there is nothing behind the screen to
  // go back to, so an escape would only reach an app that cannot answer. Reopened
  // deliberately to fix a key, leaving without changing anything is the whole point.
  const firstRun = frame(
    <KeySetup rows={30} view={setupView(() => false)} version=" v1" envPath="~/.mindweave/.env"
      docsUrl="d" onSaveKey={() => {}} onContinue={() => {}} active={false} />,
  );
  assert.doesNotMatch(firstRun, /Esc to leave/, "a first run offers an exit to an app that cannot run");

  const reopened = frame(
    <KeySetup rows={30} view={setupView(() => true)} version=" v1" envPath="~/.mindweave/.env"
      docsUrl="d" onSaveKey={() => {}} onContinue={() => {}} onCancel={() => {}} active={false} />,
  );
  assert.match(reopened, /Esc to leave/, "/key traps the user in the setup screen");
});

test("a provider that already has a key can still be chosen, to replace it", () => {
  // The reason /key exists: a mistyped key is the commonest way a first run dies, and
  // before this the only fix was editing ~/.mindweave/.env by hand.
  const view = setupView(() => true);
  assert.ok(view.rows.every((r) => r.ready));
  assert.equal(view.canContinue, true);
  const out = frame(
    <KeySetup rows={30} view={view} version=" v1" envPath="~/.mindweave/.env" docsUrl="d"
      onSaveKey={() => {}} onContinue={() => {}} onCancel={() => {}} active={false} />,
  );
  // Every row is still listed and selectable — nothing is greyed out just for being set.
  assert.match(out, /key added/);
  assert.match(out, /1\s+DeepSeek/);
});


test("Esc leaves the key field, not just the list", () => {
  // Choosing a provider and then finding no way back is the trap people hit
  // immediately. Asserted on the KEY HANDLER rather than the pixels, since what matters
  // is that escape is reachable while the text field owns the keyboard.
  const src = readFileSync(join(here, "components/KeySetup.tsx"), "utf8");
  const handler = src.slice(src.indexOf("useInput("), src.indexOf("{ isActive"));
  const escAt = handler.indexOf("key.escape");
  const guardAt = handler.indexOf("if (entering) return");
  assert.ok(escAt >= 0, "escape is not handled at all");
  assert.ok(escAt < guardAt || guardAt === -1, "escape is handled AFTER the field takes the keyboard, so it never fires");
  assert.match(src, /\{ isActive: active \}/, "the handler is switched off while the field is open");
  // And the screen says so, rather than relying on a rule nobody would guess.
  assert.match(src, /Esc to go back/, "the way out is not written on the screen");
});
