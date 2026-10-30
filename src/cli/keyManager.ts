/**
 * keyManager.ts — the rows /key shows, as plain data.
 *
 * Three levels, because a provider is not one key. PROVIDERS first, then that provider's
 * KEYS with an "add another" that never runs out, then what can be done to one key. A
 * flat list of every key across every provider was the first attempt and it buried the
 * thing people actually came to do: manage the keys of one provider.
 *
 * Derived here rather than in the view so "how many keys does this provider have",
 * "which one is being sent" and "what can be done to it" are answerable without
 * rendering anything.
 */
import { allProviders, modelsOf } from "../drivers/registry.js";
import { activeSlot, keyHint, keysFor, nextFreeSlot } from "./keyStore.js";
import { orderProviders } from "./pickerOrder.js";

export interface ProviderRow {
  id: string;
  label: string;
  apiKeyEnv: string;
  /** How many keys are stored for it. Zero is shown too — that is how the first is added. */
  count: number;
  /**
   * What sort of provider this is, on the combined provider list: one that takes a key (the default), a server on this computer,
   * or one set up by an address. Only the first has keys to manage; the others are set up in /endpoint.
   */
  kind?: "key" | "local" | "setup";
  /** What the provider list says about it: its models and whether it is ready ("5 models · 2 keys"). */
  status?: string;
  /** Ready to be used right now (a key is set, the server answers). */
  ready?: boolean;
  /** The provider the conversation is on. */
  active?: boolean;
  /** Where to get a key (or the runtime). */
  keysUrl?: string;
}

export interface KeyRow {
  label: string;
  apiKeyEnv: string;
  slot: number;
  /** Last four characters — never more. See keyStore.keyHint. */
  hint: string;
  /** The key the drivers are sending for this provider right now. */
  active: boolean;
}

/**
 * Every provider, with how many keys it holds, in display order.
 *
 * Ordered the way /provider is: the default first, then the ones you have a key for,
 * then the rest, each group alphabetical — so the providers you can actually use are at
 * the top of the list rather than scattered down it. The default is the first provider
 * the registry lists (the one a fresh project opens on).
 */
export function providerRows(env: NodeJS.ProcessEnv = process.env): ProviderRow[] {
  // A local runtime (Ollama, LM Studio, llama.cpp) has no keys to manage, and neither has a provider set up by an address: the
  // custom endpoint keeps its key with its address, in its own box (/endpoint custom), not in a slot here.
  const rows = allProviders().filter((p) => !p.local && !p.setup).map((p) => ({
    id: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    count: keysFor(p.apiKeyEnv, env).length,
  }));
  const defaultId = allProviders()[0]?.id ?? "";
  return orderProviders(rows, (r) => r.count > 0, defaultId);
}

/**
 * Every provider the combined /provider screen lists, in display order (the default, then the ones that are ready, then the rest,
 * each A to Z), with what to say about each. `hasKey` is injected so this stays a pure function of what it is given.
 */
export function providerChoices(activeId: string, hasKey: (envVar: string) => boolean, env: NodeJS.ProcessEnv = process.env): ProviderRow[] {
  const all = allProviders();
  const rows = all.map((p): ProviderRow => {
    const n = modelsOf(p).length;
    const models = `${n} model${n === 1 ? "" : "s"}`;
    const kind = p.local ? "local" : p.setup ? "setup" : "key";
    const ready = hasKey(p.apiKeyEnv);
    const count = kind === "key" ? keysFor(p.apiKeyEnv, env).length : 0;
    const state =
      kind === "local"
        ? ready ? "running on this computer" : n > 0 ? "not running" : "not running, or no models loaded"
        : kind === "setup"
          ? ready ? "connected" : "not set up"
          : countLabel(count);
    return { id: p.id, label: p.label, apiKeyEnv: p.apiKeyEnv, count, kind, ready, active: p.id === activeId, keysUrl: p.keysUrl, status: `${models} · ${state}` };
  });
  return orderProviders(rows, (r) => r.ready === true, all[0]?.id ?? "");
}

/** One provider's keys, in slot order. */
export function keyRowsFor(provider: ProviderRow, env: NodeJS.ProcessEnv = process.env): KeyRow[] {
  const live = activeSlot(provider.apiKeyEnv, env);
  return keysFor(provider.apiKeyEnv, env).map((k) => ({
    label: provider.label,
    apiKeyEnv: provider.apiKeyEnv,
    slot: k.slot,
    hint: keyHint(k.value),
    active: k.slot === live,
  }));
}

/** Where the next key for this provider would go, or null when it is full. */
export function nextSlotFor(provider: ProviderRow, env: NodeJS.ProcessEnv = process.env): number | null {
  return nextFreeSlot(provider.apiKeyEnv, env);
}

/** How a provider's key count reads on the provider list. */
export function countLabel(count: number): string {
  return count === 0 ? "no key yet" : `${count} key${count === 1 ? "" : "s"}`;
}

export const ACTION_SHOW = "Show the key";
export const ACTION_ACTIVATE = "Make this the active key";
export const ACTION_EDIT = "Edit it";
export const ACTION_REMOVE = "Remove it";
export const ACTION_BACK = "Back";

/**
 * What can be done to one key.
 *
 * "Make this the active key" is left out when it already is — an action that does
 * nothing is worse than an absent one, because the user tries it and learns nothing.
 * Removing a provider's only key IS allowed: it is how a wrong key gets corrected, and
 * the row says what it will cost rather than refusing.
 */
export function actionsFor(row: KeyRow, keysForProvider: number): string[] {
  return [
    ACTION_SHOW,
    ...(row.active ? [] : [ACTION_ACTIVATE]),
    ACTION_EDIT,
    keysForProvider === 1 ? `${ACTION_REMOVE} (the only key)` : ACTION_REMOVE,
    ACTION_BACK,
  ];
}
