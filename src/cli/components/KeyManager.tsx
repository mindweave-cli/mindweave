/**
 * KeyManager.tsx — what /provider and /key show: the providers and their keys, as one screen with two tabs.
 *
 * A FOOTER OVERLAY, not a screen: it sits where the prompt sits, the conversation stays
 * visible above it, and it is only as tall as it needs to be.
 *
 *   [1] PROVIDERS  every provider, what it offers and whether it is ready. Enter uses it (a provider with no key goes straight
 *                  to adding one, and is used as soon as the key is saved). → opens its keys.
 *   [2] KEYS       the highlighted provider's keys, with an "add another" that never runs out, then what can be done to one key.
 *
 * Esc always goes back one level, INCLUDING while typing a key — a field that can only
 * be left by submitting nothing is a trap.
 */
import { Box, Text, useInput } from "ink";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { matchesWords, wordsOf } from "../commandArgs.js";
import { stripMouse } from "../mouse.js";
import { setPickerSearchActive, setPickerSearchText } from "../pickerSearch.js";
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
import { BoxField } from "./EndpointBox.js";
import { MiniTabPanel as Panel, MiniTabRow as Row, miniTabPosition as position, miniTabWindowStart as windowStart, MINITAB_WINDOW as WINDOW } from "./minitabs.js";
import { GOOD, WARN } from "../theme.js";

export { windowStart };

type Mode =
  | { kind: "providers" }
  | { kind: "keys"; provider: ProviderRow }
  | { kind: "actions"; provider: ProviderRow; row: KeyRow }
  // A server on this computer or an address: its settings are the second tab, drawn by the caller.
  | { kind: "setup"; provider: ProviderRow }
  // `thenUse`: reached by choosing a provider that has no key, so the provider is used as soon as the key is saved.
  | { kind: "enter"; provider: ProviderRow; slot: number; replacing: boolean; thenUse: boolean };

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
  /** Use this provider (Enter on the provider list). The caller closes the manager and switches, or says why it cannot. */
  onUse?: (provider: ProviderRow) => void;
  /**
   * The settings of a provider that has no keys to manage (a server on this computer, a custom endpoint), drawn as the second tab.
   * Null when the provider has none. `back` returns to the provider list; `tabs` and `titleWidth` keep the tab bar in place.
   */
  setupTab?: (provider: ProviderRow, back: () => void, tabs: { active: boolean }[], titleWidth: number) => ReactNode | null;
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

/** Where a key is kept, said in the key field and under a provider's keys. */
const KEY_FILE = "~/.mindweave/.env";

/** The title column is a fixed width so the tab bar lands in the same place on every screen. */
const TITLE_WIDTH = 34;

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
  onUse,
  setupTab,
  active = true,
  startProvider = null,
  maxRows = WINDOW,
}: KeyManagerProps) {
  // Rows for the list: the box holds maxRows+2 content rows; the title and the hint (which
  // carries a blank top margin, so two rows) take three, leaving maxRows - 1 for the list
  // (never fewer than 2). It scrolls when there are more; the box never grows.
  const win = Math.max(2, maxRows - 1);
  const [mode, setMode] = useState<Mode>(() => {
    // Same drill-in the provider list does on Enter: an empty provider goes straight to
    // the field, one with keys goes to its key list.
    if (startProvider) {
      const slot = nextSlot(startProvider);
      if (startProvider.count === 0 && slot !== null) return { kind: "enter", provider: startProvider, slot, replacing: false, thenUse: false };
      return { kind: "keys", provider: startProvider };
    }
    return { kind: "providers" };
  });
  const [sel, setSel] = useState(0);
  // The words typed to find a provider. They are drawn in the input box (see pickerSearch.ts),
  // and only the provider list is a search: the screens under it are not.
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  // Where the caret is within what is typed, in characters.
  const [cursor, setCursor] = useState(0);
  const [shown, setShown] = useState<string | null>(null);

  const keys = mode.kind === "keys" || mode.kind === "actions" ? keysOf(mode.provider) : [];
  const actions = mode.kind === "actions" ? actionsFor(mode.row, keys.length) : [];
  // "Add a new key" is one more row after the keys, and it is there however many there
  // already are — that is what makes adding a second, or a fifth, obvious.
  const canAdd = mode.kind === "keys" ? nextSlot(mode.provider) !== null : false;

  // The providers that match what was typed, by name, by what they say about themselves, or by id.
  const found = (() => {
    const words = wordsOf(query);
    return words.length === 0 ? providers : providers.filter((p) => matchesWords(words, p.label, p.status ?? countLabel(p.count), p.id));
  })();

  const searching = mode.kind === "providers";
  useLayoutEffect(() => {
    setPickerSearchActive(searching);
    setPickerSearchText(searching ? query : "");
  }, [searching, query]);
  useLayoutEffect(
    () => () => {
      setPickerSearchText("");
      setPickerSearchActive(true);
    },
    [],
  );

  const count =
    mode.kind === "providers"
      ? found.length
      : mode.kind === "keys"
        ? keys.length + (canAdd ? 1 : 0)
        : mode.kind === "actions"
          ? actions.length
          : 0;

  function openField(next: Extract<Mode, { kind: "enter" }>) {
    setValue("");
    setCursor(0);
    setMode(next);
  }

  function back() {
    setShown(null);
    setValue("");
    setCursor(0);
    setSel(0);
    // Opened straight onto a provider (a pick elsewhere already named it), there is no list of providers behind it that
    // was ever shown, so Esc must not walk the person through screens they never opened: it closes.
    const direct = startProvider !== null;
    if (mode.kind === "providers") onClose();
    else if (mode.kind === "keys") direct ? onClose() : setMode({ kind: "providers" });
    else if (mode.kind === "setup") setMode({ kind: "providers" });
    else if (mode.kind === "enter" && direct && keysOf(mode.provider).length === 0) onClose();
    // A provider with no keys has no key list worth showing: the field came from the provider list, so back goes there.
    else if (mode.kind === "enter" && (mode.thenUse || keysOf(mode.provider).length === 0)) setMode({ kind: "providers" });
    else setMode({ kind: "keys", provider: mode.provider });
  }

  function save(text: string) {
    if (mode.kind !== "enter") return;
    const key = text.trim();
    setValue("");
    setCursor(0);
    setSel(0);
    if (key) onSave(mode.provider, mode.slot, key);
    // Chosen as "use this provider" and the key is in: it is used now, and the caller closes this.
    if (key && mode.thenUse) return onUse?.(mode.provider);
    setMode(mode.thenUse || (!key && keysOf(mode.provider).length === 0) ? { kind: "providers" } : { kind: "keys", provider: mode.provider });
  }

  useInput(
    (raw, key) => {
      // Wheel reports arrive as typed text once reporting is on; they are not keystrokes.
      const input = stripMouse(raw);
      if (input === "" && raw !== "") return;

      // The key field: edited the way the chat's own input is.
      if (mode.kind === "enter") {
        if (key.escape) return back();
        if (key.return) return save(value);
        // With nothing typed there is no caret to move, so ← and Backspace leave the field, as Esc does.
        if (value === "" && (key.leftArrow || key.backspace || key.delete)) return back();
        if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
        if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
        if (key.ctrl && input === "a") return setCursor(0);
        if (key.ctrl && input === "e") return setCursor(value.length);
        if (key.ctrl && input === "u") {
          setValue(value.slice(cursor));
          return setCursor(0);
        }
        if (key.backspace || key.delete) {
          if (cursor === 0) return;
          setValue(value.slice(0, cursor - 1) + value.slice(cursor));
          return setCursor(cursor - 1);
        }
        // A pasted key can carry line breaks and other control characters, which have no place in a one-line field.
        const text = input.replace(/[\u0000-\u001f\u007f]/g, "");
        if (text && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
          setValue(value.slice(0, cursor) + text + value.slice(cursor));
          setCursor(cursor + text.length);
        }
        return;
      }

      // On the provider list, Esc takes the search away first and only then goes back, and
      // Backspace edits it. With nothing typed both do what they always did.
      if (mode.kind === "providers" && query) {
        if (key.escape) {
          setQuery("");
          setSel(0);
          return;
        }
        if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          setSel(0);
          return;
        }
      }
      if (key.escape) return back();
      // Backspace and Delete step back exactly as Escape does: there is nothing else those keys could mean in a list.
      if (key.backspace || key.delete) return back();
      // ← goes back a level too, from the keys tab to the providers.
      if (key.leftArrow && mode.kind !== "providers") return back();
      // → on a provider opens its keys (or its own settings, for one that has none).
      if (key.rightArrow && mode.kind === "providers") {
        const provider = found[sel];
        if (!provider) return;
        return openKeys(provider);
      }
      // Typing on the provider list is a search. A single digit with nothing typed yet is
      // still the shortcut for that row, as it was; once there are words, digits are part of them.
      if (mode.kind === "providers" && !key.upArrow && !key.downArrow && !key.return) {
        const n = Number.parseInt(input, 10);
        if (!query && Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) return commit(n - 1);
        if (input && !key.ctrl && !key.meta && !key.tab && !/[\u0000-\u001f]/.test(input)) {
          setQuery((q) => q + input);
          setSel(0);
          return;
        }
      }
      if (count === 0) return;
      if (key.upArrow) setSel((s) => (s - 1 + count) % count);
      else if (key.downArrow) setSel((s) => (s + 1) % count);
      else if (key.return) commit(sel);
      else {
        // One keypress commits, so only single digits ever arrive here.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) commit(n - 1);
      }
    },
    { isActive: active && mode.kind !== "setup" },
  );

  /** The keys tab for a provider; one with no keys goes straight to the field, there being no list to show. */
  function openKeys(provider: ProviderRow) {
    setShown(null);
    setSel(0);
    setQuery("");
    // A server on this computer or an address has no keys to list: its settings are the tab.
    if (setupTab?.(provider, () => undefined, [], 0)) return setMode({ kind: "setup", provider });
    const slot = nextSlot(provider);
    if (provider.count === 0 && slot !== null) return openField({ kind: "enter", provider, slot, replacing: false, thenUse: false });
    setMode({ kind: "keys", provider });
  }

  function commit(index: number) {
    setShown(null);
    if (mode.kind === "providers") {
      const provider = found[index];
      if (!provider) return;
      // A provider that takes a key and has none: adding one is the next step, and it is used once the key is in.
      const slot = nextSlot(provider);
      if ((provider.kind ?? "key") === "key" && provider.count === 0 && slot !== null) {
        setSel(0);
        setQuery("");
        return openField({ kind: "enter", provider, slot, replacing: false, thenUse: onUse !== undefined });
      }
      // One that is not ready and is set up by an address goes to its settings: that is what it needs next.
      if (provider.kind !== "key" && provider.kind !== undefined && !provider.ready && setupTab?.(provider, () => undefined, [], 0)) {
        setSel(0);
        setQuery("");
        return setMode({ kind: "setup", provider });
      }
      // Anything else is used right away (the caller says why when it cannot be), and with no way to use it, it opens its keys.
      if (onUse) return onUse(provider);
      return openKeys(provider);
    }
    if (mode.kind === "keys") {
      if (index === keys.length) {
        const slot = nextSlot(mode.provider);
        if (slot === null) return;
        return openField({ kind: "enter", provider: mode.provider, slot, replacing: false, thenUse: false });
      }
      const row = keys[index];
      if (!row) return;
      setSel(0);
      return setMode({ kind: "actions", provider: mode.provider, row });
    }
    if (mode.kind === "actions") {
      const chosen = actions[index] ?? ACTION_BACK;
      if (chosen === ACTION_SHOW) return setShown(reveal(mode.row));
      if (chosen === ACTION_EDIT) return openField({ kind: "enter", provider: mode.provider, slot: mode.row.slot, replacing: true, thenUse: false });
      setSel(0);
      if (chosen === ACTION_ACTIVATE) onActivate(mode.row);
      else if (chosen.startsWith(ACTION_REMOVE)) onRemove(mode.row);
      return setMode({ kind: "keys", provider: mode.provider });
    }
  }

  const tabs = [{ active: mode.kind === "providers" }, { active: mode.kind !== "providers" }];

  if (mode.kind === "setup") {
    const box = setupTab?.(mode.provider, () => {
      setSel(0);
      setMode({ kind: "providers" });
    }, tabs, TITLE_WIDTH);
    if (box) return <>{box}</>;
  }

  if (mode.kind === "enter") {
    const p = mode.provider;
    const old = mode.replacing ? keysOf(p).find((k) => k.slot === mode.slot) : undefined;
    const lines = [
      p.keysUrl ? `  Get a key at ${p.keysUrl}` : `  Paste the key for ${p.label}`,
      old
        ? `  This replaces key ${old.slot} (${old.hint}).`
        : mode.thenUse
          ? `  ${p.label} is used as soon as the key is saved.`
          : keysOf(p).length > 0
            ? `  It is added beside the keys ${p.label} already has.`
            : "",
    ].filter(Boolean);
    return (
      <Panel
        title={`${p.label} · ${mode.replacing ? "edit key" : "add a key"}`}
        tabs={tabs}
        titleWidth={TITLE_WIDTH}
        rows={lines.length + 4}
        maxRows={maxRows}
        width={width}
        hint="Enter to save · Esc to go back"
      >
        <Box flexShrink={0}><Text> </Text></Box>
        {lines.map((l) => (
          <Box key={l} flexShrink={0}><Text dimColor wrap="truncate-end">{l}</Text></Box>
        ))}
        <BoxField value={value} cursor={cursor} width={width} mask placeholder="paste your key, then press Enter" />
        <Box flexShrink={0}><Text> </Text></Box>
        <Box flexShrink={0}><Text dimColor wrap="truncate-end">{`  Typed hidden · kept in ${KEY_FILE} as ${p.apiKeyEnv}`}</Text></Box>
      </Panel>
    );
  }

  if (mode.kind === "actions") {
    return (
      <Panel
        title={`${mode.provider.label} · key ${mode.row.slot}`}
        tabs={tabs}
        titleWidth={TITLE_WIDTH}
        rows={actions.length + 1 + (shown ? 2 : 0)}
        maxRows={maxRows}
        width={width}
        hint={shown ? "hidden again when you leave · Esc or ⌫  back" : "↑/↓ · Enter to choose · ← or Esc  back"}
      >
        <Box flexShrink={0}>
          <Text dimColor>{`  ${mode.row.hint}`}</Text>
          {mode.row.active ? <Text color={GOOD}>{"   ● the active key"}</Text> : null}
        </Box>
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
    const p = mode.provider;
    const listWin = Math.max(2, win - 1);
    const start = windowStart(sel, count, listWin);
    const addRow = canAdd && start + listWin > keys.length;
    const shownKeys = Math.min(listWin, keys.length - start);
    const body = shownKeys + (addRow ? 1 : 0);
    // What the screen is about, under the list, when the box has room for it.
    const info = [p.keysUrl ? `Get a key at ${p.keysUrl}` : "", `Kept in ${KEY_FILE} as ${p.apiKeyEnv}`].filter(Boolean);
    const withInfo = body + 1 + info.length <= win;
    return (
      <Panel
        title={`${p.label} · ${countLabel(keys.length)}`}
        tabs={tabs}
        titleWidth={TITLE_WIDTH}
        counter={position(sel, count, listWin)}
        rows={body + (withInfo ? 1 + info.length : 0)}
        maxRows={maxRows}
        width={width}
        hint="↑/↓ · Enter to choose · ← or Esc  providers"
      >
        {keys.slice(start, start + listWin).map((r, i) => (
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
        {withInfo ? (
          <>
            <Box flexShrink={0}><Text> </Text></Box>
            {info.map((l) => (
              <Box key={l} flexShrink={0}><Text dimColor wrap="truncate-end">{`  ${l}`}</Text></Box>
            ))}
          </>
        ) : null}
      </Panel>
    );
  }

  const start = windowStart(sel, found.length, win);
  return (
    <Panel
      title="Providers"
      tabs={tabs}
      titleWidth={TITLE_WIDTH}
      rows={Math.min(win, found.length - start)}
      maxRows={maxRows}
      width={width}
      hint={
        query
          ? found.length === 0
            ? "nothing matches · ⌫ edit · Esc clears the search"
            : "↑/↓ · Enter to use · → keys · ⌫ edit · Esc clears the search"
          : "type to search · ↑/↓ · Enter to use · → keys · Esc close"
      }
    >
      {found.slice(start, start + win).map((p, i) => (
        <Row
          key={p.id}
          on={start + i === sel}
          n={start + i + 1}
          numWidth={String(found.length).length}
          left={p.active ? `${p.label}  ✓` : p.label}
          right={p.status ?? countLabel(p.count)}
          rightColor={(p.ready ?? p.count > 0) ? GOOD : undefined}
          width={width}
        />
      ))}
    </Panel>
  );
}
