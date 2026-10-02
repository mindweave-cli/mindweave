/**
 * providerKeys.ts — managing a provider's keys from a UI: several per provider, one
 * default, one live, names, switching off, and moving on when one is refused.
 *
 * Built on the CLI's key store rather than beside it (keyStore.ts, bootstrap.ts): keys
 * live in `~/.mindweave/.env` as `VAR_1..VAR_9`, the bare `VAR` is the live one every
 * driver reads, and slot 1 is where each launch starts, which is what "default" means
 * here. Names, the disabled list and the auto-switch setting are in keys.json
 * (keyPrefs.ts). Nothing here ever returns a whole key: a view carries its last four
 * characters and its name.
 */
import { allProviders } from "../drivers/registry.js";
import { keysFor, keyHint, nextFreeSlot, MAX_SLOTS, type StoredKey } from "../cli/keyStore.js";
import { saveApiKey, removeApiKey, makeDefaultApiKey, setLiveApiKey } from "../cli/bootstrap.js";
import {
  autoSwitchOn,
  setAutoSwitch,
  keyLabel,
  setKeyLabel,
  isKeyDisabled,
  setKeyDisabled,
  keyFailure,
  noteKeyFailure,
  clearKeyFailure,
  keyFingerprint,
} from "../cli/keyPrefs.js";

export interface KeyView {
  slot: number;
  /** Last four characters, e.g. "…a1b2". */
  hint: string;
  label: string;
  /** The key the drivers are sending right now. */
  live: boolean;
  /** Slot 1: where every launch starts. */
  isDefault: boolean;
  disabled: boolean;
  /** Its last refusal in this run, if any. */
  failure?: { reason: "rejected" | "no-credit" | "rate-limited"; status: number; at: number };
}

export interface ProviderKeysView {
  providerId: string;
  label: string;
  apiKeyEnv: string;
  keysUrl: string;
  keys: KeyView[];
  autoSwitch: boolean;
  maxKeys: number;
}

export type KeyResult = { ok: true } | { ok: false; error: string };

function providerById(id: string) {
  const p = allProviders().find((m) => m.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

function find(apiKeyEnv: string, slot: number): StoredKey | undefined {
  return keysFor(apiKeyEnv).find((k) => k.slot === slot);
}

/** After a key goes away or is switched off, make sure the live key is one that may be sent. */
function settleLive(apiKeyEnv: string): void {
  const live = process.env[apiKeyEnv]?.trim();
  const keys = keysFor(apiKeyEnv);
  const liveOk = live && keys.some((k) => k.value === live) && !isKeyDisabled(live);
  if (liveOk) return;
  setLiveApiKey(apiKeyEnv, keys.find((k) => !isKeyDisabled(k.value))?.value ?? null);
}

export function providerKeys(providerId: string): ProviderKeysView {
  const p = providerById(providerId);
  const live = process.env[p.apiKeyEnv]?.trim();
  return {
    providerId: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    keysUrl: p.keysUrl,
    autoSwitch: autoSwitchOn(p.apiKeyEnv),
    maxKeys: MAX_SLOTS,
    keys: keysFor(p.apiKeyEnv).map((k) => {
      const failure = keyFailure(k.value);
      return {
        slot: k.slot,
        hint: keyHint(k.value),
        label: keyLabel(k.value),
        live: k.value === live,
        isDefault: k.slot === 1,
        disabled: isKeyDisabled(k.value),
        ...(failure ? { failure } : {}),
      };
    }),
  };
}

export function addProviderKey(providerId: string, value: string, label = ""): KeyResult {
  const p = providerById(providerId);
  const key = value.trim();
  if (!key) return { ok: false, error: "Paste a key first." };
  if (keysFor(p.apiKeyEnv).some((k) => k.value === key)) return { ok: false, error: "That key is already saved." };
  const slot = nextFreeSlot(p.apiKeyEnv);
  if (slot === null) return { ok: false, error: `${p.label} already has ${MAX_SLOTS} keys. Remove one first.` };
  saveApiKey(p.apiKeyEnv, key, slot);
  if (label.trim()) setKeyLabel(key, label);
  settleLive(p.apiKeyEnv);
  return { ok: true };
}

/** Replace a key's value, keeping its slot, its name and whether it is switched off. */
export function editProviderKey(providerId: string, slot: number, value: string): KeyResult {
  const p = providerById(providerId);
  const old = find(p.apiKeyEnv, slot);
  const key = value.trim();
  if (!old) return { ok: false, error: "That key is no longer saved." };
  if (!key) return { ok: false, error: "Paste the new key first." };
  if (key !== old.value && keysFor(p.apiKeyEnv).some((k) => k.value === key)) return { ok: false, error: "That key is already saved." };
  const label = keyLabel(old.value);
  const disabled = isKeyDisabled(old.value);
  saveApiKey(p.apiKeyEnv, key, slot);
  if (label) { setKeyLabel(old.value, ""); setKeyLabel(key, label); }
  if (disabled) { setKeyDisabled(old.value, false); setKeyDisabled(key, true); }
  clearKeyFailure(old.value);
  settleLive(p.apiKeyEnv);
  return { ok: true };
}

export function removeProviderKey(providerId: string, slot: number): KeyResult {
  const p = providerById(providerId);
  const old = find(p.apiKeyEnv, slot);
  if (!old) return { ok: false, error: "That key is no longer saved." };
  removeApiKey(p.apiKeyEnv, slot);
  setKeyLabel(old.value, "");
  setKeyDisabled(old.value, false);
  clearKeyFailure(old.value);
  settleLive(p.apiKeyEnv);
  return { ok: true };
}

/** Send this key from now on, without changing which one is the default. */
export function useProviderKey(providerId: string, slot: number): KeyResult {
  const p = providerById(providerId);
  const k = find(p.apiKeyEnv, slot);
  if (!k) return { ok: false, error: "That key is no longer saved." };
  if (isKeyDisabled(k.value)) return { ok: false, error: "Turn this key back on first." };
  setLiveApiKey(p.apiKeyEnv, k.value);
  return { ok: true };
}

export function makeDefaultProviderKey(providerId: string, slot: number): KeyResult {
  const p = providerById(providerId);
  const k = find(p.apiKeyEnv, slot);
  if (!k) return { ok: false, error: "That key is no longer saved." };
  if (isKeyDisabled(k.value)) setKeyDisabled(k.value, false); // a default that is switched off would be a contradiction
  makeDefaultApiKey(p.apiKeyEnv, slot);
  return { ok: true };
}

export function renameProviderKey(providerId: string, slot: number, label: string): KeyResult {
  const p = providerById(providerId);
  const k = find(p.apiKeyEnv, slot);
  if (!k) return { ok: false, error: "That key is no longer saved." };
  setKeyLabel(k.value, label);
  return { ok: true };
}

export function setProviderKeyDisabled(providerId: string, slot: number, disabled: boolean): KeyResult {
  const p = providerById(providerId);
  const k = find(p.apiKeyEnv, slot);
  if (!k) return { ok: false, error: "That key is no longer saved." };
  setKeyDisabled(k.value, disabled);
  settleLive(p.apiKeyEnv);
  return { ok: true };
}

export function setProviderAutoSwitch(providerId: string, on: boolean): void {
  setAutoSwitch(providerById(providerId).apiKeyEnv, on);
}

/**
 * A key was refused with `status`. Record it, and when the provider is allowed to move
 * on, switch the drivers to the next key that is switched on and not yet tried in this
 * turn, going round from the one that failed. Returns what changed, or null when there
 * is nothing to switch to (or switching is off), in which case the refusal stands.
 */
export function failoverKey(
  apiKeyEnv: string,
  status: number,
  tried: Set<string>,
): { from: string; to: string; reason: "rejected" | "no-credit" | "rate-limited" } | null {
  const live = process.env[apiKeyEnv]?.trim();
  if (!live) return null;
  const { reason } = noteKeyFailure(live, status);
  tried.add(keyFingerprint(live));
  if (!autoSwitchOn(apiKeyEnv)) return null;
  const keys = keysFor(apiKeyEnv);
  const at = keys.findIndex((k) => k.value === live);
  const rotated = at < 0 ? keys : [...keys.slice(at + 1), ...keys.slice(0, at)];
  const next = rotated.find((k) => !isKeyDisabled(k.value) && !tried.has(keyFingerprint(k.value)));
  if (!next) return null;
  setLiveApiKey(apiKeyEnv, next.value);
  return { from: labelled(live), to: labelled(next.value), reason };
}

/** A key as a person would name it: its label if it has one, and its last four. */
function labelled(value: string): string {
  const label = keyLabel(value);
  return label ? `${label} (${keyHint(value)})` : keyHint(value);
}

/** A turn went through on the live key: forget its old refusal. */
export function noteKeyWorked(apiKeyEnv: string): void {
  const live = process.env[apiKeyEnv]?.trim();
  if (live) clearKeyFailure(live);
}
