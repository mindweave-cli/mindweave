/**
 * retryPolicy.ts — surviving a blip instead of losing the turn.
 *
 * Eleven of the thirteen providers reach their API through a raw `fetch` with no
 * retries at all. A single 429, or one 503 from a load balancer, threw out of the
 * transport, was rethrown by the engine, and ended the turn mid-task. The user had
 * already paid for the request, the work was gone, and the only remedy was to type it
 * again. Providers return those constantly and mean nothing by them.
 *
 * WHERE THIS IS SAFE TO APPLY, which is the whole reason it can exist at all: both
 * request paths check `response.ok` on the HEADERS, before a single byte of the body is
 * consumed and before any `onEvent` fires. So a failure at that point has emitted
 * nothing, and re-sending is genuinely re-sending rather than duplicating. A failure
 * DURING `consumeStream` is a different animal and is deliberately not retried here:
 * content has already reached the screen and the transcript, and replaying it would
 * double it.
 *
 * WHY THE BUDGET IS SMALL. A state-of-the-art client retries up to ten times and can
 * wait minutes, which is right for an unattended agent and wrong for a person watching
 * a prompt. Here the total wait is bounded so a retry always reads as "working" rather
 * than as a hang, and a cooldown longer than the budget is reported instead of slept
 * through: the provider's own sentence ("try again in 47 seconds") is more useful to
 * someone sitting there than 47 seconds of silence.
 */

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Attempts in total, so 3 means one try and two retries. */
export const RETRY_MAX_ATTEMPTS = env("MINDWEAVE_RETRY_ATTEMPTS", 4);

/** Total time this request may spend WAITING between attempts. */
export const RETRY_TOTAL_BUDGET_MS = env("MINDWEAVE_RETRY_BUDGET_MS", 30_000);

/** First backoff step; each retry doubles it. */
const BASE_DELAY_MS = 500;

/** No single wait longer than this, whatever the arithmetic says. */
const MAX_DELAY_MS = 8_000;

/**
 * Statuses worth trying again.
 *
 * 429 is here even though `providerError.ts` classifies it as an ACCOUNT refusal, and
 * the two are not in conflict: retrying comes first, and providerError renders whatever
 * is still failing once the budget is spent. A rate limit that clears in two seconds
 * should never have reached the user at all; one that does not clear still gets its
 * proper explanation.
 *
 * 400/401/402/403/404/422 are absent on purpose. None of them changes by being asked
 * again, and retrying a malformed request three times just makes a bug slower to see.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Words a provider uses when the ACCOUNT has no money left, as opposed to being busy.
 *
 * Several providers answer both with a 429, and the two are opposites for a retry: a busy
 * provider clears in seconds, an empty balance never does, so retrying it only delays the
 * explanation by the whole backoff and sends requests that cannot succeed. Deliberately
 * narrower than the list `providerError.ts` uses to word the notice: "exceeded your current
 * quota" is also how some providers phrase a per-minute limit that DOES clear, and that one
 * has to keep its retries.
 */
const SPENT_BALANCE = [
  "insufficient balance",
  "insufficient_quota",
  "credit balance",
  "no resource package",
  "payment required",
  "purchase credits",
  "please recharge",
];

/** Does this failure say the account is out of money, so waiting cannot help (pure)? */
export function isSpentBalance(error: unknown): boolean {
  const e = error as { detail?: unknown; message?: unknown } | null;
  const text = `${typeof e?.detail === "string" ? e.detail : ""} ${typeof e?.message === "string" ? e.message : ""}`.toLowerCase();
  return SPENT_BALANCE.some((phrase) => text.includes(phrase));
}

/** Transport failures that are worth another go. */
const RETRYABLE_NETWORK = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "epipe",
  "eai_again",
  "enetunreach",
  "socket hang up",
  "fetch failed",
  "network error",
  "terminated",
];

/** Did the user cancel? Never retried, and never mistaken for a network fault. */
export function isAbortLike(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  if (e?.name === "AbortError") return true;
  return typeof e?.message === "string" && /\babort/i.test(e.message);
}

/** Should this failure be tried again (pure)? */
export function isRetryable(error: unknown, status?: number | null): boolean {
  if (isAbortLike(error)) return false;
  if (typeof status === "number") return RETRYABLE_STATUSES.has(status) && !isSpentBalance(error);
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const text = [
    typeof e?.code === "string" ? e.code : "",
    typeof e?.message === "string" ? e.message : "",
    typeof (e?.cause as { code?: unknown })?.code === "string" ? ((e!.cause as { code: string }).code) : "",
  ]
    .join(" ")
    .toLowerCase();
  if (!text.trim()) return false;
  return RETRYABLE_NETWORK.some((needle) => text.includes(needle));
}

/**
 * How long the provider asked us to wait, in ms, or null if it did not say (pure).
 *
 * `Retry-After` comes as either a count of seconds or an HTTP date, and both are in the
 * wild. A date in the past reads as zero rather than as a negative wait.
 */
export function retryAfterMs(header: string | null | undefined): number | null {
  const raw = (header ?? "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/**
 * How long to wait before attempt `attempt` (1-based for the first RETRY), or null to
 * stop (pure).
 *
 * Returns null rather than a clamped delay when the provider's own cooldown exceeds
 * what is left of the budget. Sleeping "as long as we can" would wake up and fail
 * anyway, having spent the user's time to learn nothing.
 *
 * Jitter is full rather than partial: several drivers can be in flight at once (a turn
 * plus a background session-memory refresh), and identical backoff would march them
 * into the provider together on every step.
 */
export function nextDelayMs(
  attempt: number,
  spentMs: number,
  serverAskedMs: number | null,
  budgetMs: number = RETRY_TOTAL_BUDGET_MS,
  random: () => number = Math.random,
): number | null {
  const remaining = budgetMs - spentMs;
  if (remaining <= 0) return null;

  if (serverAskedMs !== null) {
    // The provider knows when it will serve us; obey it or admit we cannot wait.
    return serverAskedMs <= remaining ? serverAskedMs : null;
  }

  const ceiling = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
  const delay = Math.round(ceiling * (0.5 + random() * 0.5));
  return Math.min(delay, remaining);
}
