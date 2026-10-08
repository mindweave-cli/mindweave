/**
 * webFetch.ts — read a web page.
 *
 * A coding agent constantly needs something off the web: a docs page, a changelog,
 * an RFC, an error explained. Without this the user has to paste it in. The shape
 * is simple: input is a `url` plus an optional `prompt` describing what to pull out.
 *
 * Pipeline: fetch (https-upgraded, timed out, size-capped) → strip to readable
 * markdown (HTML via turndown; text/json/markdown pass through) → if the page is
 * large and the model gave a `prompt`, DISTILL it with one cheap model call so the
 * answer lands in context instead of a giant page; otherwise return the cleaned
 * content (capped). Read-only — touches no files.
 *
 * Model-work boundary: the optional distillation is a model call inside a tool.
 * Its prompt is deliberately thin — "answer this from the page" — no analysis
 * rules baked in; the engineering judgment stays with the model. Degrade-safe: no
 * API key, or any failure, falls back to returning the cleaned/truncated content.
 *
 * Safety: only http/https, and a basic SSRF guard refuses localhost / private-network
 * hosts so the tool can't be pointed at internal services.
 */
import type TurndownService from "turndown";
import { createRequire } from "node:module";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { Tool, ToolContext, ToolResult, WebDisplay } from "./types.js";
import { activeDriver } from "../drivers/registry.js";
import { frameExternal } from "./untrusted.js";
import { outputDetail } from "./detail.js";
import { estimateTokens } from "../memory/compaction.js";
import { fail, failQuietly } from "./results.js";

const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_CAP_BYTES = 3_000_000; // stop reading a response past ~3MB
const CONTENT_CAP_CHARS = 12_000; // how much cleaned content we return / distill from
export const DISTILL_OVER_CHARS = 12_000; // above this, summarize via a model call (if a prompt is given)
/** Redirect hops followed before giving up. Enough for shorteners and canonical
 *  redirects, short enough that a redirect loop cannot spin. */
const MAX_REDIRECTS = 5;

/**
 * The HTML-to-markdown converter, built on the first fetch rather than at startup. It pulls in
 * an HTML parser and a DOM, which cost about 85ms of every launch, and most sessions never fetch
 * a page.
 */
let turndownInstance: TurndownService | null = null;
function turndown(): TurndownService {
  if (!turndownInstance) {
    const Turndown = createRequire(import.meta.url)("turndown") as typeof TurndownService;
    turndownInstance = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndownInstance.remove(["script", "style", "noscript", "iframe"]);
  }
  return turndownInstance;
}

const webFetchTool: Tool = {
  name: "web_fetch",
  readOnly: true,
  // This description was already accurate, so only two things were added, both of
  // which prevent a wasted call: a bare host works (no need to hand-build the scheme),
  // and on a page small enough to return whole the `prompt` simply is not used, which
  // otherwise reads as the prompt having been ignored or failed.
  description:
    "Fetch a web page and return its content as readable markdown. Give a `url` and " +
    "optionally a `prompt` describing what to extract. Use it to read docs, articles, " +
    "changelogs, or any public URL. " +
    `A page longer than ${DISTILL_OVER_CHARS.toLocaleString("en-US")} characters is ` +
    "condensed against your `prompt` so you get the answer rather than the page; below " +
    "that you simply get the whole thing, and the prompt is not needed. " +
    "A bare host is fine (\"example.com\" becomes https://example.com), http is upgraded " +
    "to https, and private or localhost addresses are refused. " +
    "For GitHub, prefer the gh CLI via run_command when you can.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", description: "The URL to fetch (a fully-formed http(s) URL)." },
      prompt: {
        type: "string",
        description: "Optional: what to extract from the page (used to focus a large page).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!rawUrl) return failQuietly("`url` is required.");

    const url = normalizeUrl(rawUrl);
    if (typeof url === "string") return failQuietly(url); // a validation message

    const blocked = ssrfReason(url);
    if (blocked) return fail(blocked);

    const fetched = await fetchUrl(url);
    if (typeof fetched === "string") return fail(fetched);

    const { finalUrl, status, contentType, body } = fetched;

    if (!isTextual(contentType)) {
      return {
        output: `Fetched ${finalUrl} (HTTP ${status}, ${contentType || "unknown type"}). ` +
          `This is binary/non-text content, which web_fetch can't read. ` +
          `If you need it, download it with run_command.`,
        summary: `fetched ${hostOf(url)} (non-text)`,
        detail: fetchDetail(finalUrl, status, [`Content-Type: ${contentType || "unknown"} — not text, not read`]),
        web: { kind: "fetch", url: String(url), finalUrl, status, bytes: byteSize(body), binary: true },
      };
    }

    // What a front end draws for this page, the same whichever way it was read.
    const webFacts = (): WebDisplay => {
      const title = pageTitle(body);
      return {
        kind: "fetch",
        url: String(url),
        finalUrl,
        status,
        bytes: byteSize(body),
        ...(title ? { title } : {}),
        ...(prompt ? { focus: prompt } : {}),
      };
    };

    let content = contentType.includes("html") ? htmlToMarkdown(body) : body.trim();
    const redirected = hostOf(finalUrl) !== hostOf(url) ? `\n(note: redirected to ${finalUrl})` : "";

    // Large page + a prompt → distill to the answer. Otherwise return content,
    // capped. Distillation is best-effort; failure falls back to truncation.
    if (content.length > DISTILL_OVER_CHARS && prompt) {
      const distilled = await distill(content.slice(0, CONTENT_CAP_CHARS * 3), prompt, ctx);
      if (distilled) {
        // Framed too. Distillation is a summary OF untrusted text, so an instruction
        // planted in the page can survive into it — passing it through unmarked would
        // launder the page's words into something that reads as ours.
        return {
          output: frameExternal(
            { tag: "web_page", attrs: { url: finalUrl }, what: "an external web page" },
            `(focused on: ${prompt})${redirected}\n\n${distilled}`,
          ),
          summary: `fetched ${hostOf(url)} (summarized)`,
          web: webFacts(),
          detail: fetchDetail(finalUrl, status, [
            `Condensed against: "${prompt}"`,
            ...(redirected ? [`Redirected from ${hostOf(url)}`] : []),
          ]),
        };
      }
    }

    let out = content;
    let truncated = false;
    if (out.length > CONTENT_CAP_CHARS) {
      out = out.slice(0, CONTENT_CAP_CHARS);
      truncated = true;
    }
    const footer = truncated
      ? `\n\n… (content truncated at ${CONTENT_CAP_CHARS} chars; fetch a more specific URL or pass a prompt to focus it)`
      : "";

    return {
      output: frameExternal(
        { tag: "web_page", attrs: { url: finalUrl, status: String(status) }, what: "an external web page" },
        `${redirected}${redirected ? "\n\n" : ""}${out}${footer}`,
      ),
      summary: `fetched ${hostOf(url)} (${out.length} chars${truncated ? ", truncated" : ""})`,
      web: webFacts(),
      detail: fetchDetail(finalUrl, status, [
        `Extracted ${estimateTokens(out).toLocaleString("en-US")} tokens${truncated ? ", truncated" : ""}`,
        ...(pageTitle(body) ? [`Title: ${pageTitle(body)}`] : []),
        ...(redirected ? [`Redirected from ${hostOf(url)}`] : []),
      ], byteSize(body)),
    };
  },
};

/** The UI-only detail block under a Fetch row — never sent to the model
 *  (`frameExternal`'s `output` is what the model sees). `bytes` is what came off the
 *  wire, which is the number that says whether the page was worth the round trip. */
export function fetchDetail(finalUrl: string, status: number, extra: string[], bytes?: number): string {
  const lead = bytes === undefined ? `Received ${finalUrl}` : `Received ${formatBytes(bytes)} from ${finalUrl}`;
  return outputDetail([`${lead} (HTTP ${status})`, ...extra].join("\n"));
}

/** Bytes as a person reads them: `412 B`, `24.8 KB`, `1.3 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The transferred size — byte length, not character count, since a page of non-ASCII
 *  text is meaningfully larger on the wire than its `.length` suggests. */
function byteSize(body: string): number {
  return Buffer.byteLength(body, "utf8");
}

/**
 * A page's `<title>`, when it has one worth showing.
 *
 * What the page calls itself is the fastest way to tell "I fetched the right doc" from
 * "I fetched a login wall", and it is the one fact a URL alone cannot give.
 */
export function pageTitle(body: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (!m) return "";
  const text = m[1]!.replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

interface Fetched {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

/**
 * Fetch with timeout + size cap, checking EVERY hop. Body, or an error string.
 *
 * Redirects are followed by hand rather than by `fetch`. Letting the client follow
 * them means the SSRF guard only ever sees the URL the model supplied, and a public
 * URL that answers `302 -> http://127.0.0.1:8080` (or the cloud metadata address) is
 * then fetched with no check at all. That is a live bug class rather than a
 * hypothetical: the same shape was fixed in pyload, crewai-tools, WeasyPrint and
 * open-webui through 2026. The guidance is to refuse redirects or revalidate each
 * hop; revalidating keeps ordinary shortened and canonicalising links working, which
 * a coding agent hits constantly.
 */
async function fetchUrl(startUrl: URL): Promise<Fetched | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let url = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      // The transport never follows a redirect itself, so a redirect target is a value we
      // inspect rather than a request already made on our behalf.
      const res = await webTransport.fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mindweave/0.1 (+terminal coding agent)", Accept: "text/html,text/*,application/json;q=0.9,*/*;q=0.8" },
      });

      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) {
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        const body = await readCapped(res);
        return { finalUrl: url.toString(), status: res.status, contentType, body };
      }

      // Discard the redirect's own body; only the destination matters from here.
      await res.body?.cancel().catch(() => {});

      const step = redirectStep(location, url, hop);
      if ("error" in step) return step.error;
      url = step.url;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return `Timed out fetching ${startUrl.toString()} after ${FETCH_TIMEOUT_MS / 1000}s.`;
    }
    return `Could not fetch ${startUrl.toString()}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether one redirect hop may be followed (pure).
 *
 * Everything that makes a redirect dangerous is decided here, with no I/O, so the
 * rule is unit-testable rather than only reachable through a live server — which
 * matters because the interesting cases redirect INTO private addresses, and a test
 * that has to bind one is a test nobody writes.
 */
export function redirectStep(location: string, from: URL, hop: number): { url: URL } | { error: string } {
  if (hop >= MAX_REDIRECTS) {
    return { error: `Gave up after ${MAX_REDIRECTS} redirects, most recently at ${from.toString()}.` };
  }
  // Relative Location headers are legal and common.
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return { error: `Got an unreadable redirect target ("${location}") from ${from.toString()}.` };
  }
  // A redirect must not become a way to reach a scheme the tool would have refused
  // outright — `file:`, `gopher:` and friends are a standard SSRF escalation.
  if (next.protocol === "http:") next.protocol = "https:";
  if (next.protocol !== "https:") {
    return { error: `Refusing to follow a redirect to a "${next.protocol}" URL (${next.toString()}).` };
  }
  const blocked = ssrfReason(next);
  if (blocked) return { error: `Refusing to follow a redirect from ${from.hostname}: ${blocked}` };
  return { url: next };
}

/**
 * An https request whose name is resolved once, checked, and connected to exactly as
 * checked.
 *
 * `ssrfReason` can only read the address TEXT. A public-looking name that resolves to a
 * private address (an intranet wiki behind a VPN, or a name an attacker points at
 * 127.0.0.1) passed it, and the page went to the model. Node's fetch resolves names
 * itself and offers no hook, so this uses https.request with a `lookup` that refuses
 * when ANY address the name resolves to is private, loopback, link-local or
 * unique-local. Because the connection uses the addresses that lookup returned, a name
 * that answers differently a moment later (DNS rebinding) cannot slip past. A literal
 * address never reaches lookup; ssrfReason has already judged it. Every redirect hop
 * comes back through here.
 */
export function pinnedFetch(url: URL, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: init.headers, signal: init.signal, lookup: checkedLookup }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        else if (value !== undefined) headers.set(name, value);
      }
      const status = res.statusCode ?? 502;
      // A Response cannot carry a body for these statuses.
      const bodyless = status === 204 || status === 205 || status === 304;
      if (bodyless) res.resume();
      resolveResponse(
        new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status: status >= 200 && status <= 599 ? status : 502,
          headers,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** dns.lookup, refusing any name that resolves to an address the web tool may not reach. */
const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as unknown as LookupAddress[];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (blocked) {
      const refusal = Object.assign(
        new Error(`refusing ${hostname}: it resolves to a private/loopback address (${blocked.address})`),
        { code: "EPRIVATEADDRESS" },
      );
      return callback(refusal, "", 0);
    }
    if (list.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

/** A resolved address the web tool must not connect to (pure). */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) return ssrfReason(new URL(`https://[${address}]/`)) !== null;
  const v4 = asIPv4(address);
  return v4 !== null && isPrivateV4(v4);
}

/** How the web tool makes a request; replaceable so tests need no network. */
export const webTransport: { fetch: (url: URL, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response> } = {
  fetch: pinnedFetch,
};

/** Read a response body, stopping once past the byte cap. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= DOWNLOAD_CAP_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── transform ───────────────────────────────────────────────────────────────

function htmlToMarkdown(html: string): string {
  try {
    return turndown().turndown(html).replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // Fall back to a crude tag-strip if turndown chokes on malformed markup.
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

/** One cheap model call to answer `prompt` from the page. null on any failure. */
async function distill(content: string, prompt: string, ctx?: ToolContext): Promise<string | null> {
  try {
    const turn = await activeDriver().toolTurn({
      system:
        "You extract information from a web page to answer the user's request. " +
        "Answer only from the content provided; be concise and include relevant " +
        "code or quotes. If the answer isn't present, say so.",
      messages: [{ role: "user", content: `Web page content:\n---\n${content}\n---\n\nRequest: ${prompt}` }],
    });
    // A distillation is a real model call on the user's key, made on the agent's
    // initiative rather than the user's. Reporting it keeps the meter from being
    // short by exactly the work nobody could see.
    if (turn.usage) ctx?.reportUsage?.(turn.usage);
    return turn.content.trim() || null;
  } catch {
    return null;
  }
}

// ── url + safety ──────────────────────────────────────────────────────────────

/** Validate, default-to-https, and upgrade http→https. Returns a URL or an error string. */
export function normalizeUrl(raw: string): URL | string {
  let text = raw;
  if (!/^[a-z]+:\/\//i.test(text)) text = "https://" + text; // bare host → https
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `Invalid URL: "${raw}".`;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return `Unsupported URL scheme "${url.protocol}" — only http/https.`;
  return url;
}

/**
 * SSRF guard: refuse localhost, private, and link-local hosts.
 *
 * Pure, and deliberately so — every hop of a redirect chain is put through it, and a
 * check that needed I/O could not be run that often.
 *
 * Three things this covers beyond the obvious dotted-quad:
 *
 *  - **IPv6.** Blocking only `::1` left unique-local (`fc00::/7`) and link-local
 *    (`fe80::/10`) wide open, which is most of what an internal IPv6 network uses.
 *  - **Alternate IPv4 encodings.** `http://2130706433/` is `127.0.0.1` written as a
 *    single decimal, and `0x7f.1` is the same host again. A string match on
 *    "127." sees neither, and every SSRF filter-bypass list opens with this.
 *  - **169.254.0.0/16**, which is where cloud instance metadata lives. It was
 *    already covered, and it is the reason the rest matters.
 *
 * This reads the address TEXT only. A name that resolves to a private address is
 * caught when connecting instead, by the lookup in `pinnedFetch`.
 */
export function ssrfReason(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return `Refusing to fetch a local address (${host}).`;
  }

  // IPv6 literals arrive from `URL` still wrapped in brackets.
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return `Refusing to fetch a loopback address (${host}).`;
    // fc00::/7 (unique-local) and fe80::/10 (link-local).
    if (/^f[cd][0-9a-f]{0,2}:/i.test(v6) || /^fe[89ab][0-9a-f]?:/i.test(v6)) {
      return `Refusing to fetch a private/link-local address (${host}).`;
    }
    // IPv4 wearing an IPv6 hat. Both spellings have to be handled, because `URL`
    // rewrites the readable one: `[::ffff:127.0.0.1]` is normalised to
    // `[::ffff:7f00:1]` before this ever sees it, so matching only dotted form
    // would catch nothing at all.
    const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(v6);
    if (mappedDotted && isPrivateV4(mappedDotted[1]!)) {
      return `Refusing to fetch a private/loopback address (${host}).`;
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6);
    if (mappedHex) {
      const n = (parseInt(mappedHex[1]!, 16) << 16) | parseInt(mappedHex[2]!, 16);
      const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      if (isPrivateV4(dotted)) return `Refusing to fetch a private/loopback address (${host}).`;
    }
    return null;
  }
  if (host === "::1" || host === "::") return `Refusing to fetch a loopback address (${host}).`;

  const v4 = asIPv4(host);
  if (v4 && isPrivateV4(v4)) return `Refusing to fetch a private/loopback address (${host}).`;
  return null;
}

/**
 * Normalise anything that is really an IPv4 address into dotted-quad, or null (pure).
 *
 * Covers dotted decimal, a bare 32-bit integer (`2130706433`), and hex/octal parts
 * (`0x7f.0.0.1`, `0177.0.0.1`) — the standard filter-bypass encodings. Anything that
 * is not unambiguously an address returns null and is treated as a hostname.
 */
export function asIPv4(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = Number(p);
    else return null;
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums.join(".");
}

/** Is a dotted-quad in a loopback, private, or link-local range? (pure) */
function isPrivateV4(dotted: string): boolean {
  const p = dotted.split(".").map(Number);
  const [a, b] = [p[0]!, p[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, and cloud instance metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

function isTextual(contentType: string): boolean {
  if (!contentType) return true; // unknown — assume text and let cleanup handle it
  return (
    contentType.includes("text/") ||
    contentType.includes("html") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("markdown")
  );
}

function hostOf(u: string | URL): string {
  try {
    return new URL(u.toString()).hostname;
  } catch {
    return String(u);
  }
}


/** The fetch half of the merged `web` tool. Logic unchanged. */
export const fetchWeb = webFetchTool.execute;

/** Kept for tests that assert on the fetch description/flags directly. */
export const webFetch = webFetchTool;
