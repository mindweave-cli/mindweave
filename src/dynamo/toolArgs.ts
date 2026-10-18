/**
 * toolArgs.ts — what to do with a tool call whose arguments are not valid JSON.
 *
 * The model's arguments arrive as one string, and nothing guarantees it parses: a reply cut off at the output
 * limit, a stray colon, a string that was encoded twice. The engine used to read such a string as `{}`, so the
 * tool answered "`path` is required" about a call that DID carry a path. The model then had no way to know its
 * JSON was the problem, and the broken text stayed in the history, going back to the provider on every later
 * request (several providers re-parse it and refuse the whole request).
 *
 * So a broken call is refused with the parse error and the place it went wrong, and what goes back to the
 * provider is a short valid stand-in. Nothing is repaired: a guessed repair that runs a write is worse than one
 * more round trip, and the model can fix its own JSON when told where it broke.
 */

/** Longest piece of the broken text echoed back, to the model and into the history. */
const ECHO_CHARS = 300;

/** Why `raw` cannot be used as a tool call's arguments, or null when it can. An empty string means "none". */
export function argsProblem(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return describeParseFailure(raw, String((error as Error)?.message ?? error));
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
    return `The arguments must be one JSON object, and this was ${kind}.${typeof parsed === "string" ? " A JSON object that was encoded as a string a second time reads like this: send the object itself." : ""}`;
  }
  return null;
}

function describeParseFailure(raw: string, reason: string): string {
  const at = /position (\d+)/.exec(reason);
  const position = at ? Number(at[1]) : raw.length;
  const cutOff =
    /unexpected end|unterminated/i.test(reason) || position >= raw.length - 1 || openBrackets(raw) > 0;
  const from = Math.max(0, position - 40);
  const near = raw.slice(from, Math.min(raw.length, position + 40)).replace(/\s+/g, " ");
  return (
    `The arguments are not valid JSON (${reason.replace(/\s*\(line \d+ column \d+\)/, "")}). ` +
    `The first problem is near: …${near}…` +
    (cutOff
      ? ` The text ends before the JSON is closed, which is what a reply cut off at the output limit looks like: ` +
        `send a smaller call (several edits or smaller writes instead of one very large one).`
      : "")
  );
}

/** How many `{` or `[` are still open at the end of `raw`, ignoring brackets inside strings. */
function openBrackets(raw: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth + (inString ? 1 : 0);
}

/** The refusal the model reads in place of a result. */
export function argsRefusal(toolName: string, problem: string): string {
  return `Not run: the arguments for \`${toolName}\` could not be read, so nothing was changed. ${problem} Send the call again with valid JSON.`;
}

/**
 * The arguments as they go back to the provider in the history. Valid JSON stays as it is. A broken string is
 * replaced by a valid object that carries the start of it, so the model still sees what it tried, and a provider
 * that parses every earlier call does not refuse the request.
 */
export function wireArguments(raw: string): string {
  if (argsProblem(raw) === null) return raw;
  const shown = raw.length > ECHO_CHARS ? `${raw.slice(0, ECHO_CHARS)}… (${raw.length} characters in all)` : raw;
  return JSON.stringify({ _invalid_json: shown });
}
