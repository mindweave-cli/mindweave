/**
 * keyManager.probe.test.tsx — /key, rendered at each of its three levels.
 *
 * The screen is the feature: a list of keys you cannot read is not a manager. Rendered
 * into a fake terminal and read back, like every other UI claim here.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, Box } from "ink";
import { KeyManager } from "./components/KeyManager.js";
import { actionsFor, countLabel, type KeyRow, type ProviderRow } from "./keyManager.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 76,
    rows: 30,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  // KeyManager is content-only; the border is the shared menu box it renders inside (see
  // PromptInput). Wrap it the same way here so /key is exercised as it actually appears —
  // the same box the `/` command menu and every picker use.
  const app = render(
    <Box flexDirection="column" width={64} borderStyle="single" borderColor="gray" paddingX={1}>
      {node}
    </Box>,
    { stdout: stream, patchConsole: false, interactive: true },
  );
  app.unmount();
  // Styled text is unfindable with the codes left in: colour sits between the characters
  // of the very strings these tests look for.
  const ESC = String.fromCharCode(27);
  return out.join("").replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "");
}

const PROVIDERS: ProviderRow[] = [
  { id: "deepseek", label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", count: 2 },
  { id: "anthropic", label: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", count: 1 },
  { id: "gemini", label: "Gemini", apiKeyEnv: "GEMINI_API_KEY", count: 0 },
];

const DEEPSEEK_KEYS: KeyRow[] = [
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 1, hint: "…a4f2", active: true },
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 2, hint: "…9c1b", active: false },
];

function screen(): string {
  return frame(
    <KeyManager
      providers={PROVIDERS}
      keysOf={() => DEEPSEEK_KEYS}
      nextSlot={() => 3}
      reveal={() => "sk-full-secret-value"}
      width={64}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
    />,
  );
}

test("the first level is PROVIDERS, with how many keys each holds", () => {
  const out = screen();
  assert.match(out, /DeepSeek/);
  assert.match(out, /Anthropic/);
  assert.match(out, /2 keys/, "a provider with several keys does not say so");
  assert.match(out, /1 key\b/, "a provider with one key does not say so");
  // A provider with none is still listed — that is how the first key gets added.
  assert.match(out, /no key yet/, "a provider with no key is hidden, so it can never gain one");
});

test("counts read naturally at 0, 1 and many", () => {
  assert.equal(countLabel(0), "no key yet");
  assert.equal(countLabel(1), "1 key");
  assert.equal(countLabel(4), "4 keys");
});

test("it is a bordered panel, not a takeover of the screen", () => {
  // It sits where the prompt sits. Replacing the whole terminal to change a setting is
  // the wrong weight, and leaves nothing to come back to.
  const out = screen();
  assert.match(out, /[┌│└]/, "no panel border — this is rendering as a full screen");
  const lines = out.split(String.fromCharCode(10)).filter((l) => l.trim());
  assert.ok(lines.length <= 14, `the panel is ${lines.length} rows and is not a footer overlay`);
});

test("no key value is on screen until it is asked for", () => {
  assert.doesNotMatch(screen(), /sk-full-secret/, "a full key is shown without being asked for");
});

test("startProvider on an empty provider opens straight on the key field", () => {
  // Reached by picking a keyless provider in /provider: the pick is made, so the field
  // to add its key must appear, not the provider list asking to pick again.
  const gemini = PROVIDERS[2]!;
  const out = frame(
    <KeyManager
      providers={PROVIDERS}
      keysOf={() => []}
      nextSlot={() => 1}
      reveal={() => ""}
      width={64}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
      startProvider={gemini}
    />,
  );
  assert.match(out, /Gemini · add a key/, "did not open on the key field for the chosen provider");
  assert.match(out, /paste your key, then press Enter/, "the input field is not shown");
  assert.doesNotMatch(out, /Anthropic/, "the provider list is shown again instead of the field");
});

test("startProvider on a provider with keys opens on that provider's key list", () => {
  const deepseek = PROVIDERS[0]!;
  const out = frame(
    <KeyManager
      providers={PROVIDERS}
      keysOf={() => DEEPSEEK_KEYS}
      nextSlot={() => 3}
      reveal={() => ""}
      width={64}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
      startProvider={deepseek}
    />,
  );
  assert.match(out, /DeepSeek · 2 keys/, "did not open on the chosen provider's key list");
  assert.doesNotMatch(out, /Anthropic/, "the provider list is shown instead of the chosen provider");
});

test("the actions offered depend on the key, and adding never runs out", () => {
  const active = DEEPSEEK_KEYS[0]!;
  const spare = DEEPSEEK_KEYS[1]!;
  // An action that does nothing is worse than an absent one: the user tries it and
  // learns nothing.
  assert.ok(!actionsFor(active, 2).includes("Make this the active key"));
  assert.ok(actionsFor(spare, 2).includes("Make this the active key"));

  for (const a of ["Show the key", "Edit it", "Back"]) {
    assert.ok(actionsFor(active, 2).includes(a), `${a} is not offered`);
  }
  // Removing a provider's only key is allowed — it is how a wrong key gets corrected —
  // but the row says what it costs rather than refusing.
  assert.match(actionsFor(active, 1).join(" "), /only key/);
  assert.doesNotMatch(actionsFor(active, 2).join(" "), /only key/);
});

/**
 * The shared menu box as PromptInput actually declares it: a FIXED height that never
 * changes with what is inside, and clipped rather than grown. `frame` above lets the box
 * shrink to its contents, which is the one thing that must not be assumed here — a panel
 * that does not fill would still end on its hint in a box that shrank to meet it.
 */
function boxed(node: React.ReactElement, maxRows = 9): string {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 76,
    rows: 30,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(
    <Box
      flexDirection="column"
      width={64}
      height={maxRows + 4}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      overflow="hidden"
    >
      {node}
    </Box>,
    { stdout: stream, patchConsole: false, interactive: true },
  );
  app.unmount();
  return out.join("");
}

test("every level fills the box and ends on the hint, so the footer never moves", () => {
  // /key shares its box with the command list and the pickers, and that box is a FIXED
  // height. A level that renders only as many rows as it has content leaves the hint
  // floating wherever that content happened to end — a different place at each level, in a
  // box whose size never changed. Filling to the box's height puts the hint on the bottom
  // line every time, which is where the command list and every picker put theirs.
  const deepseek = PROVIDERS[0]!;
  const levels: Array<[string, React.ReactElement]> = [
    [
      "providers",
      <KeyManager
        providers={PROVIDERS}
        keysOf={() => DEEPSEEK_KEYS}
        nextSlot={() => 3}
        reveal={() => "sk"}
        width={64}
        maxRows={9}
        onActivate={() => {}}
        onSave={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        active={false}
      />,
    ],
    [
      "keys",
      <KeyManager
        providers={PROVIDERS}
        keysOf={() => DEEPSEEK_KEYS}
        nextSlot={() => 3}
        reveal={() => "sk"}
        width={64}
        maxRows={9}
        onActivate={() => {}}
        onSave={() => {}}
        onRemove={() => {}}
        onClose={() => {}}
        active={false}
        startProvider={deepseek}
      />,
    ],
  ];

  const heights = new Set<number>();
  for (const [name, node] of levels) {
    const rows = boxed(node)
      .replace(new RegExp(String.fromCharCode(27) + "\[[0-9;?]*[A-Za-z]", "g"), "")
      .split(/\r?\n/)
      .filter((r) => r.includes("│") || r.includes("┌") || r.includes("└"));
    heights.add(rows.length);
    const lastContent = rows[rows.length - 2] ?? "";
    assert.match(lastContent, /Enter to (choose|use)/, `${name}: the hint is not on the box's bottom line`);
  }
  assert.equal(heights.size, 1, "the levels render at different heights inside a fixed box");
});

test("the provider list fills the box budget instead of a fixed short window", () => {
  // /key used to cap its list at seven rows even in a box tall enough for a dozen, so a
  // long provider list showed seven and padded the rest of the box blank while every
  // other picker filled it. With maxRows set, the list uses the whole budget.
  const many: ProviderRow[] = Array.from({ length: 14 }, (_, i) => ({
    id: `p${i}`,
    label: `Provider${i}`,
    apiKeyEnv: `P${i}_KEY`,
    count: 0,
  }));
  const out = frame(
    <KeyManager
      providers={many}
      keysOf={() => []}
      nextSlot={() => 1}
      reveal={() => ""}
      width={64}
      maxRows={12}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
    />,
  );
  const shownCount = many.filter((p) => out.includes(p.label)).length;
  assert.ok(shownCount >= 11, `only ${shownCount} of 14 providers shown; the list is not using the box budget`);
});

test("labels and their status align in one column, whatever the row number's width", () => {
  // A one-digit number is one column and a two-digit number is two, so without reserving
  // the width the label after "10" sat a column right of the label after "3", and the
  // "no key yet" status shifted with it. The number is right-aligned to a fixed width so
  // every label starts at the same column.
  const many: ProviderRow[] = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`,
    label: `Prov${i}`,
    apiKeyEnv: `P${i}_KEY`,
    count: 0,
  }));
  const out = frame(
    <KeyManager
      providers={many}
      keysOf={() => []}
      nextSlot={() => 1}
      reveal={() => ""}
      width={64}
      maxRows={14}
      onActivate={() => {}}
      onSave={() => {}}
      onRemove={() => {}}
      onClose={() => {}}
      active={false}
    />,
  );
  const rows = out.split("\n").filter((r) => /no key yet/.test(r));
  // A single-digit row and a double-digit row.
  const single = rows.find((r) => /\bProv2\b/.test(r))!;
  const double = rows.find((r) => /\bProv11\b/.test(r))!;
  assert.ok(single && double, "both rows painted");
  assert.equal(single.indexOf("Prov2"), double.indexOf("Prov11"), "labels start in different columns");
  assert.equal(single.indexOf("no key yet"), double.indexOf("no key yet"), "the status column is not aligned");
});
