/**
 * index.test.ts — the hot path: producing a header on every request.
 *
 * `authHeaders` runs before each call to an http MCP server, so its failure modes are
 * felt constantly and quietly: a valid token is sent without a round trip, an expired one
 * is refreshed and the result PERSISTED, and — the half that is easy to get wrong — a
 * refresh that FAILS is classified before anything is thrown away. Only a dead refresh
 * token clears the credential. A timeout, a 503 or another session winning a rotation race
 * must not, because each of those signs the user out of something that still works.
 *
 * Sandboxed like `tokenStore.test.ts`, and for the same reason — these write tokens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, hasCredential, signOut } from "./index.js";
import { readAuth, serverKey, writeAuth } from "./tokenStore.js";
import type { McpServerConfig } from "../config.js";

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mw-oauth-idx-"));
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = previous;
  }
}

const config: McpServerConfig = { type: "http", name: "remote", url: "https://mcp.x.dev/mcp" };

function tokenFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

test("no stored credential produces no header at all", async () => {
  await withSandbox(async () => {
    // Not an error: a request with no Authorization is exactly how we learn the server
    // wants one, and that 401 is what starts the flow.
    assert.deepEqual(await authHeaders("remote", config), {});
  });
});

test("a live token is sent as a bearer, with no network call", async () => {
  await withSandbox(async () => {
    const { fetch: f, calls } = tokenFetch({});
    await writeAuth(serverKey("remote", config), {
      accessToken: "live-token",
      clientId: "cid",
      tokenEndpoint: "https://auth.x.dev/token",
      expiresAt: Date.now() + 3_600_000,
    });
    assert.deepEqual(await authHeaders("remote", config, f), { authorization: "Bearer live-token" });
    assert.equal(calls.length, 0, "a valid token must not cost a refresh round trip");
  });
});

test("an expired token is refreshed, sent, AND written back", async () => {
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, {
      accessToken: "stale",
      refreshToken: "rt",
      clientId: "cid",
      tokenEndpoint: "https://auth.x.dev/token",
      expiresAt: Date.now() - 1,
    });
    const { fetch: f, calls } = tokenFetch({ access_token: "fresh", expires_in: 3600 });
    assert.deepEqual(await authHeaders("remote", config, f), { authorization: "Bearer fresh" });
    assert.match(calls[0]!, /grant_type=refresh_token/);

    // Persisted, or every later request in the session spends another refresh — and some
    // servers rotate the refresh token, so that is also a way to lose the credential.
    const stored = await readAuth(key);
    assert.equal(stored?.accessToken, "fresh");
    assert.equal(stored?.refreshToken, "rt", "a server that sent no new refresh token keeps the old one");
    assert.ok((stored?.expiresAt ?? 0) > Date.now(), "the new expiry replaced the old one");
  });
});

test("a refresh that is refused clears the credential instead of keeping a dead token", async () => {
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, {
      accessToken: "stale",
      refreshToken: "revoked",
      clientId: "cid",
      tokenEndpoint: "https://auth.x.dev/token",
      expiresAt: Date.now() - 1,
    });
    const { fetch: f } = tokenFetch({ error: "invalid_grant" }, 400);
    // Refresh tokens get revoked from dashboards all the time. The right answer is to
    // offer signing in again, not to send a token that cannot work on every request.
    assert.deepEqual(await authHeaders("remote", config, f), {});
    assert.equal(await readAuth(key), undefined);
  });
});

test("an expired token with no refresh token is dropped rather than sent", async () => {
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, { accessToken: "stale", clientId: "cid", tokenEndpoint: "https://auth.x.dev/token", expiresAt: Date.now() - 1 });
    assert.deepEqual(await authHeaders("remote", config), {});
    assert.equal(await readAuth(key), undefined);
  });
});

test("hasCredential and signOut agree with what is stored", async () => {
  await withSandbox(async () => {
    assert.equal(await hasCredential("remote", config), false);
    await writeAuth(serverKey("remote", config), { accessToken: "at", clientId: "cid", tokenEndpoint: "https://auth.x.dev/token" });
    assert.equal(await hasCredential("remote", config), true);
    await signOut("remote", config);
    assert.equal(await hasCredential("remote", config), false);
  });
});

// ── what a FAILED refresh is allowed to destroy ─────────────────────────────

/** A fetch that fails `failures` times, then succeeds. Counts every attempt. */
function flakyFetch(failure: () => Response, success: unknown, failures: number) {
  let attempts = 0;
  const impl = async (): Promise<Response> => {
    attempts += 1;
    if (attempts <= failures) return failure();
    return new Response(JSON.stringify(success), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl as unknown as typeof fetch, attempts: () => attempts };
}

const expired = (over: Partial<Record<string, unknown>> = {}) => ({
  accessToken: "stale",
  refreshToken: "rt",
  clientId: "cid",
  tokenEndpoint: "https://auth.x.dev/token",
  expiresAt: Date.now() - 1,
  ...over,
});

test("a transient failure NEVER clears the credential — a dropped packet must not sign you out", async () => {
  // The bug this closes: treating every refresh failure as a dead token. A 503 or a
  // flaky network would throw away a perfectly good refresh token and send the user
  // back to a browser for no reason at all.
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, expired() as never);
    const { fetch: f } = flakyFetch(() => new Response("", { status: 503 }), {}, 99);

    assert.deepEqual(await authHeaders("remote", config, f), {}, "no header this time — the request will 401 honestly");
    const kept = await readAuth(key);
    assert.equal(kept?.refreshToken, "rt", "the credential survived a server-side blip");
  });
});

test("a transient failure is RETRIED before it is given up on", async () => {
  await withSandbox(async () => {
    await writeAuth(serverKey("remote", config), expired() as never);
    const { fetch: f, attempts } = flakyFetch(() => new Response("", { status: 503 }), { access_token: "fresh", expires_in: 3600 }, 2);
    assert.deepEqual(await authHeaders("remote", config, f), { authorization: "Bearer fresh" });
    assert.equal(attempts(), 3, "two failures rode out, the third attempt succeeded");
  });
});

test("only invalid_grant clears, and a non-standard spelling of it still counts", async () => {
  // One widely used provider answers a dead refresh token in its own vocabulary. Treating
  // that as unknown would leave a credential that can never work while never offering the
  // sign-in that fixes it.
  for (const code of ["invalid_grant", "invalid_refresh_token", "expired_refresh_token", "token_expired"]) {
    await withSandbox(async () => {
      const key = serverKey("remote", config);
      await writeAuth(key, expired() as never);
      const { fetch: f } = flakyFetch(() => new Response(JSON.stringify({ error: code }), { status: 400 }), {}, 99);
      assert.deepEqual(await authHeaders("remote", config, f), {});
      assert.equal(await readAuth(key), undefined, `${code} should have cleared the credential`);
    });
  }
});

test("an error delivered with a 200 is still an error", async () => {
  // Some servers answer everything 200 and put the failure in the body. Status alone is
  // not the test.
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, expired() as never);
    const { fetch: f } = flakyFetch(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200, headers: { "content-type": "application/json" } }),
      {},
      99,
    );
    assert.deepEqual(await authHeaders("remote", config, f), {});
    assert.equal(await readAuth(key), undefined, "a 200-wrapped invalid_grant must still clear");
  });
});

test("a refresh lost to ANOTHER session is detected instead of signing both out", async () => {
  // Two Mindweave sessions, one server that rotates refresh tokens. The other session
  // refreshed a moment ago, which is exactly why ours was rejected — clearing here would
  // make a second open window a reliable way to sign yourself out of the first.
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, expired() as never);

    const winner = { ...expired({ accessToken: "winners-token", refreshToken: "rotated", expiresAt: Date.now() + 3_600_000 }) };
    const impl = async (): Promise<Response> => {
      // The other session's write lands while our refresh is in flight.
      await writeAuth(key, winner as never);
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };

    const headers = await authHeaders("remote", config, impl as unknown as typeof fetch);
    assert.deepEqual(headers, { authorization: "Bearer winners-token" }, "the other session's fresh token is used");
    assert.notEqual(await readAuth(key), undefined, "and nothing was cleared");
  });
});

test("a server that sends no expires_in but does send a refresh token is refreshed on schedule", async () => {
  // Without a guessed expiry there is nothing to trigger a proactive refresh, so the
  // token is used until it 401s and the user is sent to a browser a refresh would have
  // avoided. An hour is the near-universal default.
  await withSandbox(async () => {
    const key = serverKey("remote", config);
    await writeAuth(key, expired() as never);
    const { fetch: f } = flakyFetch(() => new Response("", { status: 500 }), { access_token: "fresh", refresh_token: "rt2" }, 0);
    await authHeaders("remote", config, f);
    const stored = await readAuth(key);
    assert.ok((stored?.expiresAt ?? 0) > Date.now() + 3_000_000, "an hour was assumed so a refresh happens before a 401 does");
  });
});

test("the browser is opened without a shell: a sign-in link keeps its & and nothing else can run", async () => {
  const { browserCommand } = await import("./index.js");
  const link = "https://auth.example/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=s";
  for (const platform of ["win32", "darwin", "linux"]) {
    const run = browserCommand(link, platform)!;
    assert.notEqual(run.command, "cmd", platform);
    assert.equal(run.args[run.args.length - 1], link, `${platform}: the whole address is one argument`);
  }
  assert.equal(browserCommand(link, "win32")!.command, "rundll32");
  // a hostile endpoint cannot add a command, and a non-web scheme is never handed to the system
  assert.doesNotMatch(browserCommand('https://x.example/a" & calc & "', "win32")!.args[1]!, /["\s]/);
  for (const bad of ["file:///C:/Windows/System32/calc.exe", "ms-msdt:/id", "javascript:alert(1)", "calc", ""]) assert.equal(browserCommand(bad, "win32"), null, bad);
});