/**
 * resolveName.ts — finding the thing a person asked to remove (pure).
 *
 * "Remove that rule", "forget the skill", "you can run that again": the tools that take something back used to want an exact
 * identifier the model was never shown. The rules block lists a rule's text, not its name, so the model passed the text, was told
 * "no rule named …", and tried again, three times, with the same answer. What was asked for is found here by what the person would
 * call it: its name, the text of it, or a distinctive part of either, and only when that points at exactly one thing.
 */

export type Match<T> = { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none" };

/** A text as it is compared: lower case, one space between words, no quotes, backticks or closing punctuation. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();
}

/** The same with every run of anything but letters and digits as one dash: how a name becomes a file name. */
export function slug(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The shortest piece of a query that may stand for a longer text. Below it a few letters would match half of everything. */
const MIN_PART = 6;

/**
 * The one item a query names, in order of how sure the match is: its text or name exactly, the same ignoring punctuation, then a
 * piece of one inside the other. A later step is only tried when the earlier ones found nothing, and a step that finds several
 * says so (`many`) rather than choosing.
 */
export function resolveEntry<T>(items: readonly T[], query: string, textsOf: (item: T) => string[]): Match<T> {
  const q = normalize(query);
  if (!q) return { kind: "none" };
  const pick = (found: T[]): Match<T> | null => (found.length === 1 ? { kind: "one", item: found[0]! } : found.length > 1 ? { kind: "many", items: found } : null);

  const exact = items.filter((it) => textsOf(it).some((t) => normalize(t) === q));
  const a = pick(exact);
  if (a) return a;

  const qSlug = slug(query);
  const same = qSlug ? items.filter((it) => textsOf(it).some((t) => slug(t) === qSlug)) : [];
  const b = pick(same);
  if (b) return b;

  // A piece of one in the other: the query is part of the text (a distinctive phrase), or the text is part of a longer query
  // (the whole sentence quoted around a short name).
  const partial = items.filter((it) =>
    textsOf(it).some((t) => {
      const n = normalize(t);
      if (!n) return false;
      return (q.length >= MIN_PART && n.includes(q)) || (n.length >= MIN_PART && q.includes(n));
    }),
  );
  return pick(partial) ?? { kind: "none" };
}
