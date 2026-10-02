/**
 * testState.mjs — keep the test suite out of the user's home directory.
 *
 * Mindweave files everything it keeps under `~/.mindweave/projects/<slug>`, and the
 * slug is derived from the working directory. So any test that ran a session, saved a
 * memory, or wrote a governor rule against a temp directory left a permanent folder in
 * the real home. Nothing knew those were disposable, so nothing ever removed them.
 *
 * Measured on the development machine before this existed: **6,761 of 6,770**
 * directories under `~/.mindweave/projects` were test litter, growing with every run.
 *
 * Loaded with `--import`, which Node runs before any test module, so the override is in
 * place before the first import can read it. `stateRoot()` reads the variable on every
 * call rather than caching it at import, which is what makes that ordering enough.
 *
 * A FRESH directory per process, which matters more than it looks. Node runs each test
 * file in its own process, so this gives every file its own state and nothing carries
 * over between runs. A fixed shared name was tried first and broke two tests that were
 * already isolating themselves with a temporary HOME: the state outlived the run, so a
 * memory saved by yesterday's suite made today's "this is a new memory" assertion fail.
 * Isolation that only holds on a clean machine is not isolation.
 *
 * A test needing two processes to share state sets the variable itself, which is
 * respected below.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Respect an override that is already set, so a developer can point a run somewhere
// specific, and so a test that spawns children can share one state directory with them.
if (!process.env.MINDWEAVE_STATE_DIR) {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mindweave-test-state-"));
}

// The MCP OAuth refresh retry backs off for real (1s, then 2s) so a briefly rate-limited
// server does not lose its credential — see flow.ts. A test PROVING that behaviour still
// has to wait it out at least once, and on a loaded CI runner several of those stacking up
// is exactly the shape of thing a global per-test timeout eventually catches, cancelling
// whatever else was still queued alongside it. The retries and the assertions are the
// same either way; only the clock is faster here.
if (!process.env.MINDWEAVE_OAUTH_BACKOFF_MS) {
  process.env.MINDWEAVE_OAUTH_BACKOFF_MS = "1";
}

// A command that starts an app or server waits a few real seconds to see it come up (see
// BackgroundShells.settle). The tests that start such commands only want the shell id back, so the
// wait is off here; the tests of the wait itself set it explicitly.
if (process.env.MINDWEAVE_READY_WINDOW_MS === undefined) {
  process.env.MINDWEAVE_READY_WINDOW_MS = "0";
}
