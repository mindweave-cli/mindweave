/**
 * providerError.ts — telling "your account cannot run this" apart from "we sent
 * something broken".
 *
 * Both arrive as a failed HTTP request and, before this, both came out as the same
 * red error with a JSON blob attached:
 *
 *   ⚠ DeepSeek API error 402: {"error":{"message":"Insufficient Balance", …}}
 *
 * That is the wrong shape twice over. It reads as a crash when nothing is broken,
 * and it buries the one sentence that actually explains the situation.
 *
 * WHY THIS DOES NOT CLASSIFY THE REASON. The obvious version reads the body and
 * decides whether it is billing, a rate limit, or a revoked key, then writes a
 * tailored message. Ten providers word those three things ten ways, so that version
 * is occasionally confidently wrong — and telling someone to top up when they only
 * need to wait thirty seconds is worse than saying nothing specific at all.
 *
 * So this module does not explain. It recognises that the provider refused for an
 * ACCOUNT reason, and QUOTES the provider's own sentence. The wrapper is universal
 * and cannot be wrong; the precision comes from the provider, which already knows.
 */

import { isRetryable } from "./retryPolicy.js";

/** A refusal, ready for the `notice` transcript block. */
export interface Refusal {
  /** Names the provider, so a BYOK tool is never mistaken for the one billing you. */
  title: string;
  /** The provider's own words, then what to do about it. Rendered verbatim. */
  body: string;
}

/**
 * Statuses that mean the ACCOUNT cannot run this request.
 *
 * Deliberately narrow. A 400 is a malformed request — our bug, in a parameter we
 * chose — and dressing that up as a calm account notice would hide exactly the class
 * of defect that a driver's per-model rules exist to prevent. 5xx is the provider
 * falling over, which is transient and already mapped to `overloaded`. Only these
 * four mean "the key is fine as a string, but the account behind it will not serve
 * you right now".
 */
const ACCESS_STATUSES = new Set([401, 402, 403, 429]);

/**
 * The one exception, and it is Anthropic's fault rather than a weakening of the rule.
 *
 * Anthropic returns a spent balance as **400 `invalid_request_error`**, not 402:
 *
 *   {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"Your credit balance is too low to access the Anthropic API…"}}
 *
 * 400 otherwise means we sent something malformed, which must stay loud, so the
 * status alone cannot decide it. This is a narrow reprieve: a 400 counts as an
 * account refusal only when the provider's own sentence is unambiguously about an
 * allowance. Note what it is NOT doing — it is not diagnosing WHY among account
 * causes, which is the thing this module refuses to guess at. It answers the prior
 * question, "is this about the account at all", for the one status where the code is
 * useless, and it answers it with the provider's words rather than ours.
 *
 * Kept deliberately tight, because the failure directions are not symmetric: a miss
 * shows an ugly-but-honest red error, while a false match hides a real bug of ours
 * behind a reassuring message. Every phrase here is about money or allowance and
 * nothing else. (LiteLLM shipped the un-handled version of this and it silently
 * broke their provider fallback, which is the same defect in a different coat.)
 */
const BALANCE_PHRASES = [
  "credit balance",
  "insufficient balance",
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "billing",
  "payment required",
  "purchase credits",
];

/** Whether a message is unambiguously about an account allowance. */
function namesAnAllowance(message: string): boolean {
  const text = message.toLowerCase();
  return BALANCE_PHRASES.some((phrase) => text.includes(phrase));
}

/** The HTTP status carried by an error, whether ours or an SDK's. Null if none. */
export function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * The raw body an error carries, from whichever field its source used.
 *
 * Three shapes reach here and none of them agree. Our own `ProviderHttpError` keeps
 * the untouched response text on `detail`. The Anthropic and OpenAI SDKs parse the
 * body for us and hang the OBJECT on `error`. Everything else has only a `message`,
 * which for an SDK is the status and the whole JSON blob concatenated — parseable by
 * nothing, which is why it is the last resort rather than the first.
 */
export function detailOf(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const e = error as { detail?: unknown; error?: unknown; message?: unknown };
  if (typeof e.detail === "string" && e.detail.trim()) return e.detail;
  // An SDK's pre-parsed body. Re-serialising it lets one extractor handle both
  // routes instead of two that can disagree about which field wins.
  if (e.error && typeof e.error === "object") {
    try {
      return JSON.stringify({ error: e.error });
    } catch {
      /* circular or otherwise unserialisable; fall through to the message */
    }
  }
  return typeof e.message === "string" ? e.message : String(error);
}

/**
 * The provider's own explanation, pulled out of whatever it sent back.
 *
 * Providers return the sentence in at least four shapes, so each is tried in turn
 * and the raw text is the last resort. The result is capped: a body can be a full
 * HTML error page, and the notice renders in the footer, where an unbounded string
 * pushes the input box off the screen (the exact failure the plan-approval overlay
 * hit once already).
 */
export function providerMessage(detail: string): string {
  const raw = (detail ?? "").trim();
  if (!raw) return "";

  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      const candidates = [
        typeof err === "object" && err ? (err as Record<string, unknown>).message : undefined,
        typeof err === "string" ? err : undefined,
        obj.message,
        obj.detail,
      ];
      const found = candidates.find((c) => typeof c === "string" && c.trim());
      if (typeof found === "string") text = found.trim();
    }
  } catch {
    // Not JSON. The raw text is the message, which is what several providers send.
  }

  // One line, bounded. Newlines would break the rail's alignment, and the length
  // cap is what stops an HTML page from evicting the input box.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

/**
 * Recognise an account-level refusal and shape it for the screen.
 *
 * Returns null for anything else, which is the caller's signal to keep its ordinary
 * red error. Being conservative here is the point: a false negative shows a message
 * that is merely ugly, while a false positive tells the user their account is the
 * problem when the bug is ours.
 *
 * @param canSwitch whether another installed provider has a key. When it does not,
 *   suggesting `/provider` is noise — there is nothing to switch to.
 */
export function accessRefusal(error: unknown, providerLabel: string, canSwitch: boolean): Refusal | null {
  const status = statusOf(error);
  if (status === null) return null;
  const said = providerMessage(detailOf(error));
  // A 400 has to earn it by naming an allowance; every other listed status is
  // already unambiguous. See BALANCE_PHRASES for why the exception exists.
  const isRefusal = ACCESS_STATUSES.has(status) || (status === 400 && namesAnAllowance(said));
  if (!isRefusal) return null;

  // WHICH failure decides the advice. A rejected key is fixed here, by typing it again —
  // it is the commonest way a first run dies, usually a typo or a key pasted for the
  // wrong provider, and "sort it out on the provider's side" sends someone to a billing
  // page over a mistyped character. A spent balance or a rate limit genuinely is on the
  // provider's side, and offering to retype a working key would be the wrong steer.
  const keyRejected = status === 401 || status === 403;
  const switchLine = canSwitch ? " Or /provider to use a different one." : "";
  const action = keyRejected
    ? "The conversation is saved. Run /key to enter it again — a mistyped key, or one for" +
      String.fromCharCode(10) + "a different provider, is the usual cause." + switchLine
    : "The conversation is saved. Sort it out on the provider's side and pick up" +
      String.fromCharCode(10) + "where you left off." + switchLine;

  return {
    title: `${providerLabel} isn't accepting requests on this key`,
    body: said ? `${said}\n\n${action}` : action,
  };
}

/**
 * Recognise a failure on the provider's side and shape it for the screen.
 *
 * By the time one of these reaches the user, the retry layer has already tried again
 * and given up, so the useful thing to say is what the user can do: wait, or pick
 * another model. A red "API error 502: ERROR" says neither, and reads as if Mindweave
 * crashed. Three shapes count:
 *   - a 5xx status, the provider or its upstream host falling over;
 *   - a failure the provider reported inside a successful response (a router whose
 *     upstream died mid-reply), which carries no status;
 *   - a request that never got through, after the network retries ran out.
 *
 * A 4xx never lands here. 400 and friends are a request we built wrong and stay loud;
 * 401/402/403/429 are `accessRefusal`'s.
 *
 * The provider's own sentence is quoted when it says something. Routers often send a
 * bare "ERROR" or the status text, and quoting that adds a line that explains nothing.
 */
export function providerOutage(error: unknown, providerLabel: string, modelLabel: string): Refusal | null {
  const status = statusOf(error);
  const upstream = !!error && typeof error === "object" && (error as { upstream?: unknown }).upstream === true;
  const serverSide = status !== null && status >= 500 && status < 600;
  const unreachable = status === null && !upstream && isRetryable(error, null);
  if (!serverSide && !upstream && !unreachable) return null;

  const NL = String.fromCharCode(10);
  const advice = "The conversation is saved. Try again in a moment, or pick a different model with /model.";

  if (unreachable) {
    return {
      title: `Can't reach ${providerLabel}`,
      body: `The request didn't get through, even after retrying. Check your connection, or the provider may be down.${NL}${NL}${advice}`,
    };
  }

  const reported = serverSide
    ? providerMessage(detailOf(error))
    : providerMessage(String((error as Error).message ?? "").replace(/^.*?API error:\s*/, ""));
  const informative =
    reported.length > 0 &&
    !/^(error|internal server error|bad gateway|service unavailable|gateway timeout|the reply ended with an error)\.?$/i.test(reported);
  const what = serverSide
    ? `${providerLabel} returned an error (${status}) while running it, even after retrying.`
    : `${providerLabel} reported an error part way through the reply.`;
  const lines = [
    `${what} This is on the provider's side, not your key or your setup. New and preview models fail like this more often.`,
    ...(informative ? [`${providerLabel} said: "${reported}"`] : []),
  ];
  return {
    title: `${modelLabel} isn't responding right now`,
    body: `${lines.join(NL)}${NL}${NL}${advice}`,
  };
}
