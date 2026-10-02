/**
 * KeyManager.tsx — what /key shows.
 *
 * A FOOTER OVERLAY, not a screen: it sits where the prompt sits, the conversation stays
 * visible above it, and it is only as tall as it needs to be. Taking the whole terminal
 * to change a setting is the wrong weight and leaves nothing to come back to.
 *
 * Three levels, drilling in. PROVIDERS, then that provider's KEYS with an "add another"
 * that never runs out, then what can be done to one key. The first version was a flat
 * list of every key across every provider, which buried the thing people came to do.
 *
 * Esc always goes back one level, INCLUDING while typing a key — a field that can only
 * be left by submitting nothing is a trap.
 */
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { stripMouse } from "../mouse.js";
import {
  ACTION_ACTIVATE,
  ACTION_BACK,
  ACTION_EDIT,
  ACTION_REMOVE,
  ACTION_SHOW,
  actionsFor,
  countLabel,
  type KeyRow,
  type ProviderRow,
} from "../keyManager.js";
import { MiniTabPanel as Panel, MiniTabRow as Row, miniTabPosition as position, miniTabWindowStart as windowStart, MINITAB_WINDOW as WINDOW } from "./minitabs.js";
import { ACCENT, GOOD, WARN } from "../theme.js";

export { windowStart };

type Mode =
  | { kind: "providers" }
  | { kind: "keys"; provider: ProviderRow }
  | { kind: "actions"; provider: ProviderRow; row: KeyRow }
  | { kind: "enter"; provider: ProviderRow; slot: number; replacing: boolean };

export interface KeyManagerProps {
  providers: ProviderRow[];
  /** One provider's keys, read fresh so the list reflects the last edit. */
  keysOf: (provider: ProviderRow) => KeyRow[];
  /** Where the next key would go, or null when the provider is full. */
  nextSlot: (provider: ProviderRow) => number | null;
  /** The full value of a key, only ever called when the user asks to see it. */
  reveal: (row: KeyRow) => string;
  width: number;
  onActivate: (row: KeyRow) => void;
  onSave: (provider: ProviderRow, slot: number, key: string) => void;
  onRemove: (row: KeyRow) => void;
  onClose: () => void;
  active?: boolean;
  /**
   * Open straight on this provider instead of the provider list. Set when the manager is
   * reached by picking a provider that has no key: the pick is already made, so showing
   * the list again and asking for it a second time is the pick wasted.
   */
  startProvider?: ProviderRow | null;
  /**
   * The shared menu box's item-row budget. The manager renders inside a box of FIXED height,
   * so its list window is sized to fit (leaving a row for the title, one blank, and the hint)
   * and scrolls when there are more — the box never grows.
   */
  maxRows?: number;
}

export function KeyManager({
  providers,
  keysOf,
  nextSlot,
  reveal,
  width,
  onActivate,
  onSave,
  onRemove,
  onClose,
  active = true,
  startProvider = null,
  maxRows = WINDOW,
}: KeyManagerProps) {
  // Rows for the list: the box holds maxRows+2 content rows; the title and the hint (which
  // carries a blank top margin, so two rows) take three, leaving maxRows - 1 for the list
  // (never fewer than 2). It scrolls when there are more; the box never grows.
  //
  // The whole budget is used, NOT capped at `WINDOW`. Capping it meant the box was sized
  // to `maxRows` and then only `WINDOW` of it was ever filled — a provider list with
  // fourteen entries showed seven and left the lower half of the box blank, while every
  // other picker in the same box filled it. `WINDOW` stays only as the fallback height
  // for a caller that passes no budget at all.
  const win = Math.max(2, maxRows - 1);
  const [mode, setMode] = useState<Mode>(() => {
    // Same drill-in the provider list does on Enter: an empty provider goes straight to
    // the field, one with keys goes to its key list.
    if (startProvider) {
      const slot = nextSlot(startProvider);
      if (startProvider.count === 0 && slot !== null) return { kind: "enter", provider: startProvider, slot, replacing: false };
      return { kind: "keys", provider: startProvider };
    }
    return { kind: "providers" };
  });
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState<string | null>(null);

  const keys = mode.kind === "keys" || mode.kind === "actions" ? keysOf(mode.provider) : [];
  const actions = mode.kind === "actions" ? actionsFor(mode.row, keys.length) : [];
  // "Add a new key" is one more row after the keys, and it is there however many there
  // already are — that is what makes adding a second, or a fifth, obvious.
  const canAdd = mode.kind === "keys" ? nextSlot(mode.provider) !== null : false;

  const count =
    mode.kind === "providers"
      ? providers.length
      : mode.kind === "keys"
        ? keys.length + (canAdd ? 1 : 0)
        : mode.kind === "actions"
          ? actions.length
          : 0;

  function back() {
    setShown(null);
    setValue("");
    setSel(0);
    if (mode.kind === "providers") onClose();
    else if (mode.kind === "keys") setMode({ kind: "providers" });
    else setMode({ kind: "keys", provider: mode.provider });
  }

  useInput(
    (input, key) => {
      if (key.escape) return back();
      // Backspace and Delete step back exactly as Escape does. Deleting what you just chose
      // is the instinctive way out, and while a list is showing there is nothing else those
      // keys could mean; in the entry field they belong to the key being typed, and while a
      // list is empty stepping back is the only thing left to do.
      if ((key.backspace || key.delete) && mode.kind !== "enter") return back();
      if (mode.kind === "enter" || count === 0) return;
      if (key.upArrow) setSel((s) => (s - 1 + count) % count);
      else if (key.downArrow) setSel((s) => (s + 1) % count);
      else if (key.return) commit(sel);
      else {
        // One keypress commits, so only single digits ever arrive here.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) commit(n - 1);
      }
    },
    { isActive: active },
  );

  function commit(index: number) {
    setShown(null);
    if (mode.kind === "providers") {
      const provider = providers[index];
      if (!provider) return;
      setSel(0);
      // A provider with no keys goes straight to the field: there is no list to show, and
      // one more press to reach the only thing you could have wanted is a press wasted.
      const slot = nextSlot(provider);
      if (provider.count === 0 && slot !== null) return setMode({ kind: "enter", provider, slot, replacing: false });
      return setMode({ kind: "keys", provider });
    }
    if (mode.kind === "keys") {
      if (index === keys.length) {
        const slot = nextSlot(mode.provider);
        if (slot === null) return;
        setValue("");
        return setMode({ kind: "enter", provider: mode.provider, slot, replacing: false });
      }
      const row = keys[index];
      if (!row) return;
      setSel(0);
      return setMode({ kind: "actions", provider: mode.provider, row });
    }
    if (mode.kind === "actions") {
      const chosen = actions[index] ?? ACTION_BACK;
      if (chosen === ACTION_SHOW) return setShown(reveal(mode.row));
      if (chosen === ACTION_EDIT) {
        setValue("");
        return setMode({ kind: "enter", provider: mode.provider, slot: mode.row.slot, replacing: true });
      }
      setSel(0);
      if (chosen === ACTION_ACTIVATE) onActivate(mode.row);
      else if (chosen.startsWith(ACTION_REMOVE)) onRemove(mode.row);
      return setMode({ kind: "keys", provider: mode.provider });
    }
  }

  if (mode.kind === "enter") {
    return (
      <Panel
        title={`${mode.replacing ? "Edit the" : "Add a"} ${mode.provider.label} key${mode.replacing ? ` (key ${mode.slot})` : ""}`}
        rows={1}
        maxRows={maxRows}
        width={width}
        hint="Enter to save · Esc to go back"
      >
        <Box flexShrink={0}>
          <Text bold color={ACCENT}>{"  key "}</Text>
          <TextInput
            value={value}
            // Mouse reports arrive at a focused field as TYPED TEXT once wheel reporting
            // is on, so scrolling while pasting fills the field with escape sequences and
            // the key fails later in a way that looks like the key itself is wrong.
            onChange={(v) => setValue(stripMouse(v))}
            onSubmit={(v) => {
              const key = v.trim();
              if (key) onSave(mode.provider, mode.slot, key);
              setValue("");
              setSel(0);
              setMode({ kind: "keys", provider: mode.provider });
            }}
            placeholder="paste, then press Enter"
            mask="*"
          />
        </Box>
      </Panel>
    );
  }

  if (mode.kind === "actions") {
    return (
      <Panel
        title={`${mode.provider.label} · key ${mode.row.slot}  ${mode.row.hint}${mode.row.active ? "   ● active" : ""}`}
        rows={actions.length + (shown ? 2 : 0)}
        maxRows={maxRows}
        width={width}
        hint={shown ? "hidden again when you leave · Esc or ⌫  back" : "↑/↓ · Enter to choose · Esc or ⌫  back"}
      >
        {actions.map((a, i) => (
          <Row key={a} on={i === sel} n={i + 1} left={a} width={width} />
        ))}
        {shown ? (
          <Box flexShrink={0} marginTop={1}>
            <Text color={WARN} wrap="truncate-end">{`  ${shown}`}</Text>
          </Box>
        ) : null}
      </Panel>
    );
  }

  if (mode.kind === "keys") {
    const start = windowStart(sel, count, win);
    const addRow = canAdd && start + win > keys.length;
    return (
      <Panel
        title={`${mode.provider.label} · ${countLabel(keys.length)}`}
        counter={position(sel, count, win)}
        rows={Math.min(win, keys.length - start) + (addRow ? 1 : 0)}
        maxRows={maxRows}
        width={width}
        hint="↑/↓ · Enter to choose · Esc or ⌫  back"
      >
        {keys.slice(start, start + win).map((r, i) => (
          <Row
            key={r.slot}
            on={start + i === sel}
            n={start + i + 1}
            numWidth={String(keys.length + 1).length}
            left={`key ${r.slot}`}
            mid={r.hint}
            right={r.active ? "● active" : ""}
            rightColor={r.active ? GOOD : undefined}
            width={width}
          />
        ))}
        {addRow ? <Row on={sel === keys.length} n={keys.length + 1} numWidth={String(keys.length + 1).length} left="Add a new key" width={width} /> : null}
      </Panel>
    );
  }

  const start = windowStart(sel, providers.length, win);
  return (
    <Panel
      title="Keys"
      counter={position(sel, providers.length, win)}
      rows={Math.min(win, providers.length - start)}
      maxRows={maxRows}
      width={width}
      hint="↑/↓ · Enter to choose · Esc or ⌫  close"
    >
      {providers.slice(start, start + win).map((p, i) => (
        <Row
          key={p.id}
          on={start + i === sel}
          n={start + i + 1}
          numWidth={String(providers.length).length}
          left={p.label}
          right={countLabel(p.count)}
          rightColor={p.count > 0 ? GOOD : undefined}
          width={width}
        />
      ))}
    </Panel>
  );
}
