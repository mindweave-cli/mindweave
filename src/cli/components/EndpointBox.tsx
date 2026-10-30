/**
 * EndpointBox.tsx — what `/endpoint custom` (and `/endpoint lmstudio`, `/endpoint llamacpp`) shows: a provider's settings as a
 * short list you pick from.
 *
 * The same box the app's provider page draws as four fields, made for a terminal: one row per setting (address, key, model ids,
 * window), Enter on a row opens a field to type into, a saved value is replaced by typing a new one and removed by saving it
 * empty, and the last rows check the server again or forget everything. It sits where the prompt sits, like `/key`.
 *
 * Nothing here knows how a setting is kept or how a server is asked. The App gives it the current values, and a function that
 * applies a change and says in one line how it went, so the box shows what is really stored and what the server really answered.
 *
 * The key is typed masked and is never shown again, here or in the conversation: it goes straight to the store.
 */
import { Box, Text, useInput, type DOMElement } from "ink";
import { useRef, useState } from "react";
import { declareCaret } from "../caretPark.js";
import { stripMouse } from "../mouse.js";
import { MiniTabPanel as Panel, MiniTabRow as Row, miniTabPosition as position, miniTabWindowStart as windowStart, MINITAB_WINDOW as WINDOW } from "./minitabs.js";
import { ACCENT, GOOD, WARN } from "../theme.js";

/** What the box shows: the settings as stored, and whether the server answered. */
export interface EndpointFields {
  address: string;
  hasKey: boolean;
  models: string;
  window: string;
  /** The window assumed when none is set, shown beside an empty one. */
  defaultWindow: number;
  connected: boolean;
  modelCount: number;
  /**
   * Which settings this provider has. The custom endpoint has all four. A server on this machine (LM Studio, llama.cpp) is
   * found by itself and has only an address, for one that is somewhere else; it takes no key and no model ids. Left out
   * means the setting is there.
   */
  keyed?: boolean;
  usesModels?: boolean;
  usesWindow?: boolean;
  /** What an empty address means, for a server found by itself: "this computer, the usual port". Absent means "not set". */
  emptyAddress?: string;
  /** The ghost text in the address field, and the line above it. */
  addressExample?: string;
  addressHelp?: string;
}

/** One change. A field left out is left alone; null clears it. */
export interface EndpointPatch {
  address?: string | null;
  key?: string | null;
  models?: string | null;
  window?: string | null;
}

/** How a change went: one line, and whether it worked. */
export interface EndpointResult {
  ok: boolean;
  message: string;
}

type Field = "address" | "key" | "models" | "window";

type Mode =
  | { kind: "list" }
  | { kind: "edit"; field: Field }
  | { kind: "confirm" };

const LABEL: Record<Field, string> = { address: "Address", key: "Key", models: "Model ids", window: "Window" };

const HELP: Record<Field, string> = {
  address: "the address of an OpenAI-compatible API, like https://api.together.xyz/v1",
  key: "only if the server wants one: typed hidden, saved, never shown again",
  models: "ids separated by commas, for a server that does not list its models",
  window: "tokens its models hold, if the server does not say",
};

/**
 * The field a setting is typed into: drawn exactly as the chat's own input is. A bold `> ` in the accent colour, the text after
 * it, dim ghost text while it is empty, and the TERMINAL's own cursor parked on the caret (see caretPark.ts) rather than a block
 * drawn in a cell. A masked field (the key) shows one `*` per character, so its length is visible and nothing else is.
 */
export function BoxField({ value, cursor, placeholder, mask, width }: { value: string; cursor: number; placeholder: string; mask: boolean; width: number }) {
  const caretRow = useRef<DOMElement | null>(null);
  // Declared while rendering, as the chat input does, so the cursor is never a keystroke behind.
  declareCaret({ ref: caretRow, column: value.length === 0 ? 0 : cursor });
  const shown = mask ? "*".repeat(value.length) : value;
  return (
    <Box flexShrink={0}>
      <Text bold color={ACCENT}>{"> "}</Text>
      <Box width={Math.max(8, width - 6)} overflow="hidden" ref={caretRow}>
        <Text wrap="truncate-end">{value.length === 0 ? <Text dimColor>{placeholder}</Text> : shown}</Text>
      </Box>
    </Box>
  );
}

export interface EndpointBoxProps {
  title: string;
  /** The settings now, read fresh on every draw so the box shows what is stored. */
  read: () => EndpointFields;
  /** Apply a change, look at the server, and say how it went. */
  onSave: (patch: EndpointPatch) => Promise<EndpointResult>;
  /** Ask the server again without changing anything. */
  onCheck: () => Promise<EndpointResult>;
  /** Forget the address, key, model ids and window. */
  onForget: () => Promise<EndpointResult>;
  onClose: () => void;
  width: number;
  maxRows?: number;
  active?: boolean;
  /** Set when the box is a tab of the provider screen: the tab bar, its title column, and what going back means. */
  tabs?: { active: boolean }[];
  titleWidth?: number;
  backWord?: string;
}

export function EndpointBox({ title, read, onSave, onCheck, onForget, onClose, width, maxRows = WINDOW, active = true, tabs, titleWidth, backWord }: EndpointBoxProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [sel, setSel] = useState(0);
  const [value, setValue] = useState("");
  // Where the caret is within what is typed, in characters.
  const [cursor, setCursor] = useState(0);
  const [note, setNote] = useState<EndpointResult | null>(null);
  const [busy, setBusy] = useState(false);
  const f = read();

  // The rows, in order. "Remove the saved key" is only there when there is one, so it is never a dead row.
  type Item = { id: string; left: string; right: string; color?: string };
  const keyed = f.keyed !== false;
  const usesModels = f.usesModels !== false;
  const usesWindow = f.usesWindow !== false;
  const local = f.emptyAddress !== undefined;
  const items: Item[] = [
    { id: "address", left: LABEL.address, right: f.address || f.emptyAddress || "not set" },
    ...(keyed ? [{ id: "key", left: LABEL.key, right: f.hasKey ? "saved" : "none" }] : []),
    ...(usesModels ? [{ id: "models", left: LABEL.models, right: f.models.replace(/,/g, ", ") || "none, the server's own list is used" }] : []),
    ...(usesWindow ? [{ id: "window", left: LABEL.window, right: f.window || `${f.defaultWindow.toLocaleString("en-US")} (assumed)` }] : []),
    ...(f.hasKey ? [{ id: "clearkey", left: "Remove the saved key", right: "" }] : []),
    { id: "check", left: "Check the server again", right: "" },
    // For a server found by itself, "remove" means going back to looking on this computer.
    { id: "forget", left: local ? "Use this computer again" : "Remove everything", right: "", color: WARN },
  ];
  const win = Math.max(2, maxRows - 2);

  async function run(job: Promise<EndpointResult>) {
    setBusy(true);
    setNote({ ok: true, message: "checking…" });
    try {
      setNote(await job);
    } catch (err) {
      setNote({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  function choose(index: number) {
    const item = items[index];
    if (!item || busy) return;
    setNote(null);
    if (item.id === "address" || item.id === "key" || item.id === "models" || item.id === "window") {
      // Models and window open with what is stored, to be changed; the key and the address a person types fresh.
      const start = item.id === "models" ? f.models : item.id === "window" ? f.window : item.id === "address" ? f.address : "";
      setValue(start);
      setCursor(start.length);
      return setMode({ kind: "edit", field: item.id });
    }
    if (item.id === "clearkey") return void run(onSave({ key: null }));
    if (item.id === "check") return void run(onCheck());
    return setMode({ kind: "confirm" });
  }

  function submit(raw: string, field: Field) {
    const text = raw.trim();
    setMode({ kind: "list" });
    // An empty key is nothing typed, not "remove it" (that is its own row); every other field is cleared by saving it empty.
    if (field === "key" && !text) return;
    void run(onSave({ [field]: text || null } as EndpointPatch));
  }

  useInput(
    (raw, key) => {
      const input = stripMouse(raw);
      if (input === "" && raw !== "") return;
      if (mode.kind === "edit") {
        if (key.escape) {
          setMode({ kind: "list" });
          setValue("");
          return;
        }
        if (key.return) return submit(value, mode.field);
        // Editing keys, the ones the chat input answers to.
        // With nothing typed there is no caret to move, so ← and Backspace leave the field, as Esc does.
        if (value === "" && (key.leftArrow || key.backspace || key.delete)) {
          setMode({ kind: "list" });
          return;
        }
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
        // Typed or pasted text goes in at the caret. A paste can carry line breaks and other control characters, which
        // have no place in a one-line setting.
        const text = input.replace(/[ -]/g, "");
        if (text && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
          setValue(value.slice(0, cursor) + text + value.slice(cursor));
          setCursor(cursor + text.length);
        }
        return;
      }
      if (mode.kind === "confirm") {
        if (key.escape || input.toLowerCase() === "n") return setMode({ kind: "list" });
        if (key.return || input.toLowerCase() === "y") {
          setMode({ kind: "list" });
          setSel(0);
          void run(onForget());
        }
        return;
      }
      if (key.escape || key.backspace || key.delete || (tabs && key.leftArrow)) return onClose();
      if (key.upArrow) setSel((s) => (s - 1 + items.length) % items.length);
      else if (key.downArrow) setSel((s) => (s + 1) % items.length);
      else if (key.return) choose(sel);
      else {
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, items.length)) choose(n - 1);
      }
    },
    { isActive: active },
  );

  const status = f.connected ? `connected, ${f.modelCount} model${f.modelCount === 1 ? "" : "s"}` : "not connected";

  if (mode.kind === "edit") {
    const field = mode.field;
    return (
      <Panel tabs={tabs} titleWidth={titleWidth} title={`${title} · ${LABEL[field]}`} rows={2} maxRows={maxRows} width={width} hint="Enter to save · save it empty to clear · Esc to go back">
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">{`  ${field === "address" && f.addressHelp ? f.addressHelp : HELP[field]}`}</Text>
        </Box>
        <BoxField
          value={value}
          cursor={cursor}
          width={width}
          mask={field === "key"}
          placeholder={field === "key" ? "paste your key, then press Enter" : field === "address" ? (f.addressExample ?? "https://…/v1") : field === "models" ? "model-a, model-b" : "128000"}
        />
      </Panel>
    );
  }

  if (mode.kind === "confirm") {
    return (
      <Panel tabs={tabs} titleWidth={titleWidth} title={`${title} · ${local ? "use this computer again?" : "remove everything?"}`} rows={1} maxRows={maxRows} width={width} hint={local ? "Enter or y to confirm · Esc or n to keep it" : "Enter or y to remove · Esc or n to keep it"}>
        <Box flexShrink={0}>
          <Text color={WARN} wrap="truncate-end">{local ? "  This forgets the address, so the server is looked for on this computer again." : "  This forgets the address, the key, the model ids and the window."}</Text>
        </Box>
      </Panel>
    );
  }

  const start = windowStart(sel, items.length, win);
  const shown = items.slice(start, start + win);
  return (
    <Panel
      tabs={tabs}
      titleWidth={titleWidth}
      title={`${title} · ${status}`}
      counter={position(sel, items.length, win)}
      rows={shown.length + (note ? 1 : 0)}
      maxRows={maxRows}
      width={width}
      hint={`↑/↓ · Enter to change · ${backWord ?? "Esc or ⌫  close"}`}
    >
      {shown.map((it, i) => (
        <Row
          key={it.id}
          on={start + i === sel}
          n={start + i + 1}
          numWidth={String(items.length).length}
          left={it.left}
          leftColor={it.color}
          right={it.right === "" ? undefined : it.right}
          width={width}
        />
      ))}
      {note ? (
        <Box flexShrink={0}>
          <Text color={note.ok ? GOOD : WARN} wrap="truncate-end">{`  ${note.message}`}</Text>
        </Box>
      ) : null}
    </Panel>
  );
}
