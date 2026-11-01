/**
 * endToEnd.test.ts — signing in, for real, against a real authorization server.
 *
 * Every other test here checks one step with the others faked. This one runs the whole
 * thing over real sockets: a `node:http` server that speaks RFC 9728, RFC 8414, RFC 7591
 * and the two OAuth grants, and a stand-in "browser" that does what a browser does with
 * the authorize URL — follow it and let the server redirect back to our loopback port.
 *
 * It exists because the steps can each be right while the SEQUENCE is wrong, and every
 * bug of that kind is invisible to the unit tests: a redirect URI registered as one value
 * and sent as another, the listener opened after the browser was told where to go, the
 * PKCE verifier belonging to a different attempt than the code. None of those can survive
 * a run that actually completes.
 *
 * Sandboxed, because a successful sign-in WRITES a credential.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { authenticate, signOut } from "./index.js";
import { readAuth, serverKey } from "./tokenStore.js";
import type { McpServerConfig } from "../config.js";

/** What went wrong in the stand-in browser, for the failure message. A sign-in whose browser failed otherwise just waits. */
let browserTrouble = "";

/** A sign-in here takes milliseconds. One that stalls fails with what is known, not as an anonymous timeout minutes later. */
const SIGN_IN_DEADLINE_MS = 30_000;

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mw-oauth-e2e-"));
  browserTrouble = "";
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled after ${SIGN_IN_DEADLINE_MS} ms; browser: ${browserTrouble || "no trouble seen"}`)), SIGN_IN_DEADLINE_MS);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
    if (previous === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = previous;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface FakeServer {
  origin: string;
  close: () => Promise<void>;
  /** Every code we issued, with the challenge it was bound to. */
  issued: Map<string, { challenge: string; redirect: string }>;
  registrations: number;
  lastTokenForm: URLSearchParams | null;
  /** Every revocation the server was asked to perform, in order. */
  revoked: { hint: string; clientId: string; token: string }[];
}

/**
 * A server that is both the MCP resource and its own authorization server, which is the
 * commonest real deployment and the one with the fewest moving parts to stand up.
 */
async function startFakeServer(options: { requirePkce?: boolean; withRevocation?: boolean } = {}): Promise<FakeServer> {
  const state: FakeServer = { origin: "", close: async () => {}, issued: new Map(), registrations: 0, lastTokenForm: null, revoked: [] };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", state.origin || "http://127.0.0.1");
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: `${state.origin}/mcp`, authorization_servers: [state.origin], scopes_supported: ["read", "write"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        ...(options.withRevocation ? { revocation_endpoint: `${state.origin}/revoke` } : {}),
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/revoke") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        state.revoked.push({ hint: form.get("token_type_hint") ?? "", clientId: form.get("client_id") ?? "", token: form.get("token") ?? "" });
        res.writeHead(200).end();
      });
      return;
    }
    if (url.pathname === "/register") {
      state.registrations++;
      return json({ client_id: "client-from-server" }, 201);
    }
    if (url.pathname === "/authorize") {
      // What a browser lands on: validate, then 302 straight back to the loopback port.
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      const returned = url.searchParams.get("state") ?? "";
      if (options.requirePkce && url.searchParams.get("code_challenge_method") !== "S256") {
        return json({ error: "invalid_request" }, 400);
      }
      const code = `code-${state.issued.size + 1}`;
      state.issued.set(code, { challenge, redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", returned);
      return void res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        state.lastTokenForm = form;
        if (form.get("grant_type") === "refresh_token") {
          return json({ access_token: "refreshed-token", expires_in: 3600 });
        }
        const code = form.get("code") ?? "";
        const record = state.issued.get(code);
        if (!record) return json({ error: "invalid_grant", error_description: "unknown code" }, 400);
        // The real check PKCE exists for: the verifier must hash to the challenge that
        // was presented when this code was issued.
        const verifier = form.get("code_verifier") ?? "";
        const expected = base64Url(createHash("sha256").update(verifier).digest());
        if (expected !== record.challenge) return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        if (form.get("redirect_uri") !== record.redirect) {
          return json({ error: "invalid_grant", error_description: "redirect_uri does not match" }, 400);
        }
        return json({ access_token: "real-access-token", refresh_token: "real-refresh-token", expires_in: 3600, scope: "read write" });
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.origin = `http://127.0.0.1:${port}`;
  // Every connection goes too: close alone waits on any the browser or a client has left open, and the test then hangs here.
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return state;
}

/** Stands in for the browser: fetch the authorize URL and follow the redirect back to our
 *  loopback listener, which is precisely what a browser does with a 302. */
function fakeBrowser(seen: string[] = []): (url: string) => void {
  return (url: string) => {
    seen.push(url);
    void fetch(url, { redirect: "follow" }).then(
      async (response) => {
        if (!response.ok) browserTrouble = `${response.status} from ${response.url}`;
        await response.body?.cancel().catch(() => {}); // an unread body keeps its connection busy
      },
      (error: unknown) => {
        // Normal if the listener closed the socket once it had the code, so this only counts if the sign-in then stalls.
        browserTrouble = String((error as { cause?: unknown }).cause ?? error);
      },
    );
  };
}

test("a full sign-in produces a stored, usable credential", async () => {
  await withSandbox(async () => {
    const auth = await startFakeServer({ requirePkce: true });
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
      const opened: string[] = [];
      const hinted: string[] = [];
      await authenticate({ name: "remote", config, onUrl: (u) => hinted.push(u), openUrl: fakeBrowser(opened) });

      const stored = await readAuth(serverKey("remote", config));
      assert.equal(stored?.accessToken, "real-access-token");
      assert.equal(stored?.refreshToken, "real-refresh-token");
      assert.equal(stored?.clientId, "client-from-server");
      assert.equal(stored?.tokenEndpoint, `${auth.origin}/token`);
      // RFC 8707: the token is bound to this one resource, so a leak cannot be spent
      // against a different server behind the same authorization server.
      assert.equal(stored?.resource, `${auth.origin}/mcp`);
      assert.ok((stored?.expiresAt ?? 0) > Date.now());

      // The raw URL is NOT pasted into the transcript when the browser works: it is 400
      // characters of query string, and this is the common path. It appears only after a
      // few seconds of silence, which is when someone actually needs it.
      assert.deepEqual(hinted, [], "the fallback URL should stay hidden on a working sign-in");
      assert.equal(opened.length, 1, "the browser was handed exactly one authorize URL");

      // The scope came off the resource document rather than being invented.
      const authorizeUrl = new URL(opened[0]!);
      assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `http://localhost:${new URL(authorizeUrl.searchParams.get("redirect_uri")!).port}/callback`);
      assert.equal(authorizeUrl.searchParams.get("scope"), "read write");
      assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    } finally {
      await auth.close();
    }
  });
});

test("signing in twice reuses the client id instead of registering again", async () => {
  // Registering afresh every attempt leaves a trail of single-use clients on the
  // authorization server, and several of them start refusing once that list gets long.
  await withSandbox(async () => {
    const auth = await startFakeServer();
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      assert.equal(auth.registrations, 1, "the second sign-in registered a second client");
    } finally {
      await auth.close();
    }
  });
});

test("the verifier really is checked: a wrong one is refused by the server", async () => {
  // Guards the test above from passing vacuously. If PKCE were not actually wired through,
  // this server would accept anything and the whole suite would prove nothing.
  await withSandbox(async () => {
    const auth = await startFakeServer();
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      const form = auth.lastTokenForm!;
      const verifier = form.get("code_verifier")!;

      // Replay the exact exchange with one character of the verifier changed.
      const tampered = new URLSearchParams(form);
      tampered.set("code_verifier", `${verifier.slice(0, -1)}${verifier.endsWith("a") ? "b" : "a"}`);
      const response = await fetch(`${auth.origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tampered.toString(),
      });
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /PKCE verification failed/);
    } finally {
      await auth.close();
    }
  });
});

test("a local command server cannot be signed in to, and says why", async () => {
  await withSandbox(async () => {
    await assert.rejects(
      () => authenticate({ name: "local", config: { type: "stdio", name: "local", command: "npx", args: [] }, openUrl: () => {} }),
      /no authorization server/,
    );
  });
});

test("cancelling mid-flow leaves nothing stored", async () => {
  await withSandbox(async () => {
    const auth = await startFakeServer();
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
      const controller = new AbortController();
      // A browser that never comes back, which is what closing the tab looks like.
      const pending = authenticate({ name: "remote", config, signal: controller.signal, openUrl: () => {} });
      const rejected = assert.rejects(pending, /cancelled/);
      controller.abort();
      await rejected;
      assert.equal(await readAuth(serverKey("remote", config)), undefined, "an abandoned attempt must not half-write a credential");
    } finally {
      await auth.close();
    }
  });
});

// ── servers that cannot be signed in to automatically ───────────────────────

test("a hand-issued client id skips registration entirely, and uses the configured port", async () => {
  // The case this exists for: an authorization server with no dynamic registration, where
  // a client was created by hand in a dashboard and has ONE exact redirect URI recorded
  // against it. A random port would not match what was registered, so the two travel
  // together.
  await withSandbox(async () => {
    const auth = await startFakeServer();
    try {
      const port = 45671;
      const config: McpServerConfig = {
        type: "http",
        name: "remote",
        url: `${auth.origin}/mcp`,
        oauth: { clientId: "hand-registered", callbackPort: port },
      };
      const urls: string[] = [];
      await authenticate({ name: "remote", config, openUrl: fakeBrowser(urls) });

      assert.equal(auth.registrations, 0, "a configured client id must not trigger registration");
      const authorizeUrl = new URL(urls[0]!);
      assert.equal(authorizeUrl.searchParams.get("client_id"), "hand-registered");
      assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `http://localhost:${port}/callback`);

      const stored = await readAuth(serverKey("remote", config));
      assert.equal(stored?.clientId, "hand-registered");
    } finally {
      await auth.close();
    }
  });
});

test("a client secret comes from the environment, never from the config file", async () => {
  // `mcp.json` gets committed. A secret in it is a secret that has been published, so the
  // only way to supply one is the environment.
  await withSandbox(async () => {
    const auth = await startFakeServer();
    const previous = process.env.MINDWEAVE_MCP_CLIENT_SECRET_REMOTE;
    process.env.MINDWEAVE_MCP_CLIENT_SECRET_REMOTE = "sh-sec";
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp`, oauth: { clientId: "hand-registered" } };
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      assert.equal(auth.lastTokenForm?.get("client_secret"), "sh-sec", "the secret must reach the token endpoint");
      assert.equal((await readAuth(serverKey("remote", config)))?.clientSecret, "sh-sec");
    } finally {
      if (previous === undefined) delete process.env.MINDWEAVE_MCP_CLIENT_SECRET_REMOTE;
      else process.env.MINDWEAVE_MCP_CLIENT_SECRET_REMOTE = previous;
      await auth.close();
    }
  });
});

test("a configured metadata URL is used alone — a wrong one fails loudly rather than guessing", async () => {
  await withSandbox(async () => {
    const auth = await startFakeServer();
    try {
      const config: McpServerConfig = {
        type: "http",
        name: "remote",
        url: `${auth.origin}/mcp`,
        oauth: { authServerMetadataUrl: `${auth.origin}/.well-known/oauth-authorization-server` },
      };
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      assert.equal((await readAuth(serverKey("remote", config)))?.accessToken, "real-access-token");

      // Someone who went to the trouble of naming a document gets told it was wrong,
      // rather than having the guesses quietly paper over their typo.
      const wrong: McpServerConfig = { ...config, oauth: { authServerMetadataUrl: `${auth.origin}/nope` } };
      await assert.rejects(() => authenticate({ name: "remote", config: wrong, openUrl: () => {} }), /configured authServerMetadataUrl/);
    } finally {
      await auth.close();
    }
  });
});

test("signing out revokes the tokens server-side, refresh token first", async () => {
  await withSandbox(async () => {
    const auth = await startFakeServer({ withRevocation: true });
    try {
      const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
      await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
      await signOut("remote", config);

      assert.deepEqual(
        auth.revoked.map((r) => r.hint),
        ["refresh_token", "access_token"],
        "the refresh token goes first — it is the one that keeps minting new access tokens",
      );
      // RFC 7009: a public client identifies itself in the BODY, not an Authorization header.
      assert.equal(auth.revoked[0]!.clientId, "client-from-server");
      assert.equal(await readAuth(serverKey("remote", config)), undefined);
    } finally {
      await auth.close();
    }
  });
});

test("signing out still works when the server cannot be reached", async () => {
  // Revocation is a courtesy. A server that is down must not be able to keep someone
  // signed in locally.
  await withSandbox(async () => {
    const auth = await startFakeServer({ withRevocation: true });
    const config: McpServerConfig = { type: "http", name: "remote", url: `${auth.origin}/mcp` };
    await authenticate({ name: "remote", config, openUrl: fakeBrowser() });
    await auth.close();

    await signOut("remote", config);
    assert.equal(await readAuth(serverKey("remote", config)), undefined);
  });
});
