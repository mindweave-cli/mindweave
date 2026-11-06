/**
 * flow.test.ts — the discovery chain and the two token grants, against a fake server.
 *
 * Driven with an injected `fetch` rather than a real listener: what is being checked is
 * WHICH url gets asked and WHAT is in the form body, and both of those are visible from
 * the call log without a socket. The one thing that genuinely needs a socket — the
 * loopback redirect — is `callback.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, discover, exchangeCode, refreshTokens, registerClient } from "./flow.js";
import { createPkce } from "./pkce.js";
import type { AuthServerMetadata } from "./metadata.js";

/** A fetch that answers from a map of url → body, records every call, and 404s the rest
 *  (which is what a server that has never heard of a well-known path really does). */
function fakeFetch(routes: Record<string, unknown>, log: { url: string; body?: string }[] = []) {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    log.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit instanceof Response) return hit;
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl as unknown as typeof fetch, log };
}

const AS = {
  issuer: "https://auth.x.dev",
  authorization_endpoint: "https://auth.x.dev/authorize",
  token_endpoint: "https://auth.x.dev/token",
  registration_endpoint: "https://auth.x.dev/register",
  code_challenge_methods_supported: ["S256"],
};

const meta: AuthServerMetadata = {
  issuer: "https://auth.x.dev",
  authorizationEndpoint: "https://auth.x.dev/authorize",
  tokenEndpoint: "https://auth.x.dev/token",
  registrationEndpoint: "https://auth.x.dev/register",
};

test("discovery follows the 401's metadata URL straight to the authorization server", async () => {
  const { fetch: f, log } = fakeFetch({
    "https://mcp.x.dev/.well-known/oauth-protected-resource/mcp": {
      resource: "https://mcp.x.dev/mcp",
      authorization_servers: ["https://auth.x.dev"],
    },
    "https://auth.x.dev/.well-known/oauth-authorization-server": AS,
  });
  const found = await discover(
    "https://mcp.x.dev/mcp",
    { resourceMetadata: "https://mcp.x.dev/.well-known/oauth-protected-resource/mcp" },
    f,
  );
  assert.equal(found.authServer.tokenEndpoint, "https://auth.x.dev/token");
  assert.equal(found.resource?.resource, "https://mcp.x.dev/mcp");
  // The named URL is asked FIRST — the whole point of the header is skipping the guesses.
  assert.equal(log[0]!.url, "https://mcp.x.dev/.well-known/oauth-protected-resource/mcp");
});

test("with no 401 header at all, the well-known locations are tried in order", async () => {
  const { fetch: f, log } = fakeFetch({
    "https://mcp.x.dev/.well-known/oauth-protected-resource": { authorization_servers: ["https://auth.x.dev"] },
    "https://auth.x.dev/.well-known/oauth-authorization-server": AS,
  });
  const found = await discover("https://mcp.x.dev/mcp", {}, f);
  assert.equal(found.authServer.tokenEndpoint, "https://auth.x.dev/token");
  // Path-aware first (RFC 9728), root second — and it took the second because the first
  // 404'd, which is the fallback doing its job rather than being skipped.
  assert.equal(log[0]!.url, "https://mcp.x.dev/.well-known/oauth-protected-resource/mcp");
  assert.equal(log[1]!.url, "https://mcp.x.dev/.well-known/oauth-protected-resource");
});

test("a server that is its own authorization server needs no resource document", async () => {
  // A large share of deployed servers predate RFC 9728 entirely and publish only RFC 8414
  // metadata. Refusing those on a technicality would refuse most of the ecosystem.
  const { fetch: f } = fakeFetch({ "https://mcp.x.dev/.well-known/oauth-authorization-server": AS });
  const found = await discover("https://mcp.x.dev/mcp", {}, f);
  assert.equal(found.authServer.tokenEndpoint, "https://auth.x.dev/token");
  assert.equal(found.resource, null);
});

test("a server with no OAuth metadata anywhere says so in a sentence, not a stack trace", async () => {
  const { fetch: f } = fakeFetch({});
  await assert.rejects(() => discover("https://mcp.x.dev/mcp", {}, f), /publishes no OAuth metadata/);
});

test("an authorization server that cannot do S256 is refused outright", async () => {
  const { fetch: f } = fakeFetch({
    "https://mcp.x.dev/.well-known/oauth-authorization-server": { ...AS, code_challenge_methods_supported: ["plain"] },
  });
  await assert.rejects(() => discover("https://mcp.x.dev/mcp", {}, f), /S256/);
});

test("registration asks for a public native client and keeps the id it is given", async () => {
  const { fetch: f, log } = fakeFetch({ "https://auth.x.dev/register": { client_id: "abc123" } });
  const reg = await registerClient(meta, "http://127.0.0.1:41234/callback", f);
  assert.equal(reg.clientId, "abc123");
  assert.equal(reg.clientSecret, undefined);

  const body = JSON.parse(log[0]!.body!) as Record<string, unknown>;
  assert.deepEqual(body.redirect_uris, ["http://127.0.0.1:41234/callback"]);
  // A CLI cannot keep a secret, so it must not claim to be able to authenticate with one.
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
});

test("a server without dynamic registration is a wall, and the message does not imply a retry", async () => {
  const { registrationEndpoint: _drop, ...noRegistration } = meta;
  const { fetch: f } = fakeFetch({});
  await assert.rejects(() => registerClient(noRegistration, "http://127.0.0.1:1/callback", f), /does not support automatic client registration/);
});

test("the authorize URL carries the challenge, never the verifier", () => {
  const pkce = createPkce();
  const url = new URL(
    authorizeUrl({ meta, clientId: "abc", redirect: "http://127.0.0.1:41234/callback", pkce, state: "st4te", scope: "read", resource: "https://mcp.x.dev/mcp" }),
  );
  assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("resource"), "https://mcp.x.dev/mcp", "RFC 8707 binds the token to this one server");
  // Sending the verifier here would hand it to everything that can see the URL — the
  // browser history, the referrer, anything proxying — and PKCE would prove nothing.
  assert.equal(url.toString().includes(pkce.verifier), false, "the verifier must never reach the authorize URL");
});

test("the code exchange sends the verifier and turns expires_in into an absolute moment", async () => {
  const { fetch: f, log } = fakeFetch({
    "https://auth.x.dev/token": { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read" },
  });
  const before = Date.now();
  const tokens = await exchangeCode(
    { meta, clientId: "abc", redirect: "http://127.0.0.1:1/callback", code: "the-code", verifier: "the-verifier", resource: "https://mcp.x.dev/mcp" },
    f,
  );
  assert.equal(tokens.accessToken, "at");
  assert.equal(tokens.refreshToken, "rt");
  // Seconds-from-now is meaningless once written to a file and read back tomorrow.
  assert.ok(tokens.expiresAt! >= before + 3_600_000 && tokens.expiresAt! <= Date.now() + 3_600_000);

  const form = new URLSearchParams(log[0]!.body!);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code_verifier"), "the-verifier");
  assert.equal(form.get("resource"), "https://mcp.x.dev/mcp");
});

test("a refresh that returns no new refresh token keeps the old one", async () => {
  // Some servers rotate refresh tokens and some do not. Dropping the old one on a server
  // that does not would sign the user out an hour later for no reason at all.
  const { fetch: f } = fakeFetch({ "https://auth.x.dev/token": { access_token: "new-at", expires_in: 60 } });
  const tokens = await refreshTokens({ tokenEndpoint: meta.tokenEndpoint, clientId: "abc", refreshToken: "old-rt" }, f);
  assert.equal(tokens.accessToken, "new-at");
  assert.equal(tokens.refreshToken, "old-rt");
});

test("an OAuth error body is reported as its own words, not as a status code", async () => {
  const { fetch: f } = fakeFetch({
    "https://auth.x.dev/token": new Response(JSON.stringify({ error: "invalid_grant", error_description: "Authorization code expired" }), {
      status: 400,
    }),
  });
  await assert.rejects(
    () => refreshTokens({ tokenEndpoint: meta.tokenEndpoint, clientId: "abc", refreshToken: "rt" }, f),
    /invalid_grant: Authorization code expired/,
  );
});

test("a token response with no access token is a failure, not an empty success", async () => {
  const { fetch: f } = fakeFetch({ "https://auth.x.dev/token": { token_type: "Bearer" } });
  await assert.rejects(
    () => refreshTokens({ tokenEndpoint: meta.tokenEndpoint, clientId: "abc", refreshToken: "rt" }, f),
    /no access token/,
  );
});

test("checkDiscovered refuses a sign-in whose pieces disagree", async () => {
  const { checkDiscovered, sameResource } = await import("./flow.js");
  const meta = (o: Record<string, string>) => ({ issuer: "", authorizationEndpoint: "https://accounts.real.example/authorize", tokenEndpoint: "https://accounts.real.example/token", ...o });
  const ok = (m: ReturnType<typeof meta>, resource: string | null = null) => checkDiscovered({ authServer: m, resource: resource ? { authorizationServers: [], resource } : null } as never, "https://mcp.real.example/mcp");
  assert.doesNotThrow(() => ok(meta({})));
  assert.doesNotThrow(() => ok(meta({ tokenEndpoint: "https://api.real.example/token" })), "the same site on another host is normal");
  assert.throws(() => ok(meta({ tokenEndpoint: "https://evil.example/token" })), /third party/);
  assert.throws(() => ok(meta({ tokenEndpoint: "http://accounts.real.example/token" })), /not https/);
  assert.throws(() => ok(meta({ authorizationEndpoint: "http://accounts.real.example/authorize" })), /not https/);
  assert.doesNotThrow(() => checkDiscovered({ authServer: meta({ authorizationEndpoint: "http://127.0.0.1:5/a", tokenEndpoint: "http://127.0.0.1:5/t" }), resource: null } as never, "http://127.0.0.1:5/mcp"), "a server on this machine may be plain http");
  assert.throws(() => ok(meta({}), "https://victim.example/api"), /different resource/);
  assert.doesNotThrow(() => ok(meta({}), "https://mcp.real.example"));
  assert.doesNotThrow(() => ok(meta({}), "https://mcp.real.example/mcp/"));
  assert.equal(sameResource("https://mcp.real.example/other", "https://mcp.real.example/mcp"), false);
});