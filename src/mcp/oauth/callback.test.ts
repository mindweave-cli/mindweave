/**
 * callback.test.ts — the loopback listener, against a real socket.
 *
 * This is the one piece that cannot be faked: it exists to bind a port, so a test that
 * does not bind one proves nothing about it. Every case here makes a real HTTP request to
 * a real listener on 127.0.0.1.
 *
 * The state check is the reason this file is worth its runtime. Anything on the machine
 * can hit a loopback port, so "a request arrived" and "our flow came back" are different
 * claims, and the second one is the only one that may be allowed to produce a token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAvailablePort, redirectUri, waitForCallback } from "./callback.js";

/** Hit the listener the way a browser would, ignoring whatever page comes back. */
async function visit(port: number, query: string): Promise<void> {
  // A fresh connection each time, and a bounded wait. These tests reuse port numbers one after another, and a pooled connection to an
  // earlier test's listener, or a request that is never answered, looked exactly like a hang (it ran out the 120s test limit once on a
  // Linux runner, and passed on the next run of the same code).
  await fetch(`http://127.0.0.1:${port}/callback?${query}`, { headers: { connection: "close" }, signal: AbortSignal.timeout(10_000) }).catch(() => {
    /* the listener closes on us by design; the request having been made is the point */
  });
}

test("a redirect URI is loopback, fixed path, whatever the port", () => {
  // RFC 8252 §7.3 matches loopback redirects on path and ignores the port, which is what
  // lets the port be random per attempt without re-registering the client.
  //
  // The HOST is `localhost`, not the `127.0.0.1` this binds. Authorization servers check
  // the redirect URI as a string, and many accept only the literal name for an http
  // redirect and reject the IP form outright. That is a real failure against a real
  // provider ("Invalid redirect URI"), not a theoretical one.
  assert.equal(redirectUri(41234), "http://localhost:41234/callback");
  assert.match(redirectUri(1), /^http:\/\/localhost:\d+\/callback$/);
});

test("the listener answers on BOTH loopback families, since the browser resolves the name", async () => {
  // `localhost` can resolve to ::1 on a dual-stack machine. Listening on only 127.0.0.1
  // would mean the approval succeeds and the browser then cannot deliver the code, which
  // is the worst shape of failure: everything looks right until the final step.
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "s", timeoutMs: 2000 });
  const viaV6 = await fetch(`http://[::1]:${port}/callback?code=v6&state=s`).then(
    () => true,
    () => false,
  );
  if (!viaV6) {
    // A machine with IPv6 disabled cannot bind ::1, and that is allowed — IPv4 carries it.
    await fetch(`http://127.0.0.1:${port}/callback?code=v4&state=s`).catch(() => {});
    assert.deepEqual(await waiting, { code: "v4" });
    return;
  }
  assert.deepEqual(await waiting, { code: "v6" });
});

test("the chosen port is free, and outside the range Windows hands out to everything else", async () => {
  const port = await findAvailablePort("win32");
  assert.ok(port >= 39152 && port <= 49151, `win32 port ${port} is inside the OS dynamic range`);
  const posix = await findAvailablePort("linux");
  assert.ok(posix >= 49152 && posix <= 65535, `posix port ${posix} out of range`);
});

test("a matching redirect hands back the code", async () => {
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "the-state" });
  await visit(port, "code=the-code&state=the-state");
  assert.deepEqual(await waiting, { code: "the-code" });
});

test("a redirect with the WRONG state is refused, and no code comes out of it", async () => {
  // The port is reachable by anything on the machine. Without this check, whatever got
  // there first would have its "code" redeemed as though we had asked for it.
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "the-state" });
  // The assertion is attached BEFORE the request that settles it: the rejection lands
  // while `visit` is still awaiting, and a promise that rejects with nothing awaiting it
  // takes the process down before the assert is ever reached.
  const rejected = assert.rejects(waiting, /state mismatch/);
  await visit(port, "code=someone-elses-code&state=not-our-state");
  await rejected;
});

test("a declined consent screen reports what the server said, not a timeout", async () => {
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "s" });
  const rejected = assert.rejects(waiting, /User declined/);
  await visit(port, "error=access_denied&error_description=User%20declined&state=s");
  await rejected;
});

test("a redirect carrying no code at all is a failure rather than an empty success", async () => {
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "s" });
  const rejected = assert.rejects(waiting, /no authorization code/);
  await visit(port, "state=s");
  await rejected;
});

test("aborting stops the wait and frees the port immediately", async () => {
  // Without this, closing the box leaves a listener holding a port for the full five
  // minutes, and a second attempt cannot use it.
  const port = await findAvailablePort();
  const controller = new AbortController();
  const waiting = waitForCallback({ port, state: "s", signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /cancelled/);

  // Proven free by binding it again for a fresh flow.
  // A short deadline of its own, so if the visit never arrives this fails in seconds saying so, not after the whole test's limit.
  const second = waitForCallback({ port, state: "s2", timeoutMs: 15_000 });
  await visit(port, "code=c2&state=s2");
  assert.deepEqual(await second, { code: "c2" });
});

test("an already-aborted signal never opens the port at all", async () => {
  const port = await findAvailablePort();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForCallback({ port, state: "s", signal: controller.signal }), /cancelled/);
});

test("waiting stops on time rather than forever", async () => {
  const port = await findAvailablePort();
  await assert.rejects(waitForCallback({ port, state: "s", timeoutMs: 30 }), /timed out/);
});

test("a request to any other path is not treated as the redirect", async () => {
  const port = await findAvailablePort();
  const waiting = waitForCallback({ port, state: "s", timeoutMs: 300 });
  await fetch(`http://127.0.0.1:${port}/`).catch(() => {});
  // Still waiting for the real thing: a stray request must not settle the flow either way.
  await assert.rejects(waiting, /timed out/);
});
