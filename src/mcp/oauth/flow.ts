/**
 * flow.ts — the network half of authorization: ask who issues tokens, get a client id,
 * send the user to approve, redeem the code, and refresh it later.
 *
 * `metadata.ts` decides WHAT to fetch and how to read the answers; this file does the
 * fetching and the four POSTs. Split that way because the branching is all in the
 * parsing, and a test that has to stand up an HTTP server to check a fallback ordering is
 * a test nobody keeps working.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: every step reports the sentence a user can act on. An
 * authorization failure is not a stack trace and is very rarely OUR bug — it is a
 * consent screen that was declined, a server without dynamic registration, a token that
 * was revoked in a dashboard an hour ago. The error strings here are the product.
 */
import {
  authServerUrls,
  protectedResourceUrls,
  readAuthServerMetadata,
  readResourceMetadata,
  supportsS256,
  type AuthChallenge,
  type AuthServerMetadata,
  type ResourceMetadata,
} from "./metadata.js";
import type { Pkce } from "./pkce.js";

/** Injectable everywhere so the whole flow is testable without a network. */
export type FetchLike = typeof fetch;

/** How long any single metadata or token request may take. Generous rather than snappy:
 *  an authorization server is very often a cold serverless function, and a discovery that
 *  gives up at five seconds fails for a reason that has nothing to do with the user. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Why a token request failed, which decides what happens to the stored credential.
 *
 * This distinction is the difference between a working sign-in and being signed out by a
 * dropped packet. `invalid_grant` means the refresh token itself is dead and keeping it
 * would send something useless forever; EVERY other failure — a timeout, a 503, a rate
 * limit, a misconfigured client — leaves a credential that is probably still good, and
 * throwing it away turns a blip into a browser round trip the user has to notice.
 */
export type FailureKind = "invalid_grant" | "transient" | "other";

export class TokenRequestError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

/**
 * Error codes that MEAN `invalid_grant` without saying it.
 *
 * Not pedantry: at least one widely used provider answers a dead refresh token with its
 * own vocabulary, and treating that as an unknown failure means never clearing a
 * credential that will never work again — the user sits in a silent retry loop instead of
 * being offered the sign-in that would fix it.
 */
const INVALID_GRANT_ALIASES = new Set(["invalid_refresh_token", "expired_refresh_token", "token_expired"]);

/** Statuses worth trying again. 408/429 and the 5xx family are the server saying "not
 *  now" rather than "no". */
function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** A thrown error that is the network rather than the server: a timeout, a reset, a DNS
 *  failure. All of them are "try again", none of them say anything about the credential. */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TokenRequestError) return error.kind === "transient";
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|aborted/.test(message);
}

/** What the client calls itself when it registers. Not a brand exercise: an
 *  authorization server shows this string on the consent screen and in the user's list of
 *  connected applications, so it has to say which program is asking. */
const CLIENT_NAME = "Mindweave";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The last two labels of a host: a stand-in for "the same site" (pure). */
function siteOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/** Does `resource` (an RFC 9728 identifier) name the server at `serverUrl`? Same origin, and the server's path is under it (pure). */
export function sameResource(resource: string, serverUrl: string): boolean {
  try {
    const r = new URL(resource);
    const s = new URL(serverUrl);
    if (r.origin !== s.origin) return false;
    const rp = r.pathname.replace(/\/+$/, "");
    return rp === "" || s.pathname === rp || s.pathname.startsWith(rp + "/");
  } catch {
    return false;
  }
}

/**
 * Refuse metadata that points the sign-in somewhere its own server did not (pure). A server (or a repository's server
 * entry) controls every document in the discovery chain, so the pieces have to agree with each other:
 *  - every endpoint is https (plain http only to this machine), so a code is never sent in the clear;
 *  - the token endpoint, which receives the code and the PKCE verifier, belongs to the same site as the page the user
 *    consents at or the server being signed in to. A real provider's consent page with a stranger's token endpoint
 *    would hand the stranger a code it can redeem;
 *  - the RFC 9728 resource names this server, so a token for somebody else's API is never requested for it.
 * Throws a sentence for the user; returns when everything agrees.
 */
export function checkDiscovered(found: Discovered, serverUrl: string): void {
  const meta = found.authServer;
  const urls: [string, string][] = [
    ["authorization endpoint", meta.authorizationEndpoint],
    ["token endpoint", meta.tokenEndpoint],
    ...(meta.registrationEndpoint ? ([["registration endpoint", meta.registrationEndpoint]] as [string, string][]) : []),
  ];
  const parsed = new Map<string, URL>();
  for (const [label, raw] of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`the ${label} (${raw}) is not a web address`);
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) {
      throw new Error(`the ${label} (${u.origin}) is not https, so the sign-in would travel unprotected`);
    }
    parsed.set(label, u);
  }
  const token = parsed.get("token endpoint")!;
  const consent = parsed.get("authorization endpoint")!;
  const server = new URL(serverUrl);
  const sameSite = (a: URL, b: URL) => a.origin === b.origin || (!LOOPBACK_HOSTS.has(a.hostname) && siteOf(a.hostname) === siteOf(b.hostname));
  if (!sameSite(token, consent) && !sameSite(token, server)) {
    throw new Error(
      `the token endpoint (${token.origin}) is on a different site from the sign-in page (${consent.origin}) and from this server (${server.origin}), ` +
        "so the sign-in code would go to a third party; refusing",
    );
  }
  if (found.resource?.resource && !sameResource(found.resource.resource, serverUrl)) {
    throw new Error(`the server's resource metadata is for a different resource (${found.resource.resource})`);
  }
}

export interface Discovered {
  authServer: AuthServerMetadata;
  resource: ResourceMetadata | null;
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    // A candidate URL that 404s, times out or is not JSON is not an error, it is a
    // candidate that was wrong — the caller has more to try.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the chain: the 401's metadata URL (or the well-known guesses) to the resource
 * document, the resource document to its authorization servers, and each of those to its
 * own metadata.
 *
 * FALLS THROUGH TO THE SERVER ITSELF when there is no resource document anywhere. A great
 * many deployed servers are their own authorization server and publish RFC 8414 metadata
 * directly, having never implemented the newer RFC 9728 layer at all, and refusing those
 * would be refusing a large part of the ecosystem to honour a document nobody promised.
 */
export async function discover(
  serverUrl: string,
  challenge: AuthChallenge,
  fetchImpl: FetchLike = fetch,
  /** A metadata document named in the config, for a server that publishes none of the
   *  discovery documents. Tried alone: if someone went to the trouble of naming it, a
   *  silent fallback to guessing would hide the fact that it was wrong. */
  configuredMetadataUrl?: string,
): Promise<Discovered> {
  if (configuredMetadataUrl) {
    const meta = readAuthServerMetadata(await getJson(configuredMetadataUrl, fetchImpl));
    if (!meta) throw new Error(`no usable OAuth metadata at the configured authServerMetadataUrl (${configuredMetadataUrl})`);
    if (!supportsS256(meta)) throw new Error(`${configuredMetadataUrl} does not offer PKCE with S256, which is required to sign in safely`);
    const configured: Discovered = { authServer: meta, resource: null };
    checkDiscovered(configured, serverUrl);
    return configured;
  }

  const resourceCandidates = challenge.resourceMetadata
    ? [challenge.resourceMetadata, ...protectedResourceUrls(serverUrl)]
    : protectedResourceUrls(serverUrl);

  let resource: ResourceMetadata | null = null;
  for (const candidate of resourceCandidates) {
    const parsed = readResourceMetadata(await getJson(candidate, fetchImpl));
    if (parsed) {
      resource = parsed;
      break;
    }
  }

  const issuers = resource ? resource.authorizationServers : [new URL(serverUrl).origin, serverUrl];
  for (const issuer of issuers) {
    for (const candidate of authServerUrls(issuer)) {
      const meta = readAuthServerMetadata(await getJson(candidate, fetchImpl));
      if (!meta) continue;
      if (!supportsS256(meta)) {
        throw new Error(`${issuer} does not offer PKCE with S256, which is required to sign in safely`);
      }
      const found: Discovered = { authServer: meta, resource };
      checkDiscovered(found, serverUrl);
      return found;
    }
  }

  throw new Error(
    resource
      ? `this server names an authorization server (${issuers[0] ?? "unknown"}) that publishes no usable OAuth metadata`
      : "this server asked for authorization but publishes no OAuth metadata, so there is nothing to sign in to",
  );
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
}

/**
 * Register as a new client (RFC 7591), because a CLI has no client id until it asks for
 * one and there is nowhere to type one in.
 *
 * An authorization server with no registration endpoint is a genuine wall, and the error
 * says so plainly rather than implying a retry would help: that server expects a client
 * id created by hand in its dashboard, which is a different feature and a different
 * conversation.
 */
export async function registerClient(meta: AuthServerMetadata, redirect: string, fetchImpl: FetchLike = fetch): Promise<ClientRegistration> {
  if (!meta.registrationEndpoint) {
    throw new Error("this authorization server does not support automatic client registration");
  }
  const response = await fetchImpl(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A public client: see pkce.ts for why a CLI cannot hold a secret. Servers that
      // issue one anyway are handled — we store it — but we do not claim to be able to
      // keep it.
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!response.ok) {
    throw new Error(`could not register with the authorization server (${response.status}): ${await errorText(response)}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  if (!clientId) throw new Error("the authorization server registered us but issued no client id");
  const out: ClientRegistration = { clientId };
  if (typeof body.client_secret === "string" && body.client_secret) out.clientSecret = body.client_secret;
  return out;
}

export interface AuthorizeUrlOptions {
  meta: AuthServerMetadata;
  clientId: string;
  redirect: string;
  pkce: Pkce;
  state: string;
  scope?: string;
  /** RFC 8707. Binds the token to one MCP server so a leak cannot be spent elsewhere. */
  resource?: string;
}

/** The URL to open in the browser (pure). */
export function authorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(options.meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirect);
  url.searchParams.set("code_challenge", options.pkce.challenge);
  url.searchParams.set("code_challenge_method", options.pkce.method);
  url.searchParams.set("state", options.state);
  if (options.scope) url.searchParams.set("scope", options.scope);
  if (options.resource) url.searchParams.set("resource", options.resource);
  return url.toString();
}

/** What a token endpoint gave back, in our shape. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

async function postToken(endpoint: string, form: URLSearchParams, fetchImpl: FetchLike, signal?: AbortSignal): Promise<TokenSet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();

  let response: Response;
  let raw: string;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      signal: controller.signal,
    });
    raw = await response.text();
  } catch (error) {
    // Never reached the server, or did not finish. Says nothing about the credential.
    throw new TokenRequestError(`could not reach the authorization server: ${String((error as Error)?.message ?? error)}`, "transient");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not JSON. Only meaningful if the status already said no.
  }

  // AN ERROR CAN ARRIVE WITH A 200. At least one widely used provider answers every
  // request with 200 and puts the failure in the body, so status alone is not the test —
  // a body carrying `error` is an error whatever the status line claims.
  const declared = typeof body.error === "string" ? body.error : "";
  if (!response.ok || declared) {
    const code = INVALID_GRANT_ALIASES.has(declared) ? "invalid_grant" : declared;
    const description = typeof body.error_description === "string" ? body.error_description : "";
    const kind: FailureKind = code === "invalid_grant" ? "invalid_grant" : transientStatus(response.status) ? "transient" : "other";
    const detail = [code, description].filter(Boolean).join(": ") || clip(raw) || response.statusText || "no detail";
    throw new TokenRequestError(`the authorization server refused the request (${response.status}): ${detail}`, kind);
  }

  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new TokenRequestError("the authorization server returned no access token", "other");
  const out: TokenSet = { accessToken };
  if (typeof body.refresh_token === "string" && body.refresh_token) out.refreshToken = body.refresh_token;
  if (typeof body.scope === "string" && body.scope) out.scope = body.scope;
  // `expires_in` is seconds from now. Converted to an absolute moment here because that
  // is what survives being written to a file and read back tomorrow.
  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in)) {
    out.expiresAt = Date.now() + body.expires_in * 1000;
  } else if (out.refreshToken) {
    // The server did not say, but gave us a way to renew. An hour is the near-universal
    // default, and assuming it means we refresh QUIETLY on schedule rather than finding
    // out through a 401 that sends the user back to a browser. Without a refresh token
    // the guess would buy nothing, so it is not made: see `isExpired`.
    out.expiresAt = Date.now() + 3_600_000;
  }
  return out;
}

export interface ExchangeOptions {
  meta: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  redirect: string;
  code: string;
  verifier: string;
  resource?: string;
}

/** Redeem the authorization code for tokens. */
export async function exchangeCode(options: ExchangeOptions, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirect,
    client_id: options.clientId,
    code_verifier: options.verifier,
  });
  if (options.clientSecret) form.set("client_secret", options.clientSecret);
  if (options.resource) form.set("resource", options.resource);
  return postToken(options.meta.tokenEndpoint, form, fetchImpl);
}

export interface RefreshOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource?: string;
}

/**
 * Trade a refresh token for a new access token.
 *
 * The refresh token is CARRIED FORWARD when the server does not send a new one: many
 * rotate them and many do not, and dropping the old one on a server that does not would
 * sign the user out an hour later for no reason.
 */
export async function refreshTokens(options: RefreshOptions, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  if (options.clientSecret) form.set("client_secret", options.clientSecret);
  if (options.resource) form.set("resource", options.resource);

  // RETRIED, unlike the code exchange. A refresh happens on its own, without anyone
  // watching, against a server that may be briefly rate limiting or restarting — and the
  // cost of giving up early is not a slow request, it is a credential thrown away and a
  // browser round trip the user has to notice. The code exchange is not retried because
  // an authorization code is single-use: a second attempt with the same code is refused
  // by definition, and the user is right there and can simply try again.
  let last: unknown;
  for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
    try {
      const tokens = await postToken(options.tokenEndpoint, form, fetchImpl);
      // Carried forward when the server sends no new one: many rotate refresh tokens and
      // many do not, and dropping the old one on a server that does not would sign the
      // user out an hour later for no reason.
      if (!tokens.refreshToken) tokens.refreshToken = options.refreshToken;
      return tokens;
    } catch (error) {
      last = error;
      const retryable = error instanceof TokenRequestError ? error.kind === "transient" : isTransientNetworkError(error);
      if (!retryable || attempt === REFRESH_ATTEMPTS) throw error;
      await sleep(REFRESH_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/** A millisecond value with an env override, for testing the backoff without spending it
 *  for real. Same pattern the background-shell stall watchdog uses. Unset or invalid falls
 *  back to the default. */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Three tries at 1s and 2s apart. Enough to ride out a restart or a rate limit, short
 *  enough that a genuinely dead server does not hold a request for a minute. */
const REFRESH_ATTEMPTS = 3;
const REFRESH_BACKOFF_MS = envMs("MINDWEAVE_OAUTH_BACKOFF_MS", 1_000);

/**
 * NOT unref'd, and that is the whole point of this comment.
 *
 * Every other timer in this feature is unref'd so a forgotten sign-in cannot hold the
 * process open. This one is the opposite case: it sits inside an AWAITED retry, so the
 * sleep IS the pending work. Unref'ing it lets Node decide the loop has nothing left to
 * do, exit it, and leave the await unsettled forever — a refresh that silently never
 * resumes rather than one that fails. CI caught it as "Promise resolution is still
 * pending but the event loop has already resolved"; it reproduces in four lines of plain
 * Node with no test runner involved.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RevokeOptions {
  revocationEndpoint: string;
  clientId: string;
  clientSecret?: string;
  token: string;
  hint: "access_token" | "refresh_token";
  /** Only for the non-compliant fallback below, where a server answers 401 to proper
   *  client authentication and wants the access token as a Bearer instead. */
  accessToken?: string;
}

/**
 * Tell the authorization server a token is finished with (RFC 7009).
 *
 * BEST EFFORT, and deliberately so: signing out has already succeeded locally by the time
 * this runs, and a server that does not implement revocation, or is simply down, must not
 * turn "signed out" into an error. What this buys is that a token we stop using also
 * stops WORKING, rather than remaining valid on the server until it expires.
 *
 * The client id goes in the BODY rather than an Authorization header, which is what RFC
 * 7009 asks of a public client: the header is for the resource owner, not for identifying
 * which client is revoking.
 */
export async function revokeToken(options: RevokeOptions, fetchImpl: FetchLike = fetch): Promise<void> {
  const post = async (form: URLSearchParams, headers: Record<string, string>): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await fetchImpl(options.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: form.toString(),
        signal: controller.signal,
      });
    } catch {
      return null; // best effort — see above
    } finally {
      clearTimeout(timer);
    }
  };

  const form = new URLSearchParams({ token: options.token, token_type_hint: options.hint });
  // RFC 7009 §2.1 wants client authentication, and WHICH form matters. A client holding a
  // secret is confidential, and strict authorization servers refuse a confidential
  // client's token being revoked by something presenting as public — so a secret goes as
  // HTTP Basic, the default RFC 6749 §2.3.1 form, rather than in the body. A public client
  // identifies itself with `client_id` in the body and nothing else.
  const headers: Record<string, string> = {};
  if (options.clientSecret) {
    const basic = Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  } else {
    form.set("client_id", options.clientId);
  }

  const response = await post(form, headers);
  if (!response || response.ok || response.status !== 401) return;

  // Some servers are not RFC 7009 compliant and want the access token as a Bearer instead.
  // RFC 6749 §2.3.1 forbids presenting two client authentication methods at once, so the
  // body credential is dropped before switching.
  if (!options.accessToken) return;
  const retry = new URLSearchParams({ token: options.token, token_type_hint: options.hint });
  await post(retry, { authorization: `Bearer ${options.accessToken}` });
}

/** An OAuth error body names `error` and `error_description`; anything else is shown
 *  as-is, clipped, because an HTML error page in a terminal helps nobody. */
async function errorText(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return response.statusText || "no detail";
  }
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const error = typeof body.error === "string" ? body.error : "";
    const description = typeof body.error_description === "string" ? body.error_description : "";
    if (error || description) return [error, description].filter(Boolean).join(": ");
  } catch {
    // Not JSON; fall through to the clipped body.
  }
  return clip(raw) || response.statusText || "no detail";
}

/** One line, bounded. A wall of HTML in a terminal helps nobody. */
function clip(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}
