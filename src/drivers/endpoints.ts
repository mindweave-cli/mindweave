/**
 * endpoints.ts — where each OpenAI-compatible provider is reached, and the other addresses that serve the same
 * models.
 *
 * Every provider has one default address. Several also sell a flat-fee coding plan on a DIFFERENT address, and
 * the plan's key works only there: pointing the normal address at a plan key is refused, and the other way round
 * bills pay-as-you-go instead of the plan. So the address is a setting, kept the way a key is (in the global
 * `~/.mindweave/.env`, so the terminal and the app agree), and read on every request rather than once at start,
 * which is what lets it change while the app is open.
 *
 * The variable is the one each driver always honoured (`MINDWEAVE_GLM_URL`, …). Setting it by hand still works; this
 * module only names them in one place and says which presets exist.
 */

/** A known alternative address for a provider. */
export interface EndpointPreset {
  id: string;
  label: string;
  url: string;
  /** One or two sentences on what it is for and what to know before using it. */
  note: string;
}

export interface EndpointSpec {
  /** The variable that holds the address when it is changed. */
  env: string;
  /** The provider's usual address. */
  defaultUrl: string;
  presets: EndpointPreset[];
}

/** Keyed by provider id. Only providers that speak the OpenAI-compatible wire through the shared layer are here. */
export const ENDPOINTS: Record<string, EndpointSpec> = {
  glm: {
    env: "MINDWEAVE_GLM_URL",
    defaultUrl: "https://api.z.ai/api/paas/v4",
    presets: [
      {
        id: "coding-plan",
        label: "GLM Coding Plan",
        url: "https://api.z.ai/api/coding/paas/v4",
        note: "For a Z.ai Coding Plan subscription. Its key only works on this address, and uses the plan's allowance rather than pay-as-you-go.",
      },
    ],
  },
  qwen: {
    env: "MINDWEAVE_QWEN_URL",
    defaultUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    presets: [
      {
        id: "coding-plan",
        label: "Alibaba Coding Plan (international)",
        url: "https://coding-intl.dashscope.aliyuncs.com/v1",
        note: "For an Alibaba Coding Plan key (it starts sk-sp-). The plan serves only a few models, such as Qwen3.7 Plus, and its key does not work on the normal address.",
      },
    ],
  },
  kimi: {
    env: "MINDWEAVE_KIMI_URL",
    defaultUrl: "https://api.moonshot.ai/v1",
    presets: [
      {
        id: "kimi-code",
        label: "Kimi Code",
        url: "https://api.kimi.com/coding/v1",
        note: "For a Kimi Code membership. It serves its own model ids, kimi-for-coding and kimi-for-coding-highspeed, which are offered in /model while this address is set.",
      },
      {
        id: "kimi-code-overseas",
        label: "Kimi Code (overseas)",
        url: "https://api.kimi.ai/coding/v1",
        note: "The same membership, reached through the overseas address.",
      },
    ],
  },
  minimax: { env: "MINDWEAVE_MINIMAX_URL", defaultUrl: "https://api.minimax.io/v1", presets: [] },
  mistral: { env: "MINDWEAVE_MISTRAL_URL", defaultUrl: "https://api.mistral.ai/v1", presets: [] },
  groq: { env: "MINDWEAVE_GROQ_URL", defaultUrl: "https://api.groq.com/openai/v1", presets: [] },
  cerebras: { env: "MINDWEAVE_CEREBRAS_URL", defaultUrl: "https://api.cerebras.ai/v1", presets: [] },
  xai: { env: "MINDWEAVE_XAI_URL", defaultUrl: "https://api.x.ai/v1", presets: [] },
  meta: { env: "MINDWEAVE_META_URL", defaultUrl: "https://api.meta.ai/v1", presets: [] },
  tencent: { env: "MINDWEAVE_TENCENT_URL", defaultUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1", presets: [] },
  gemini: {
    env: "MINDWEAVE_GEMINI_URL",
    defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    presets: [],
  },
};

/** The provider's spec, or undefined for one whose address is not a setting. */
export function endpointSpec(providerId: string): EndpointSpec | undefined {
  return ENDPOINTS[providerId];
}

/** An address as it is stored: no trailing slash. */
const tidy = (url: string): string => url.trim().replace(/\/+$/, "");

/** The address requests go to now. Read on every call, so a change counts at once. */
export function endpointUrl(providerId: string, env: NodeJS.ProcessEnv = process.env): string {
  const spec = ENDPOINTS[providerId];
  if (!spec) throw new Error(`No endpoint is known for provider '${providerId}'.`);
  const own = env[spec.env]?.trim();
  return tidy(own || spec.defaultUrl);
}

/** The preset the current address matches, if any. */
export function activePreset(providerId: string, env: NodeJS.ProcessEnv = process.env): EndpointPreset | undefined {
  const url = endpointUrl(providerId, env);
  return ENDPOINTS[providerId]?.presets.find((p) => tidy(p.url) === url);
}

/**
 * An address as a person types it: a full http(s) URL, or a preset's id. Returns the address as it will be stored, or
 * null when it is neither. An address with a name or password in it is refused, because it is kept in a plain file and
 * shown on screen, and so is one with a query or a fragment, which a base address never has.
 */
export function parseEndpoint(providerId: string, input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const preset = ENDPOINTS[providerId]?.presets.find((p) => p.id === raw.toLowerCase());
  if (preset) return tidy(preset.url);
  return parseUrl(raw);
}

/** A base address typed by hand: http or https, a host, no credentials, no query. */
export function parseUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    return tidy(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return null;
  }
}
