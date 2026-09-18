/**
 * feedback.ts — `/feedback`: send the maintainer a message from inside the app.
 *
 * The point is that it costs the sender nothing. No account, no sign-in, no issue
 * tracker, no mail client: they type a sentence and it arrives. That is the whole reason
 * this exists rather than a link to a GitHub issue, which asks for an account before it
 * asks what is wrong.
 *
 * It goes to a Google Form, which mails the maintainer each response. That is an odd
 * choice until you try the alternatives: the hosted form relays (Web3Forms, FormSubmit)
 * all check that a post came from a web page, and refuse one from a terminal. Web3Forms
 * answers 403 "use our API in client side ... Pro plan is required"; FormSubmit answers
 * 200 with "open this page through a web server" in the body. Both are fixable only by
 * forging a browser origin, which is a lie and a banned endpoint. A form accepts a plain
 * post from anywhere, costs nothing, has no quota, and the id below is public by design,
 * so the maintainer's address is not in an open repository. Env-overridable, so the
 * destination can move without a release.
 *
 * What is sent is decided here and nowhere else, and it is deliberately tiny: the typed
 * message, the version, and the platform. Never the conversation, the project, file
 * paths, or the model in use. The app shows the exact payload and asks before sending —
 * a feature that mails things somewhere has to be readable before it is trusted.
 */

/**
 * The form this build posts to, and the field ids of its three questions.
 *
 * The ids are the form's own, read out of its published page. They are not guessable
 * and not secret: anyone can post to a published form, which is the point.
 */
const FORM_ACTION = "https://docs.google.com/forms/d/e/1FAIpQLSe6SkkbxfPhpO9CFIcxJ4QS_yyAxpIvUcs_xaj-qZY9oDUX1w/formResponse";
const FIELDS = {
  message: "entry.1316937348",
  version: "entry.817852384",
  platform: "entry.450821039",
} as const;

/**
 * What a form page carries and a confirmation page does not: the question list.
 *
 * A refused post is answered with the form itself and a 200, so believing the status
 * would report a message as sent when nothing was recorded.
 */
const FORM_MARKER = "FB_PUBLIC_LOAD_DATA_ = [null,[null,";

/**
 * Where a message goes (pure).
 *
 * Read at send time rather than at import, so setting the variable works whatever order
 * modules happened to load in.
 */
function destination(): string {
  return process.env.MINDWEAVE_FEEDBACK_URL ?? FORM_ACTION;
}
/** Where to go when sending is not possible. */
export const ISSUES_URL = "https://github.com/mindweave-cli/mindweave/issues";

/** Longer than this is a bug report that belongs in an issue, not a relay. */
export const MAX_MESSAGE = 4_000;

/** What leaves the machine. Every field is here; there are no hidden ones. */
export interface Feedback {
  message: string;
  version: string;
  platform: string;
}

/**
 * Shapes that mean a secret was pasted in by accident (pure).
 *
 * A feedback box invites pasting the thing that just failed, and the thing that just
 * failed is often a request carrying a key. This refuses rather than warns: a key mailed
 * to a third-party relay cannot be unmailed, and the sender can always retype the message
 * without it.
 */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style, and the many that copied it
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}/, // OpenRouter
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google
  /\bAKIA[0-9A-Z]{12,}/, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token)[A-Za-z0-9_-]*\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i,
];

/** The reason this message must not be sent, or null when it is fine (pure). */
export function refuseReason(message: string): string | null {
  const text = message.trim();
  if (!text) return "Nothing to send — type the message after /feedback, or use /feedback on its own for a box.";
  if (text.length > MAX_MESSAGE) {
    return `That is ${text.length} characters and the limit is ${MAX_MESSAGE}. Send the short version, or open an issue: ${ISSUES_URL}`;
  }
  if (SECRET_SHAPES.some((shape) => shape.test(text))) {
    return "That message looks like it contains an API key or token, so it was not sent. Remove it and try again.";
  }
  return null;
}

/**
 * One more line on the message (pure).
 *
 * Kept as its own function because the confirm loops: someone reads their message back,
 * remembers their email, types it, and must land on the same confirm with the line added
 * rather than starting again. A blank addition changes nothing.
 */
export function withAddition(message: string, addition: string): string {
  const extra = addition.trim();
  if (!extra) return message;
  return `${message.trimEnd()}
${extra}`;
}

/** The payload, from the message and this machine (pure). */
export function buildFeedback(message: string, version: string, platform: string = process.platform): Feedback {
  return { message: message.trim(), version, platform };
}

/**
 * How much of the message the confirm question shows. The confirm lives INSIDE the shared
 * command box, which gives a question four wrapped rows before it clips — so this is
 * bounded here rather than being cut by the renderer, where the sender would not know
 * whether the rest was going to be sent or not.
 */
const PREVIEW_CHARS = 150;

/** The confirm question, sized to fit the box: what goes, and what does not (pure). */
export function previewOf(feedback: Feedback): string {
  const text = feedback.message.replace(/\s+/g, " ").trim();
  const shown = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  const rest = text.length > PREVIEW_CHARS ? ` (all ${text.length} characters are sent)` : "";
  return (
    `Send to Mindweave's maintainer: "${shown}"${rest} — with Mindweave ` +
    `${feedback.version || "an unknown version"} on ${feedback.platform}, and nothing else. ` +
    `Your conversation, code and keys are not sent. For a reply, put your email in the message.`
  );
}

/**
 * What the relay said about the post: whether it took it, and its own sentence.
 *
 * The status alone does not answer this. A relay can refuse a message and still answer
 * 200 with the refusal in the body, which is what happened on the first live send: HTTP
 * 200, body {"success":"false", ...}, and the app told the sender their message had
 * arrived when nothing had been mailed. A feature whose whole job is delivery must never
 * claim delivery it cannot see.
 */
async function relayVerdict(response: Response): Promise<{ accepted: boolean; said: string }> {
  const ok = response.ok;
  try {
    const text = (await response.text()).trim();
    if (!text) return { accepted: ok, said: "" };
    try {
      const parsed = JSON.parse(text) as { success?: unknown; message?: unknown; error?: unknown };
      // `success` is the relay's OWN verdict, and relays write it both as a boolean and
      // as the string "false". When it is absent the status is all there is.
      const claim = parsed.success;
      const accepted =
        claim === undefined ? ok : ok && claim !== false && claim !== "false" && claim !== 0;
      const said =
        typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.error === "string"
            ? parsed.error
            : "";
      return { accepted, said: oneLine(said) };
    } catch {
      // Not JSON, so the status decides — with one exception worth checking. A form
      // answers an accepted post with a confirmation page and a REFUSED one by serving
      // the form again, both with a 200. The question list is what tells them apart.
      const formCameBack = text.includes(FORM_MARKER);
      const accepted = ok && !formCameBack;
      const page = oneLine(text.replace(/<[^>]*>/g, " "));
      return {
        accepted,
        said: accepted
          ? ""
          : formCameBack
            ? "the form was returned instead of a confirmation, so nothing was recorded"
            : page,
      };
    }
  } catch {
    return { accepted: ok, said: "" };
  }
}

/** One bounded line, for a sentence that has to fit in the transcript (pure). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** The outcome, already worded for the transcript. */
export interface SendResult {
  ok: boolean;
  message: string;
}

/**
 * Send it. `fetchImpl` is injectable so the whole path is testable without the network.
 *
 * Every failure ends with somewhere else to go. A relay that is down, rate-limited, or
 * out of its monthly allowance must not leave someone who took the trouble to write
 * something with nothing to do about it.
 */
export async function sendFeedback(
  feedback: Feedback,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  // A form post, because that is what a form accepts. The field NAMES are the form's,
  // the field VALUES are the same three things the confirm screen showed and no more.
  const body = new URLSearchParams({
    [FIELDS.message]: feedback.message,
    [FIELDS.version]: feedback.version,
    [FIELDS.platform]: feedback.platform,
  });
  const endpoint = destination();
  if (!endpoint) {
    return {
      ok: false,
      message: `Feedback has no destination configured in this build, so nothing was sent. Open an issue instead: ${ISSUES_URL}`,
    };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    // The relay's OWN sentence, when it wrote one. A bare "answered 403" cost a real
    // debugging round: the body read "use our API in client side (Pro plan is required)",
    // which was the whole diagnosis and was being thrown away.
    const { accepted, said } = await relayVerdict(response);
    if (!accepted) {
      return {
        ok: false,
        message:
          `Feedback was not sent (the relay answered ${response.status}${said ? `: ${said}` : ""}). ` +
          `Nothing was lost — you can open an issue instead: ${ISSUES_URL}`,
      };
    }
    return { ok: true, message: "Sent. Thank you — it goes straight to the maintainer." };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Feedback could not be sent (${why}). It may be your connection. You can open an issue instead: ${ISSUES_URL}`,
    };
  }
}
