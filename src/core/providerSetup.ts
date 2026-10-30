/**
 * providerSetup.ts — the settings a provider has beyond a key: the address it is reached at, and for the providers that are set
 * up by an address (a server on this machine or the network, a custom endpoint) the address itself, a key if the server wants
 * one, and the models and window to assume when the server does not say.
 *
 * One place for what the app's provider page and the terminal's `/endpoint` both read and write. Everything is kept the way a
 * key is (in the global `~/.mindweave/.env`, applied to this process at once), so a change counts on the next request without a
 * restart and the terminal and the app can never disagree. Nothing here touches the network: the caller asks for the provider
 * list to be refreshed afterwards, which is when a new address is tried.
 */
import { allProviders, forgetDiscovered } from "../drivers/registry.js";
import { ENDPOINTS, activePreset, endpointUrl, parseEndpoint, type EndpointPreset } from "../drivers/endpoints.js";
import { hasApiKey, removeApiKey, saveApiKey, saveSetting } from "../cli/bootstrap.js";

/** The address a provider is reached at, and the others that serve the same models. */
export interface EndpointView {
  /** The address in use. */
  url: string;
  /** The provider's usual address. */
  defaultUrl: string;
  /** True when the address is not the usual one. */
  changed: boolean;
  /** The id of the preset the address is, when it is one. */
  preset?: string;
  presets: EndpointPreset[];
}

/** The address of a provider that speaks the OpenAI wire through the shared layer; null for any other. */
export function providerEndpoint(providerId: string): EndpointView | null {
  const spec = ENDPOINTS[providerId];
  if (!spec) return null;
  const url = endpointUrl(providerId);
  return { url, defaultUrl: spec.defaultUrl, changed: url !== spec.defaultUrl.replace(/\/+$/, ""), preset: activePreset(providerId)?.id, presets: spec.presets };
}

export type SetResult = { ok: true; url: string | null } | { ok: false; error: string };

/**
 * Point a provider at another address: a full http(s) URL, or the id of one of its presets. An empty value goes back to the
 * usual address.
 */
export function setProviderEndpoint(providerId: string, input: string | null): SetResult {
  const spec = ENDPOINTS[providerId];
  if (!spec) return { ok: false, error: "That provider's address cannot be changed." };
  if (input === null || !input.trim()) {
    saveSetting(spec.env, null);
    return { ok: true, url: null };
  }
  const url = parseEndpoint(providerId, input);
  if (!url) {
    const names = spec.presets.map((p) => p.id);
    return {
      ok: false,
      error: `That is not an address. Use a full one, like https://gateway.example.com/v1${names.length ? `, or a preset: ${names.join(", ")}` : ""}.`,
    };
  }
  saveSetting(spec.env, url);
  return { ok: true, url };
}

/** What the app shows for a provider that is set up by an address. */
export interface SetupView {
  /** The address now, "" when none is set. */
  address: string;
  placeholder: string;
  /** The server may want a key. */
  keyed: boolean;
  /** A key is on file. */
  hasKey: boolean;
  /** The server may not list its own models, so ids can be typed in. */
  usesModels: boolean;
  models: string;
  /** What the models hold is assumed when the server does not say. */
  usesWindow: boolean;
  window: string;
  /** The window assumed when none is set. */
  defaultWindow: number | null;
}

/** The setup of a provider that is configured by an address; null for any other. */
export function providerSetup(providerId: string): SetupView | null {
  const s = allProviders().find((p) => p.id === providerId)?.setup;
  if (!s) return null;
  return {
    address: s.current(),
    placeholder: s.placeholder,
    keyed: !!s.keyEnv,
    hasKey: s.keyEnv ? hasApiKey(s.keyEnv) : false,
    usesModels: !!s.modelsEnv,
    models: s.modelsEnv ? (process.env[s.modelsEnv]?.trim() ?? "") : "",
    usesWindow: !!s.windowEnv,
    window: s.windowEnv ? (process.env[s.windowEnv]?.trim() ?? "") : "",
    defaultWindow: s.defaultWindow ?? null,
  };
}

/** A change to a provider's setup. A field left out is left alone; `null` or an empty string clears it. */
export interface SetupPatch {
  address?: string | null;
  key?: string | null;
  models?: string | null;
  window?: string | null;
}

/** Make a typed list of model ids tidy: one comma-separated line, no blanks, no repeats. */
export function tidyModels(input: string): string {
  const seen = new Set<string>();
  for (const part of input.split(/[,\n]/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen].join(",");
}

/**
 * Apply a change to a provider's setup. Everything is checked before anything is written, so a bad field leaves the rest as it
 * was: a half-applied change is a provider pointed at an address with the old key.
 */
export function setProviderSetup(providerId: string, patch: SetupPatch): SetResult {
  const s = allProviders().find((p) => p.id === providerId)?.setup;
  if (!s) return { ok: false, error: "That provider is not set up by an address." };

  let address: string | null | undefined;
  if (patch.address !== undefined) {
    if (patch.address === null || !patch.address.trim()) address = null;
    else {
      address = s.parse(patch.address);
      if (!address) return { ok: false, error: `That does not look like an address. Try ${s.placeholder}.` };
    }
  }
  let window: string | null | undefined;
  if (patch.window !== undefined) {
    if (patch.window === null || !patch.window.trim()) window = null;
    else {
      const n = Number(patch.window.replace(/[\s,_]/g, ""));
      if (!Number.isInteger(n) || n < 2048) return { ok: false, error: "The window is a whole number of tokens, at least 2048." };
      window = String(n);
    }
  }
  if (patch.key !== undefined && patch.key !== null && patch.key.trim() && !s.keyEnv) {
    return { ok: false, error: "That provider does not take a key." };
  }

  if (address !== undefined) saveSetting(s.addressEnv, address);
  if (patch.key !== undefined && s.keyEnv) {
    if (patch.key === null || !patch.key.trim()) removeApiKey(s.keyEnv, 1);
    else saveApiKey(s.keyEnv, patch.key);
  }
  if (patch.models !== undefined && s.modelsEnv) {
    const tidy = patch.models === null ? "" : tidyModels(patch.models);
    saveSetting(s.modelsEnv, tidy || null);
  }
  if (window !== undefined && s.windowEnv) saveSetting(s.windowEnv, window);
  // The list this provider had came from the server it used to be pointed at, and whether it counts as connected was decided by
  // that server too: both are asked again, from the next refresh.
  const manifest = allProviders().find((p) => p.id === providerId)!;
  forgetDiscovered(providerId);
  if (!manifest.local) delete process.env[manifest.apiKeyEnv];
  return { ok: true, url: address ?? null };
}
