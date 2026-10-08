/**
 * provision.test.ts — the auto-installer.
 *
 * The deterministic parts run always. The real network install is gated behind
 * MINDWEAVE_TEST_NETWORK so the default suite stays fast and offline-green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the install cache under a throwaway home.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-prov-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const { resolveInstalled, ensureInstalled, autoInstallEnabled, platformKey, runBounded, recordInstallDecision, takeUndecidedInstalls } =
  await import("./provision.js");

const NPM_SPEC = { source: "npm" as const, package: "bash-language-server", version: "5.4.3", binName: "bash-language-server" };

/** rust-analyzer as servers.ts pins it, with each asset's published SHA-256. */
const RUST_ANALYZER_SPEC = {
  source: "github" as const,
  repo: "rust-lang/rust-analyzer",
  version: "2026-06-22",
  targets: {
    "win32-x64": { asset: "rust-analyzer-x86_64-pc-windows-msvc.zip", sha256: "6071dc5b28aa6d22c715f63c08d75b827c066be4ea866796587e52ed48b2922f", bin: "rust-analyzer.exe" },
    "win32-arm64": { asset: "rust-analyzer-aarch64-pc-windows-msvc.zip", sha256: "30f873713ea3663db10999c23e95b74fe19968c893d5c0e9b8a896b31dbf8cf8", bin: "rust-analyzer.exe" },
    "darwin-x64": { asset: "rust-analyzer-x86_64-apple-darwin.gz", sha256: "bf65b0d4586f127ab11bf33476dd6aac82dad173946c5d3b1cede19d63ae85ed", bin: "rust-analyzer" },
    "darwin-arm64": { asset: "rust-analyzer-aarch64-apple-darwin.gz", sha256: "c8cdf6d5e488752b907d5ee15e31768b59a78d992e9a54b9f9660e1bfdf39f27", bin: "rust-analyzer" },
    "linux-x64": { asset: "rust-analyzer-x86_64-unknown-linux-gnu.gz", sha256: "feb7c170d2c1a2e4b8a88ac73f937eddb576828e3821b0a63ee0e64bd0bc9440", bin: "rust-analyzer" },
    "linux-arm64": { asset: "rust-analyzer-aarch64-unknown-linux-gnu.gz", sha256: "9602ca5b24dcaa07a5a021274763bed367d8a32da9a226fe3e139de3306569cb", bin: "rust-analyzer" },
  },
};

test("platformKey looks like <platform>-<arch>", () => {
  assert.match(platformKey(), /^(win32|darwin|linux)-(x64|arm64|arm|ia32)$/);
});

test("resolveInstalled is null before anything is installed", () => {
  assert.equal(resolveInstalled("bash-language-server", NPM_SPEC), null);
});

test("autoInstallEnabled honors MINDWEAVE_NO_AUTO_INSTALL", () => {
  const prev = process.env.MINDWEAVE_NO_AUTO_INSTALL;
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  assert.equal(autoInstallEnabled(), true);
  process.env.MINDWEAVE_NO_AUTO_INSTALL = "1";
  assert.equal(autoInstallEnabled(), false);
  if (prev === undefined) delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  else process.env.MINDWEAVE_NO_AUTO_INSTALL = prev;
});

test("ensureInstalled returns null (no-op) when auto-install is disabled", async () => {
  const prev = process.env.MINDWEAVE_NO_AUTO_INSTALL;
  process.env.MINDWEAVE_NO_AUTO_INSTALL = "1";
  const cmd = await ensureInstalled("never-installed", NPM_SPEC);
  assert.equal(cmd, null);
  if (prev === undefined) delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  else process.env.MINDWEAVE_NO_AUTO_INSTALL = prev;
});

test(
  "npm auto-install fetches a real server (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 180_000 },
  async () => {
    delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
    await recordInstallDecision("bash-language-server", "yes");
    const cmd = await ensureInstalled("bash-language-server", NPM_SPEC);
    assert.ok(cmd, "should resolve to an installed binary");
    assert.ok(existsSync(cmd!), "the binary should exist on disk");
  },
);

test(
  "github auto-install downloads + extracts a real binary (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 180_000 },
  async () => {
    delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
    await recordInstallDecision("rust-analyzer", "yes");
    const cmd = await ensureInstalled("rust-analyzer", RUST_ANALYZER_SPEC);
    assert.ok(cmd, "should resolve to the downloaded binary");
    assert.ok(existsSync(cmd!), "the binary should exist on disk");
  },
);

test(
  "a download whose SHA-256 does not match is refused (network)",
  { skip: !process.env.MINDWEAVE_TEST_NETWORK, timeout: 180_000 },
  async () => {
    delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
    const wrong = "0".repeat(64);
    const spec = {
      ...RUST_ANALYZER_SPEC,
      targets: Object.fromEntries(Object.entries(RUST_ANALYZER_SPEC.targets).map(([k, t]) => [k, { ...t, sha256: wrong }])),
    };
    await recordInstallDecision("rust-analyzer-tampered", "yes");
    assert.equal(await ensureInstalled("rust-analyzer-tampered", spec), null);
  },
);

// ── consent ─────────────────────────────────────────────────────────────────

test("an undecided server is not installed; it waits for the user's answer", async () => {
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  takeUndecidedInstalls();
  assert.equal(await ensureInstalled("undecided-server", RUST_ANALYZER_SPEC), null);
  assert.deepEqual(takeUndecidedInstalls().map((p) => p.key), ["undecided-server"]);
  assert.deepEqual(takeUndecidedInstalls(), [], "asked about once");
});

test("a server the user said never to install is not installed or asked about again", async () => {
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  takeUndecidedInstalls();
  await recordInstallDecision("refused-server", "never");
  assert.equal(await ensureInstalled("refused-server", RUST_ANALYZER_SPEC), null);
  assert.deepEqual(takeUndecidedInstalls(), []);
});

test("a hanging install is bounded, killed, and reported as failure", async () => {
  // The hang shape this guards: provisioning spawned npm/tar with no timeout and
  // never killed them, so a stalled install waited forever AND left its process
  // tree running. Because installs are deduped, that one promise then poisoned
  // every later caller for the session.
  const node = process.execPath;
  const started = Date.now();
  // A child that deliberately never exits, held open by a long timer.
  const ok = await runBounded(node, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" }, 700);
  const elapsed = Date.now() - started;

  assert.equal(ok, false, "a timed-out install must report failure, not success");
  assert.ok(elapsed < 10_000, `should give up promptly, took ${elapsed}ms`);
});

test("a fast command still succeeds through the bounded runner", async () => {
  // Guards against the timeout being so eager that normal installs fail.
  const ok = await runBounded(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }, 30_000);
  assert.equal(ok, true);
});

test("a command that exits non-zero is a failure, not a hang", async () => {
  const ok = await runBounded(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" }, 30_000);
  assert.equal(ok, false);
});

test("the timed-out child is actually killed, not just abandoned", async () => {
  // Bounding the WAIT without killing the process is the half-fix: the call returns
  // but the process tree keeps running, which is the "processes piling up" half of
  // the symptom. Proven by behaviour: the child keeps appending to a file, so if it
  // survived the timeout the file keeps growing afterwards.
  const { writeFileSync, readFileSync } = await import("node:fs");
  const marker = join(mkdtempSync(join(tmpdir(), "mindweave-kill-")), "beat.txt");
  writeFileSync(marker, "");
  // Beat once at startup, THEN on an interval: under parallel suite load a Node
  // process can take a second or more just to boot, and a child that is killed
  // before its first interval tick leaves an empty marker that proves nothing.
  const script =
    `const fs=require('fs');const f=${JSON.stringify(marker)};` +
    `fs.appendFileSync(f,'x');setInterval(()=>fs.appendFileSync(f,'x'),50);`;

  // Generous bound for the same reason — this test is about the kill, not the
  // precision of the timeout, which the two tests above already pin.
  await runBounded(process.execPath, ["-e", script], { stdio: "ignore" }, 5_000);
  assert.ok(readFileSync(marker, "utf8").length > 0, "child never ran, so this proves nothing");

  // killTree is asynchronous (it spawns taskkill / escalates signals), so the child may
  // write a few more beats after runBounded resolves.
  //
  // POLL for the file to stop growing rather than sleeping a fixed second and hoping.
  // The fixed version was flaky under full-suite load for a reason that says nothing
  // about the product: with the machine saturated, the kill itself takes longer to be
  // scheduled, so the "settled" reading was sometimes taken while the doomed child was
  // still beating. Waiting for two equal consecutive readings measures the thing the
  // test is actually about — that the child STOPS — and a child that never stops still
  // fails, on the deadline, which is the failure worth having.
  const deadline = Date.now() + 15_000;
  let settled = readFileSync(marker, "utf8").length;
  let stable = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = readFileSync(marker, "utf8").length;
    if (now === settled) {
      stable = true;
      break;
    }
    settled = now;
  }
  assert.ok(stable, "child was still writing 15s after the timeout — it survived the kill");

  // Then confirm it stays stopped, rather than having merely paused between beats.
  await new Promise((r) => setTimeout(r, 500)); // room for ~10 more beats
  assert.equal(readFileSync(marker, "utf8").length, settled, "child resumed after appearing to stop");
});
