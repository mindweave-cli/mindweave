/**
 * verifierTools.ts — what a verifier may run that an ordinary read-only worker may not.
 *
 * A verifier's whole job is to RUN things: the build, the tests, the typechecker, a script
 * that calls the changed function, the app under test. Its instructions said so, and its tool
 * set did not allow it: a verifier was made read-only like any research worker, which removes
 * the command tool and the app driver, so it could only read the code and write PASS next to
 * what it read. Every verdict it gave came back `partial`, because it could not make a check.
 *
 * These are added to the read-only set for a verifier and nobody else. The edit and write
 * tools stay removed, so it still cannot change the project through them; a command that writes
 * a file by other means is caught afterwards (see treeGuard.ts) rather than trusted not to.
 *
 * `kill_shell` is not here. It stops a background shell by number, and the numbers are shared with the
 * session that spawned the verifier: it could stop the app the user is looking at. What a verifier
 * starts in the background is stopped for it when it finishes instead (see verifierRun.ts).
 */
export const VERIFIER_EXTRA_TOOLS: ReadonlySet<string> = new Set(["run_command", "ui"]);
