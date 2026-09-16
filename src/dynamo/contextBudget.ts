/**
 * contextBudget.ts — where the context window actually went.
 *
 * `/context` used to print the project blurb captured at startup, which answers a
 * question nobody asks twice. The question people DO ask, every time a compaction
 * fires, is "what is filling this up?" — and until now the only honest answer was
 * a guess.
 *
 * Measuring real sessions is what shaped the categories here. Across 15 sessions
 * over 50KB the split was roughly: tool RESULTS 44%, tool-call ARGUMENTS 42%,
 * prose 8%. The arguments half is the surprise — a `write_file` call carries the
 * whole file it wrote, and that text sits in the transcript forever whether or not
 * the result is later cleared. Any breakdown that lumps "tool activity" into one
 * bar hides the larger half of the bill behind the half people already expect.
 *
 * Everything here is pure: entries in, numbers out. The rendering lives in the CLI
 * and the accuracy caveats live in `total()` — the transcript is ESTIMATED from
 * characters, while the non-transcript overhead is a figure the provider actually
 * reported, so the two must never be presented as equally certain.
 */
import type { Entry } from "../memory/types.js";
import {
  estimateTokens,
  CLEARED_STUB,
  CLEARED_INPUT_NOTE,
  CONTENT_CARRYING_TOOLS,
  KEEP_LAST_N,
} from "../memory/compaction.js";

export interface BudgetSlice {
  label: string;
  tokens: number;
  /** True when this figure came from the provider rather than from a character count. */
  measured?: boolean;
}

export interface ToolWeight {
  name: string;
  calls: number;
  /** Arguments + results together: the full cost of having run this tool. */
  tokens: number;
}

export interface ContextBudget {
  slices: BudgetSlice[];
  /** Sum of every slice. */
  total: number;
  /** Per-tool cost, heaviest first. */
  tools: ToolWeight[];
  /** What clearing old tool bodies would free right now, without a model call. */
  reclaimable: number;
}

// Both tests key off the stubs compaction actually writes, imported rather than
// re-spelled: a reworded stub would otherwise leave this counting cleared entries as
// reclaimable forever, and the only symptom would be a number quietly too large.
const isCleared = (content: string) => content.includes(CLEARED_STUB);
const argsCleared = (args: string) => args.includes(CLEARED_INPUT_NOTE);

/**
 * Map every tool result back to the tool that produced it.
 *
 * A `tool` entry carries only a `toolCallId`, so on its own it can say how many tokens
 * results cost but never WHICH tool cost them — which is the only form of the answer
 * anyone can act on.
 */
function namesByCallId(entries: readonly Entry[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of entries) {
    if (e.role !== "assistant" || !e.toolCalls) continue;
    for (const call of e.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

/**
 * Break a transcript down into the categories that explain a full context window.
 *
 * `overhead` is the measured non-transcript size (system prompt, tool schemas, working
 * set, todos) when the session has one for the CURRENT model; pass undefined and it is
 * simply left out rather than guessed at, because a wrong number here would be the
 * largest single error in the table.
 */
export function contextBudget(entries: readonly Entry[], overhead?: number): ContextBudget {
  let results = 0;
  let args = 0;
  let replies = 0;
  let yours = 0;
  let notes = 0;
  let summaries = 0;
  let reclaimable = 0;

  const names = namesByCallId(entries);
  const tools = new Map<string, ToolWeight>();
  const bump = (name: string, tokens: number, calls: number) => {
    const row = tools.get(name) ?? { name, calls: 0, tokens: 0 };
    row.calls += calls;
    row.tokens += tokens;
    tools.set(name, row);
  };

  // Results in the last few rounds are the ones microcompaction protects, so they are
  // not offered as reclaimable — promising to free tokens that the clearing pass would
  // deliberately keep is the one way this number could lie.
  const toolIndexes = entries.flatMap((e, i) => (e.role === "tool" ? [i] : []));
  const protectedFrom = toolIndexes[Math.max(0, toolIndexes.length - KEEP_LAST_N)] ?? entries.length;

  entries.forEach((entry, i) => {
    switch (entry.role) {
      case "tool": {
        const cost = estimateTokens(entry.content);
        results += cost;
        bump(names.get(entry.toolCallId) ?? "(unknown tool)", cost, 0);
        if (!isCleared(entry.content) && i < protectedFrom) reclaimable += cost;
        break;
      }
      case "assistant": {
        replies += estimateTokens(entry.content);
        for (const call of entry.toolCalls ?? []) {
          const cost = estimateTokens(call.arguments);
          args += cost;
          bump(call.name, cost, 1);
          // A write_file call carries the whole file it wrote. Clearing those payloads
          // is the same free pass that clears results, and on measured sessions it is
          // the bigger half — leaving it out would understate the largest lever there is.
          if (CONTENT_CARRYING_TOOLS.has(call.name) && !argsCleared(call.arguments) && i < protectedFrom) {
            reclaimable += cost;
          }
        }
        break;
      }
      case "user":
        if (entry.synthetic) notes += estimateTokens(entry.content);
        else yours += estimateTokens(entry.content);
        break;
      case "summary":
        summaries += estimateTokens(entry.content);
        break;
    }
  });

  const slices: BudgetSlice[] = [];
  if (overhead !== undefined) slices.push({ label: "System prompt and tools", tokens: overhead, measured: true });
  slices.push(
    { label: "Tool results", tokens: results },
    { label: "Tool call arguments", tokens: args },
    { label: "Mindweave's replies", tokens: replies },
    { label: "Your messages", tokens: yours },
  );
  if (notes > 0) slices.push({ label: "Automatic reminders", tokens: notes });
  if (summaries > 0) slices.push({ label: "Compaction summaries", tokens: summaries });

  return {
    slices: slices.filter((s) => s.tokens > 0),
    total: slices.reduce((n, s) => n + s.tokens, 0),
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens),
    reclaimable,
  };
}

const BAR_WIDTH = 24;

function short(tokens: number): string {
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return `${tokens}`;
}

/**
 * Render the breakdown as the block `/context` prints.
 *
 * Pure so the shape can be asserted without a terminal. The percentages are of the
 * TOTAL rather than of the window, because the question being answered is "what is
 * filling this", not "how full is it" — the header already answers the second, once.
 */
export function formatBudget(budget: ContextBudget, window: number, autoBar: number): string {
  if (budget.total === 0) return "Nothing in context yet beyond the system prompt.";

  const pct = (n: number) => Math.round((n / budget.total) * 100);
  const width = Math.max(...budget.slices.map((s) => s.label.length));
  const lines = budget.slices.map((s) => {
    const filled = Math.max(1, Math.round((s.tokens / budget.total) * BAR_WIDTH));
    // An estimate and a reported figure are not the same claim, and the table is the
    // only place that difference can be shown without a footnote nobody reads.
    const mark = s.measured ? " " : "~";
    return `  ${s.label.padEnd(width)}  ${mark}${short(s.tokens).padStart(6)}  ${String(pct(s.tokens)).padStart(3)}%  ${"█".repeat(filled)}`;
  });

  const head = `${short(budget.total)} of ${short(window)} in context · compacts at ${short(autoBar)}`;
  const out = [head, "", ...lines];

  const heaviest = budget.tools.slice(0, 4).filter((t) => t.tokens > 0);
  if (heaviest.length > 0) {
    out.push("", "  Heaviest tools:");
    for (const t of heaviest) {
      const calls = t.calls > 0 ? ` ×${t.calls}` : "";
      out.push(`    ${t.name}${calls} — ~${short(t.tokens)}`);
    }
  }

  out.push(
    "",
    budget.reclaimable > 0
      ? `  /compact frees about ${short(budget.reclaimable)} of old tool output without asking the model to summarize.`
      : "  Nothing old enough to clear yet.",
  );
  out.push("  ~ marks an estimate from character counts; unmarked figures are what the provider reported.");
  return out.join("\n");
}
