/**
 * keyPrefs.ts — what a person says ABOUT their keys, kept apart from the keys.
 *
 * The keys themselves live in `~/.mindweave/.env` (see keyStore.ts), a file people open
 * and edit by hand. Names for them ("Work", "Personal") and whether a provider may move
 * on to its next key when one is refused are settings, not credentials, so they go in
 * `~/.mindweave/keys.json` and never share a file with a secret.
 *
 * A name is stored against a FINGERPRINT of the key, not its slot. Slots renumber when a
 * key is removed or made the default; a name keyed by slot would silently jump to a
 * different key. The fingerprint is a short hash, so this file holds nothing that could
 * be used as, or turned back into, the key.
 */
import { stateRoot } from "../memory/store.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KeyPrefs {
  /** Per provider (by its key variable): move on to the next key when one is refused. */
  autoSwitch: Record<string, boolean>;
  /** Key fingerprint → the name the user gave it. */
  labels: Record<string, string>;
  /** Fingerprints of keys switched off: kept on file, never sent. */
  disabled: string[];
}

const MAX_LABEL = 40;

export function keyPrefsPath(stateDir = stateRoot()): string {
  return join(stateDir, "keys.json");
}

/** A short, one-way fingerprint of a key: enough to tell keys apart, useless as a key. */
export function keyFingerprint(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

export function readKeyPrefs(path = keyPrefsPath()): KeyPrefs {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<KeyPrefs>;
    return {
      autoSwitch: raw.autoSwitch && typeof raw.autoSwitch === "object" ? raw.autoSwitch : {},
      labels: raw.labels && typeof raw.labels === "object" ? raw.labels : {},
      disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((d) => typeof d === "string") : [],
    };
  } catch {
    return { autoSwitch: {}, labels: {}, disabled: [] };
  }
}

function writeKeyPrefs(prefs: KeyPrefs, path = keyPrefsPath()): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs, null, 2), { mode: 0o600 });
}

export function autoSwitchOn(apiKeyEnv: string, path = keyPrefsPath()): boolean {
  return readKeyPrefs(path).autoSwitch[apiKeyEnv] === true;
}

export function setAutoSwitch(apiKeyEnv: string, on: boolean, path = keyPrefsPath()): void {
  const prefs = readKeyPrefs(path);
  prefs.autoSwitch[apiKeyEnv] = on;
  writeKeyPrefs(prefs, path);
}

export function keyLabel(value: string, path = keyPrefsPath()): string {
  return readKeyPrefs(path).labels[keyFingerprint(value)] ?? "";
}

/** Name a key; an empty name removes it. */
export function setKeyLabel(value: string, label: string, path = keyPrefsPath()): void {
  const prefs = readKeyPrefs(path);
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  const id = keyFingerprint(value);
  if (clean) prefs.labels[id] = clean;
  else delete prefs.labels[id];
  writeKeyPrefs(prefs, path);
}

export function isKeyDisabled(value: string, path = keyPrefsPath()): boolean {
  return readKeyPrefs(path).disabled.includes(keyFingerprint(value));
}

export function setKeyDisabled(value: string, disabled: boolean, path = keyPrefsPath()): void {
  const prefs = readKeyPrefs(path);
  const id = keyFingerprint(value);
  prefs.disabled = prefs.disabled.filter((d) => d !== id);
  if (disabled) prefs.disabled.push(id);
  writeKeyPrefs(prefs, path);
}

/**
 * The last refusal each key got in this process: out of credit, rate-limited, rejected.
 * In memory only, because it is about now: a key refused yesterday may well work today.
 */
export interface KeyFailure {
  status: number;
  reason: "rejected" | "no-credit" | "rate-limited";
  at: number;
}
const failures = new Map<string, KeyFailure>();

export function noteKeyFailure(value: string, status: number): KeyFailure {
  const reason = status === 401 || status === 403 ? "rejected" : status === 429 ? "rate-limited" : "no-credit";
  const failure: KeyFailure = { status, reason, at: Date.now() };
  failures.set(keyFingerprint(value), failure);
  return failure;
}

export function keyFailure(value: string): KeyFailure | undefined {
  return failures.get(keyFingerprint(value));
}

export function clearKeyFailure(value: string): void {
  failures.delete(keyFingerprint(value));
}
