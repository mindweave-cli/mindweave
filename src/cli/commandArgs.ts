/**
 * commandArgs.ts — turning what someone typed after a command into a choice.
 *
 * `/model`, `/think` and `/compact` all took an argument and threw it away without a
 * word. Naming a model after `/model` opened the picker as if you had typed nothing,
 * which reads as the app not having heard you — and is worse than an error, because an
 * error tells you to try something else and silence tells you nothing.
 *
 * Terminal agents generally accept an argument on all three, so it is what someone
 * will type without thinking about it — which is exactly when silence is worst.
 *
 * Nothing here knows any provider's lineup: the candidates are handed in by the caller,
 * which reads them from the registry. That is the rule for core code, and it is also
 * what makes this testable without a key.
 *
 * The matching is deliberately forgiving in a bounded way: exact id or label, then a
 * UNIQUE prefix, then every typed WORD appearing somewhere in the id or label, in any
 * order. Words matter once a provider lists hundreds of models: "deepseek flash" has to
 * find "DeepSeek V4.1 Flash" although "V4.1" sits between the two words. Never a
 * "closest guess" — picking a model or a reasoning budget is a decision with a cost
 * attached, and quietly choosing the nearest thing to a typo is how you end up billed
 * for the wrong one. Several matches come back as the list of them, so a caller can
 * offer exactly those; a miss comes back as a message.
 */

export interface Candidate {
  /** Machine name, e.g. a model id. Optional — `/think` levels have only a label. */
  id?: string;
  /** What the picker shows, e.g. a model's display name or "Thinking". */
  label: string;
}

export type Resolution =
  | { kind: "match"; index: number }
  /** More than one candidate fits. `message` names them, ready to show. */
  | { kind: "several"; indices: number[]; message: string }
  /** Nothing matched. `message` is ready to show. */
  | { kind: "error"; message: string };

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** "a, b or c" — a list a person reads, not a machine dump. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * Which candidate the typed argument means.
 *
 * `what` names the thing being chosen, so the message reads as a sentence rather than
 * as a template ("No model called…", "No reasoning level called…").
 */
export function resolveChoice(arg: string, candidates: readonly Candidate[], what: string): Resolution {
  const wanted = norm(arg);
  if (!wanted) return { kind: "error", message: `Which ${what}?` };

  const names = candidates.map((c) => c.label);

  // Exact wins outright, and is checked against BOTH the id and the label — the id is
  // what a script or a copied command line carries, the label is what the picker shows.
  const exact = candidates.findIndex((c) => norm(c.label) === wanted || (c.id !== undefined && norm(c.id) === wanted));
  if (exact >= 0) return { kind: "match", index: exact };

  const starts = matchesFor(candidates, (c) => startsWith(c, wanted));
  if (starts.length === 1) return { kind: "match", index: starts[0]! };
  if (starts.length > 1) return several(arg, starts, names);

  const words = wordsOf(arg);
  const all = matchesFor(candidates, (c) => words.every((w) => includes(c, w)));
  if (all.length === 1) return { kind: "match", index: all[0]! };
  if (all.length > 1) return several(arg, all, names);

  return { kind: "error", message: miss(arg, words, candidates, what) };
}

/** The words of a typed argument, lowercased. */
export function wordsOf(text: string): string[] {
  return norm(text).split(/\s+/).filter(Boolean);
}

/** True when every word appears in one of the texts. Shared with the picker's filter. */
export function matchesWords(words: readonly string[], ...texts: (string | undefined)[]): boolean {
  const hay = texts.filter((t): t is string => !!t).map(norm);
  return words.every((w) => hay.some((h) => h.includes(w)));
}

/**
 * Split `/model <words>` into the provider it names and the words left to match.
 *
 * The first word names a provider only when it is exactly one AND the whole phrase
 * matches nothing on the provider in use. So on a router `/model deepseek flash` finds
 * the router's DeepSeek Flash, while on a provider serving no DeepSeek model it moves
 * to DeepSeek. `/model openrouter` alone leaves no words, which means "show me its list".
 */
export function splitModelArg(
  arg: string,
  providers: readonly { id: string; label: string }[],
  current: string,
  matchesHere: boolean,
): { providerId: string; words: string } {
  const [first = "", ...rest] = wordsOf(arg);
  const named = providers.find((p) => norm(p.id) === first || norm(p.label) === first);
  if (!named || matchesHere) return { providerId: current, words: arg.trim() };
  return { providerId: named.id, words: rest.join(" ") };
}

/** A long list is not read by anyone, so beyond this only the nearest names are offered. */
const LIST_ALL_UP_TO = 12;

function miss(arg: string, words: readonly string[], candidates: readonly Candidate[], what: string): string {
  const said = `No ${what} called "${arg.trim()}".`;
  if (candidates.length <= LIST_ALL_UP_TO) return `${said} Available: ${list(candidates.map((c) => c.label))}.`;
  // Nearest by how many of the typed words each one contains. A suggestion, never a pick.
  const scored = candidates
    .map((c) => ({ c, score: words.filter((w) => includes(c, w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c.label);
  return scored.length > 0 ? `${said} Closest: ${list(scored)}.` : said;
}

function several(arg: string, indices: number[], names: readonly string[]): Resolution {
  return { kind: "several", indices, message: ambiguous(arg, indices.map((i) => names[i]!)) };
}

function matchesFor(candidates: readonly Candidate[], pred: (c: Candidate) => boolean): number[] {
  const out: number[] = [];
  candidates.forEach((c, i) => {
    if (pred(c)) out.push(i);
  });
  return out;
}

function startsWith(c: Candidate, wanted: string): boolean {
  return norm(c.label).startsWith(wanted) || (c.id !== undefined && norm(c.id).startsWith(wanted));
}

function includes(c: Candidate, wanted: string): boolean {
  return norm(c.label).includes(wanted) || (c.id !== undefined && norm(c.id).includes(wanted));
}

function ambiguous(arg: string, matched: readonly string[]): string {
  const shown = matched.length > LIST_ALL_UP_TO ? [...matched.slice(0, LIST_ALL_UP_TO), `${matched.length - LIST_ALL_UP_TO} more`] : matched;
  return `"${arg.trim()}" matches ${list(shown)}. Which one?`;
}
