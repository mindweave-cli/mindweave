/**
 * modes.ts — the interaction modes shown under the chat, cycled with shift-tab.
 *
 * A mode is how much rein Mindweave has this turn. It's a CLIENT concept: the engine
 * never sees "Architect" or a name — it only sees the behavioral flags a mode
 * implies (today just `readOnly`, tomorrow Sentinel's confirm-before-acting), set
 * onto the ToolContext when the mode changes. That keeps the layering clean: the
 * UI owns the labels/icons/colors, the engine owns the behavior.
 *
 * Pure and tiny on purpose (unit-tested): the cycle skips modes that aren't
 * enabled yet, so a not-yet-built mode (Sentinel) can sit in the list as a clean
 * seam without ever landing in the rotation.
 */

/** The stable id a mode is keyed by (persisted, compared — never the label). */
export type ModeId = "lightning" | "architect" | "sentinel";

export interface Mode {
  id: ModeId;
  /** Display name shown in the indicator. */
  name: string;
  /** A small single-width glyph — the mode's icon in the under-chat bar. */
  icon: string;
  /** Ink color for the icon + name. App palette tones (theme.ts): amber, teal-grey, jade. */
  color: string;
  /** One-line hint of what the mode does (dim, next to the name). */
  descriptor: string;
  /** Read-only turn: no mutating tools are offered or allowed (Architect). */
  readOnly: boolean;
  /**
   * Ask the user before each mutating action (Sentinel). Distinct from `readOnly`:
   * a guarded mode CAN act, it just confirms first. The engine reads this flag
   * alone (never the mode's name) to gate tool execution.
   */
  guarded: boolean;
  /**
   * Whether the mode is in the shift-tab rotation yet. A `false` mode is a
   * reserved seam — present in the list (so its behavior/UI can be built against
   * it) but never selectable until flipped on.
   */
  enabled: boolean;
}

/**
 * The modes, in cycle order. Lightning (auto-accept, today's behavior) is the
 * default and first stop; Architect (read-only planning) is the second; Sentinel
 * (ask before each mutating action) is the third.
 */
export const MODES: readonly Mode[] = [
  {
    id: "lightning",
    name: "Lightning",
    icon: "↯",
    color: "#EAB767",
    descriptor: "auto-accept",
    readOnly: false,
    guarded: false,
    enabled: true,
  },
  {
    id: "architect",
    name: "Architect",
    icon: "△",
    color: "#8FC0B8",
    descriptor: "read-only · plan",
    readOnly: true,
    guarded: false,
    enabled: true,
  },
  {
    id: "sentinel",
    name: "Sentinel",
    icon: "❖",
    color: "#52BF92",
    descriptor: "ask before acting",
    readOnly: false,
    guarded: true,
    enabled: true,
  },
];

/** The mode a fresh session starts in. Architect is deliberately never sticky —
 *  you should never open a session and silently be unable to edit. */
export const DEFAULT_MODE: ModeId = "lightning";

/** Look up a mode by id (falls back to the default — an unknown id can't wedge). */
export function modeById(id: ModeId): Mode {
  return MODES.find((m) => m.id === id) ?? modeById(DEFAULT_MODE);
}

/**
 * Which mode a set of behaviour flags amounts to (pure).
 *
 * The reverse of what `applyMode` does, and it exists because the flags can now move
 * without the user pressing anything: approving a plan lifts `planMode` mid-turn and
 * the engine restores it when the turn ends. The indicator has to be able to name
 * whatever state it finds rather than only what it last set.
 *
 * Reading flags rather than being told a name is what keeps modes a client concept —
 * nothing below this file knows the word "Architect". `planMode` wins over `guarded`
 * because a read-only turn cannot act, so there is nothing left to confirm.
 */
export function modeFromFlags(flags: { planMode?: boolean; guarded?: boolean }): ModeId {
  if (flags.planMode) return "architect";
  if (flags.guarded) return "sentinel";
  return "lightning";
}

/**
 * The next mode when the user presses shift-tab: the following ENABLED mode in
 * list order, wrapping around. Disabled modes (Sentinel, for now) are skipped, so
 * the rotation is only over what actually exists.
 */
export function nextMode(current: ModeId): ModeId {
  const rotation = MODES.filter((m) => m.enabled);
  const at = rotation.findIndex((m) => m.id === current);
  // If the current mode isn't in the rotation (e.g. a disabled mode was forced),
  // start the cycle from the first enabled mode.
  const next = rotation[(at + 1) % rotation.length] ?? rotation[0]!;
  return next.id;
}
