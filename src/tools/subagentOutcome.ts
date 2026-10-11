/**
 * subagentOutcome.ts — how a sub-agent's run ended, as words and as a word a screen can colour (pure).
 *
 * The run's own summary line ("20 steps · read-only · could not fully verify · 8 checks") is built
 * for the lead agent to read. A person looking at the screen wants the answer first, in a few
 * words: did it work, did it only half work, did it fail. This gives each of those a headline and
 * a name for the colour, so a front end does not have to take the summary line apart to find out.
 */
import type { SubagentStatus } from "./subagentReport.js";

/** How a run ended: it worked, it half worked, it failed, or it did not say. */
export type SubagentOutcome = "pass" | "partial" | "fail" | "unknown";

/** The headline for a VERIFIER's verdict about the code it checked. */
export function verifierOutcome(verdict: string, evidence: number): { headline: string; verdict: SubagentOutcome } {
  const checks = evidence === 1 ? "1 check" : `${evidence} checks`;
  if (verdict === "pass") return { headline: `Verified · ${checks}`, verdict: "pass" };
  if (verdict === "fail") return { headline: `Failed verification · ${checks}`, verdict: "fail" };
  if (verdict === "partial") return { headline: `Could not fully verify · ${checks}`, verdict: "partial" };
  return { headline: "No verdict", verdict: "unknown" };
}

/** The headline for an ordinary worker, from the status it reported and what the run showed. */
export function workerOutcome(run: { status: SubagentStatus; trustworthy: boolean; exhausted: boolean }): { headline: string; verdict: SubagentOutcome } {
  if (run.trustworthy) return { headline: "Done", verdict: "pass" };
  if (run.status === "failed") return { headline: "Could not do it", verdict: "fail" };
  if (run.exhausted) return { headline: "Stopped at its step limit", verdict: "partial" };
  if (run.status === "partial") return { headline: "Only part of it", verdict: "partial" };
  return { headline: "Did not say if it finished", verdict: "unknown" };
}
