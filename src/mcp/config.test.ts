/**
 * config.test.ts — a bad config must cost you MCP, never the session.
 *
 * This file is read before anything else works, so every case here is really the same
 * question: can a user's typo stop the agent from starting? The answer has to be no,
 * which is why the parse drops entries instead of throwing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEntry, parseMcpConfig, clientSecretFor } from "./config.js";

test("a stdio server is inferred from `command`, with no type needed", () => {
  const [server] = parseMcpConfig(
    JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@x/fs"], env: { TOKEN: "t" } } } }),
  );
  assert.deepEqual(server, { type: "stdio", name: "fs", command: "npx", args: ["-y", "@x/fs"], env: { TOKEN: "t" } });
});

test("an http server is inferred from `url`", () => {
  const [server] = parseMcpConfig(JSON.stringify({ mcpServers: { api: { url: "https://x.dev/mcp", headers: { a: "b" } } } }));
  assert.deepEqual(server, { type: "http", name: "api", url: "https://x.dev/mcp", headers: { a: "b" } });
});

test("both `mcpServers` and `servers` are accepted", () => {
  // Both spellings exist in the wild; rejecting one looks like the file being ignored.
  assert.equal(parseMcpConfig(JSON.stringify({ mcpServers: { a: { command: "x" } } })).length, 1);
  assert.equal(parseMcpConfig(JSON.stringify({ servers: { a: { command: "x" } } })).length, 1);
});

test("malformed JSON yields no servers instead of throwing", () => {
  // The whole point: a broken file degrades to "no MCP", not "no agent".
  assert.deepEqual(parseMcpConfig("{not json"), []);
  assert.deepEqual(parseMcpConfig(""), []);
  assert.deepEqual(parseMcpConfig(JSON.stringify({ mcpServers: [] })), []);
  assert.deepEqual(parseMcpConfig(JSON.stringify({})), []);
});

test("one broken entry does not take the good ones with it", () => {
  const servers = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        good: { command: "npx" },
        noCommand: { args: ["x"] },
        alsoGood: { url: "https://x.dev/mcp" },
        notAnObject: "nope",
      },
    }),
  );
  assert.deepEqual(servers.map((s) => s.name).sort(), ["alsoGood", "good"]);
});

test("non-http URLs are refused", () => {
  // A `file://` or custom scheme here points the client at something that is not an
  // MCP endpoint at all.
  assert.equal(parseEntry("x", { url: "file:///etc/passwd" }), null);
  assert.equal(parseEntry("x", { url: "ftp://x.dev" }), null);
  assert.ok(parseEntry("x", { url: "http://localhost:3000/mcp" }));
});

test("deprecated transports are refused rather than half-supported", () => {
  // HTTP+SSE was deprecated in 2025-03-26 and its sunset has passed.
  assert.equal(parseEntry("x", { type: "sse", url: "https://x.dev" }), null);
  assert.equal(parseEntry("x", { type: "ws", url: "wss://x.dev" }), null);
});

test("disabled is carried through so the pool can skip without forgetting", () => {
  const server = parseEntry("x", { command: "npx", disabled: true });
  assert.equal(server?.disabled, true);
  // A server that is merely off must still be listed, or `/mcp` cannot show it.
  assert.equal(server?.name, "x");
});

test("non-string args, env and header values are dropped, not coerced", () => {
  const server = parseEntry("x", { command: "npx", args: ["ok", 5, null], env: { good: "1", bad: 2 } });
  assert.deepEqual(server && "args" in server ? server.args : null, ["ok"]);
  assert.deepEqual(server && "env" in server ? server.env : null, { good: "1" });
});

test("an unnamed entry is dropped", () => {
  assert.equal(parseEntry("", { command: "npx" }), null);
});

test("the oauth override block is read, and bad values cost the override rather than the server", () => {
  // Every field has a working default, so a typo should fall back to the automatic flow
  // instead of refusing to load a server someone is trying to use.
  const good = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        remote: { type: "http", url: "https://x.dev/mcp", oauth: { clientId: "abc", callbackPort: 41234, authServerMetadataUrl: "https://auth.x.dev/.well-known/oauth-authorization-server" } },
      },
    }),
  )[0]!;
  assert.deepEqual(good.type === "http" ? good.oauth : null, {
    clientId: "abc",
    callbackPort: 41234,
    authServerMetadataUrl: "https://auth.x.dev/.well-known/oauth-authorization-server",
  });

  const bad = parseMcpConfig(
    JSON.stringify({
      mcpServers: {
        // A port as a string, an out-of-range port, and — the one that matters — a
        // metadata URL over plain http, which decides where credentials are SENT.
        remote: { type: "http", url: "https://x.dev/mcp", oauth: { callbackPort: "41234", authServerMetadataUrl: "http://auth.x.dev/meta" } },
      },
    }),
  )[0]!;
  assert.equal(bad.type === "http" ? bad.oauth : "still loaded", undefined, "the server loads; only the unusable override is dropped");

  const none = parseMcpConfig(JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://x.dev/mcp" } } }))[0]!;
  assert.equal(none.type === "http" ? none.oauth : null, undefined, "a server that needs no override carries none");
});

test("a client secret is read from the environment, for the named server only", () => {
  // Never from mcp.json: that file gets committed, and a secret in a repository is a
  // secret that has been published.
  const env = { MINDWEAVE_MCP_CLIENT_SECRET: "shared", MINDWEAVE_MCP_CLIENT_SECRET_MY_SERVER: "specific" } as NodeJS.ProcessEnv;
  assert.equal(clientSecretFor("my-server", env), "specific", "the per-server name wins");
  assert.equal(clientSecretFor("other", env), undefined, "a bare variable is not handed to whichever server asks");
  assert.equal(clientSecretFor("other", {}), undefined);
});

test("a server or tool name with terminal control characters is dropped", () => {
  assert.equal(parseEntry("ok\u001b]0;x\u0007", { command: "node" }), null);
  assert.ok(parseEntry("fine-server", { command: "node" }));
});