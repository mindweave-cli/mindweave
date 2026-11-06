/**
 * index.ts — the one door the rest of Mindweave uses to authorize an MCP server.
 *
 * Everything under `oauth/` is a step; this is the sequence. Two entry points, and the
 * split between them is the whole design:
 *
 *  - `authHeaders()` runs on EVERY request and must be silent, fast and never open a
 *    browser. It hands back a token if one is stored, refreshes it first if it has
 *    expired, and returns nothing at all if there is no credential — a request with no
 *    Authorization header is how we learn a server wants one, so failing to produce a
 *    token is a normal outcome rather than an error.
 *  - `authenticate()` runs when a PERSON asked for it, and is the only thing allowed to
 *    open a browser and hold a port. It never runs on its own: a connection that hits a
 *    401 goes to `needs-auth` and STOPS. A background retry that pops a browser window
 *    for a server the user forgot they configured is a worse outcome than a server that
 *    plainly says it needs signing in.
 *
 * An expired refresh is treated as no credential rather than as a failure: refresh tokens
 * are revoked from dashboards all the time, and the right response is to offer signing in
 * again, not to report a broken connection.
 */
import { spawn } from "node:child_process";
import { authorizeUrl, discover, exchangeCode, isTransientNetworkError, refreshTokens, registerClient, revokeToken, TokenRequestError, type FetchLike } from "./flow.js";
import { createPkce, randomState } from "./pkce.js";
import { findAvailablePort, redirectUri, waitForCallback } from "./callback.js";
import { clearAuth, isExpired, readAuth, serverKey, writeAuth, type StoredAuth } from "./tokenStore.js";
import type { AuthChallenge } from "./metadata.js";
import { clientSecretFor, type McpServerConfig } from "../config.js";

export { serverKey, clearAuth } from "./tokenStore.js";
export { parseWwwAuthenticate, type AuthChallenge } from "./metadata.js";

/**
 * The Authorization header for a server, or `{}` when there is nothing stored.
 *
 * Refreshes in place and persists the result, so a long session does not accumulate one
 * expired token per hour. A refresh that fails is classified before anything is thrown
 * away: only `invalid_grant` — the refresh token itself being dead — clears the
 * credential. See the catch below for why both directions of that judgement are costly.
 */
export async function authHeaders(name: string, config: McpServerConfig, fetchImpl: FetchLike = fetch): Promise<Record<string, string>> {
  const key = serverKey(name, config);
  const stored = await readAuth(key);
  if (!stored) return {};
  if (!isExpired(stored)) return { authorization: `Bearer ${stored.accessToken}` };

  if (!stored.refreshToken) {
    await clearAuth(key);
    return {};
  }
  try {
    const refreshed = await refreshTokens(
      {
        tokenEndpoint: stored.tokenEndpoint,
        clientId: stored.clientId,
        ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
        refreshToken: stored.refreshToken,
        ...(stored.resource ? { resource: stored.resource } : {}),
      },
      fetchImpl,
    );
    const next: StoredAuth = {
      ...stored,
      accessToken: refreshed.accessToken,
      ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.scope ? { scope: refreshed.scope } : {}),
    };
    await writeAuth(key, next);
    return { authorization: `Bearer ${next.accessToken}` };
  } catch (error) {
    // WHAT KIND of failure decides whether the credential survives, and getting this
    // wrong in either direction is expensive: clear too eagerly and a dropped packet
    // signs the user out, keep too stubbornly and a revoked token is re-sent forever
    // while the sign-in that would fix it is never offered.
    const kind = error instanceof TokenRequestError ? error.kind : isTransientNetworkError(error) ? "transient" : "other";
    if (kind !== "invalid_grant") {
      // Not the credential's fault. Send nothing this time — the request will 401 and the
      // connection will say so — but keep what we have for the next attempt.
      return {};
    }

    // `invalid_grant` usually means the refresh token is dead. It also means exactly this
    // when ANOTHER Mindweave session refreshed a moment ago on a server that rotates
    // refresh tokens: ours became invalid because theirs succeeded. Re-reading before
    // clearing is what tells the two apart, and without it a second open session is a
    // reliable way to sign yourself out of the first.
    const current = await readAuth(key);
    if (current && current.accessToken !== stored.accessToken && !isExpired(current)) {
      return { authorization: `Bearer ${current.accessToken}` };
    }
    await clearAuth(key);
    return {};
  }
}

/** How long to let the browser get on with it before offering the raw URL. Long enough
 *  that a working launch never shows it, short enough that someone staring at a terminal
 *  which appears to have done nothing is not left guessing. */
const URL_FALLBACK_DELAY_MS = 4_000;

export interface AuthenticateOptions {
  name: string;
  config: McpServerConfig;
  /** What the 401 said, when we have it. Skips a guess or two and gets the scope right. */
  challenge?: AuthChallenge;
  /** Told the URL before the browser is launched, so the user can open it by hand when
   *  the launch silently fails (which it does, on machines with no default browser). */
  onUrl?: (url: string) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Injectable so a test never launches anything. */
  openUrl?: (url: string) => void;
}

/**
 * Sign in to one server, end to end, and persist what comes back.
 *
 * The port is bound BEFORE the authorize URL is built, because the redirect URI is part
 * of what gets signed into the request and part of what the client registers with, so it
 * has to be the real one rather than a guess corrected later.
 */
export async function authenticate(options: AuthenticateOptions): Promise<void> {
  const { name, config, challenge = {}, onUrl, signal, fetchImpl = fetch, openUrl = openInBrowser } = options;
  if (config.type !== "http") throw new Error("only http servers can be signed in to; a local command server has no authorization server");

  const key = serverKey(name, config);
  const overrides = config.oauth;
  const { authServer, resource } = await discover(config.url, challenge, fetchImpl, overrides?.authServerMetadataUrl);

  // A hand-registered client has an EXACT redirect URI recorded against it, so a
  // configured client id and a configured port travel together — the random port the
  // automatic flow picks would not match what was registered.
  const port = overrides?.callbackPort ?? (await findAvailablePort());
  const redirect = redirectUri(port);

  // Three ways to have a client id, in order of how deliberate they are: named in the
  // config by someone who registered it by hand, carried over from a previous sign-in, or
  // registered now. Registering afresh on every attempt leaves a trail of one-shot clients
  // on the authorization server, and several of them start refusing once that list gets long.
  const configuredSecret = clientSecretFor(name);
  const previous = await readAuth(key);
  const registration = overrides?.clientId
    ? { clientId: overrides.clientId, ...(configuredSecret ? { clientSecret: configuredSecret } : {}) }
    : previous?.clientId && previous.tokenEndpoint === authServer.tokenEndpoint
      ? { clientId: previous.clientId, ...(previous.clientSecret ?? configuredSecret ? { clientSecret: previous.clientSecret ?? configuredSecret } : {}) }
      : await registerClient(authServer, redirect, fetchImpl);

  const pkce = createPkce();
  const state = randomState();
  const scope = scopeFor(challenge, resource, authServer);
  const url = authorizeUrl({
    meta: authServer,
    clientId: registration.clientId,
    redirect,
    pkce,
    state,
    ...(scope ? { scope } : {}),
    ...(resource?.resource ? { resource: resource.resource } : {}),
  });

  // Start listening BEFORE the browser is told where to go. A fast redirect arriving at a
  // port nobody is on yet is a flow that fails for no reason the user can see.
  const waiting = waitForCallback({ port, state, ...(signal ? { signal } : {}) });
  openUrl(url);

  // THE URL IS A FALLBACK, NOT THE INSTRUCTION. It is 400 characters of query string, and
  // printing it up front means every successful sign-in — the overwhelming majority —
  // dumps a wall of unreadable text into the transcript to say something the browser
  // window already said better. So it waits: if the browser opened, the callback lands
  // first and the URL is never shown. If nothing opened, a few seconds of silence is
  // exactly when someone starts wondering what to do, and that is when it appears.
  const hint = setTimeout(() => onUrl?.(url), URL_FALLBACK_DELAY_MS);
  hint.unref?.();

  let code: string;
  try {
    ({ code } = await waiting);
  } finally {
    clearTimeout(hint);
  }
  const tokens = await exchangeCode(
    {
      meta: authServer,
      clientId: registration.clientId,
      ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
      redirect,
      code,
      verifier: pkce.verifier,
      ...(resource?.resource ? { resource: resource.resource } : {}),
    },
    fetchImpl,
  );

  await writeAuth(key, {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    clientId: registration.clientId,
    ...(registration.clientSecret ? { clientSecret: registration.clientSecret } : {}),
    tokenEndpoint: authServer.tokenEndpoint,
    // Kept so signing out can tell the server the token is finished with, rather than
    // only forgetting it locally and leaving it valid until it expires on its own.
    ...(authServer.revocationEndpoint ? { revocationEndpoint: authServer.revocationEndpoint } : {}),
    ...(resource?.resource ? { resource: resource.resource } : {}),
  });
}

/**
 * Forget a server's credential, and tell the server so where it will listen.
 *
 * The local record goes FIRST and unconditionally. Revocation is a courtesy that makes
 * the token stop working rather than merely stop being used, but a server that is down,
 * or that never implemented RFC 7009, must not be able to keep someone signed in.
 */
export async function signOut(name: string, config: McpServerConfig, fetchImpl: FetchLike = fetch): Promise<void> {
  const key = serverKey(name, config);
  const stored = await readAuth(key);
  await clearAuth(key);
  if (!stored?.revocationEndpoint) return;

  const base = {
    revocationEndpoint: stored.revocationEndpoint,
    clientId: stored.clientId,
    ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
  };
  // The refresh token first: it is the one that would otherwise keep minting new access
  // tokens long after this.
  if (stored.refreshToken) await revokeToken({ ...base, token: stored.refreshToken, hint: "refresh_token", accessToken: stored.accessToken }, fetchImpl);
  await revokeToken({ ...base, token: stored.accessToken, hint: "access_token" }, fetchImpl);
}

/** Whether we hold anything for this server, without producing it. Drives whether the
 *  manage screen offers "Sign in" or "Sign out". */
export async function hasCredential(name: string, config: McpServerConfig): Promise<boolean> {
  return (await readAuth(serverKey(name, config))) !== undefined;
}

/** The 401's scope, then the resource's, then the authorization server's own advertised
 *  list. The last one is a guess and is used only because some servers reject an
 *  authorize request carrying no scope at all. */
function scopeFor(challenge: AuthChallenge, resource: ResourceLike, authServer: { scopesSupported?: string[] }): string | undefined {
  if (challenge.scope?.trim()) return challenge.scope.trim();
  if (resource?.scopesSupported?.length) return resource.scopesSupported.join(" ");
  if (authServer.scopesSupported?.length) return authServer.scopesSupported.join(" ");
  return undefined;
}

type ResourceLike = { scopesSupported?: string[] } | null;

/**
 * The program and arguments that open `url` in the user's browser, or null when it is not a web address (pure).
 *
 * Never through `cmd /c start`: cmd reads `&`, `|`, `^` and `%` in the address, so an ordinary sign-in link
 * (`?response_type=code&client_id=...`) was cut at the first `&`, and a server's `authorization_endpoint` could
 * carry a second command. `rundll32 url.dll,FileProtocolHandler` takes the address as one argument and runs nothing
 * else. Only http and https are handed over: any other scheme is a handler for some other program.
 */
export function browserCommand(url: string, platform: string = process.platform): { command: string; args: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const href = parsed.href;
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
  if (platform === "darwin") return { command: "open", args: [href] };
  return { command: "xdg-open", args: [href] };
}

/**
 * Hand a URL to whatever the user's machine calls a browser.
 *
 * Detached and with its streams discarded, because this must not become a child whose
 * exit we wait on or whose output lands in the middle of the UI. A failure here is
 * swallowed on purpose: the URL was already reported through `onUrl`, so a machine with
 * no default browser leaves the user able to copy it rather than staring at an error
 * about a program they did not ask us to run.
 */
function openInBrowser(url: string): void {
  try {
    const run = browserCommand(url);
    if (!run) return; // reported through onUrl already; the user can copy it
    const child = spawn(run.command, run.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Reported through onUrl already.
  }
}
