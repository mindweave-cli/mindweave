/** listeningPorts.test.ts — reading each system's port listing, and tracing a port home. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerOf, parseLsof, parseNetstat, parseParents, parseSs } from "./listeningPorts.js";

test("parseNetstat reads IPv4 and IPv6 listeners and skips the rest", () => {
  const text = [
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:1430           0.0.0.0:0              LISTENING       1200",
    "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       3400",
    "  TCP    [::1]:5173             [::]:0                 LISTENING       56",
    "  TCP    127.0.0.1:50000        127.0.0.1:9222         ESTABLISHED     3400",
  ].join("\r\n");
  assert.deepEqual(parseNetstat(text), [
    { port: 1430, pid: 1200 },
    { port: 9222, pid: 3400 },
    { port: 5173, pid: 56 },
  ]);
});

test("parseSs and parseLsof read their formats", () => {
  assert.deepEqual(parseSs('LISTEN 0 511 127.0.0.1:9222 0.0.0.0:* users:(("electron",pid=812,fd=40))\n'), [{ port: 9222, pid: 812 }]);
  assert.deepEqual(parseLsof("p812\nn127.0.0.1:9222\nn*:1430\n"), [{ port: 9222, pid: 812 }, { port: 1430, pid: 812 }]);
});

test("ownerOf walks up to the shell, and survives a loop from a reused id", () => {
  const parents = parseParents("30 20\n20 10\n10 1\n 7 8\n8 7\n");
  assert.equal(ownerOf(30, parents, new Set([10])), 10);
  assert.equal(ownerOf(30, parents, new Set([99])), null);
  assert.equal(ownerOf(7, parents, new Set([99])), null);
});
