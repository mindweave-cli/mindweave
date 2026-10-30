/**
 * lessonSignals.ts — when a stretch of work is worth looking back on (pure, no model call).
 *
 * Looking back costs a model call, so something has to say it may be worth one. Everything here
 * reads only what is already in the conversation, and none of it decides what is learned: that is
 * the agent's judgment when it looks back, and it may well decide there is nothing to keep.
 *
 *   - A goal that failed at least twice and then got done: the difference is the lesson.
 *   - The person saying how they want things done, or that something is wrong.
 *   - The person confirming an approach, so what worked is kept as well as what did not. A store
 *     made only of corrections drifts toward caution and away from what was already agreed.
 *   - The person turning down an action.
 *   - The agent itself saying its approach was wrong.
 *   - A decision, or the reason for one, which nothing in the code will ever say.
 */
import type { Entry } from "./types.js";
import type { LessonState } from "./lessons.js";

/** Failed attempts that make a struggle once the goal gets done. */
export const STRUGGLE_FAILURES = 2;
/** Turns of real work after which it is looked back on anyway, since not every preference is announced. */
export const REFLECT_EVERY_TURNS = 8;
const MAX_GOALS = 60;
const MAX_ATTEMPTS = 4;
const MAX_STRUGGLES = 8;
const TEXT_CLIP = 220;

function clip(text: string, max = TEXT_CLIP): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The first line of a failure that says something (pure). */
function errorLine(output: string): string {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return clip(line.replace(/^Error:\s*/, ""));
}

/**
 * What a call was trying to do, so two attempts at one thing are recognised as such (pure). The
 * leading words of a command, not all of it: the attempts that matter differ in their arguments.
 */
export function goalKey(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") {
    const words = args.command.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    return `${name}:${words.slice(0, 2).join(" ").toLowerCase()}`;
  }
  const path = args.path ?? args.file_path;
  return typeof path === "string" ? `${name}:${path.replace(/\\/g, "/").toLowerCase()}` : name;
}

/** A call as it is written down for the look back (pure). */
export function callText(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return clip(args.command);
  const path = args.path ?? args.file_path;
  if (typeof path === "string") return `${name} ${clip(path)}`;
  return clip(`${name} ${JSON.stringify(args)}`);
}

/** Take in one finished call: a failure is counted against its goal, and a success after enough of them is a struggle. */
export function noteAttempt(
  state: Pick<LessonState, "attempts" | "struggles">,
  name: string,
  args: Record<string, unknown>,
  output: string,
  isError: boolean,
): void {
  const goal = goalKey(name, args);
  const failed = state.attempts.get(goal);
  if (isError) {
    const list = failed ?? [];
    list.push({ call: callText(name, args), error: errorLine(output) });
    state.attempts.delete(goal);
    state.attempts.set(goal, list.slice(-MAX_ATTEMPTS));
    if (state.attempts.size > MAX_GOALS) state.attempts.delete(state.attempts.keys().next().value!);
    return;
  }
  if (!failed) return;
  state.attempts.delete(goal);
  if (failed.length < STRUGGLE_FAILURES) return;
  state.struggles.push({ goal, failed, worked: callText(name, args) });
  if (state.struggles.length > MAX_STRUGGLES) state.struggles.shift();
}

const SWEARING = /\b(wtf|wth|ffs|omfg|fuck\w*|shit\w*|bullshit|dumbass|crap|damn|bloody hell|what the (hell|heck))\b/i;
const COMPLAINT = /\b(what are you doing|why (did|are|do|would) you|i (already )?told you|how many times|still (not|doesn'?t|isn'?t|broken|wrong)|not (what i|working)|doesn'?t work|you (broke|forgot|ignored|missed|keep)|again\?|that'?s (wrong|not right|not it)|this is (wrong|broken|bad|ugly|terrible|awful|useless))\b/i;
const INSTRUCTION = /\b(never|always|from now on|going forward|in (the )?future|next time|every time|do not|don'?t|stop|no more|instead of|rather than|make sure|remember|i (want|prefer|like|hate|need) (you|it|them|to)|the way i)\b/i;
const CONFIRMATION = /\b(perfect|exactly|great work|good work|nice work|well done|love (it|this|that)|that'?s (it|right|the one|great|perfect)|works? (great|perfectly|now)|keep doing|yes,? (like|that)|good (call|idea))\b/i;
const SELF_CORRECTION = /\b(different approach|another approach|another way|my mistake|i was wrong|i made a mistake|i got (that|it) wrong|that (didn'?t|did not) work|wrong (approach|assumption|path)|i misread|i misunderstood|start(ing)? over|step(ping)? back)\b/i;
const DECISION = /\b(let'?s go with|we('?re| are|'?ll| will) (go|going) with|we decided|i decided|i'?ve decided|ruled out|rejected|the reason (is|we|for)|deadline|that'?s it for (today|now)|stopping here|pick (this|it) up (later|tomorrow))\b/i;
const DECLINED = /\b(declined|refused by the user|the user (said no|chose not|did not approve|rejected)|not approved)\b/i;

/** Whether words are loud: several words in capitals, not counting the short ones that are always written that way (pure). */
function shouting(text: string): boolean {
  const words = text.match(/\b[A-Za-z]{2,}\b/g) ?? [];
  const loud = words.filter((w) => w.length >= 4 && w === w.toUpperCase());
  return loud.length >= 2 && loud.length / words.length >= 0.3;
}

/** Whether the person sounds unhappy with how this is going (pure). A reason to rethink, and never by itself a reason to save anything. */
export function soundsUnhappy(text: string): boolean {
  return SWEARING.test(text) || COMPLAINT.test(text) || shouting(text);
}

export type LessonSignal = "instruction" | "unhappy" | "confirmed" | "self-corrected" | "declined" | "decision";

/** What the entries from a reflection's cursor on show (pure). `work` says whether any tool ran in them. */
export function signalsIn(entries: readonly Entry[]): { signals: Set<LessonSignal>; work: boolean } {
  const signals = new Set<LessonSignal>();
  let work = false;
  for (const e of entries) {
    if (e.role === "user") {
      if (e.synthetic) continue;
      if (INSTRUCTION.test(e.content)) signals.add("instruction");
      if (soundsUnhappy(e.content)) signals.add("unhappy");
      if (CONFIRMATION.test(e.content)) signals.add("confirmed");
      if (DECISION.test(e.content)) signals.add("decision");
    } else if (e.role === "assistant") {
      if (e.toolCalls?.length) work = true;
      if (SELF_CORRECTION.test(e.content)) signals.add("self-corrected");
    } else if (e.role === "tool") {
      if (e.content.length < 2_000 && DECLINED.test(e.content)) signals.add("declined");
    }
  }
  return { signals, work };
}

/**
 * Whether to look back now (pure).
 *
 * Praise for a reply with no work behind it teaches nothing, and neither does a remark in a chat. Words
 * count once work has happened; a struggle or a turned-down action always counts; a lesson that keeps
 * failing has to be looked at; and long enough without any signal is looked back on regardless.
 */
export function reflectionDue(o: {
  signals: ReadonlySet<LessonSignal>;
  work: boolean;
  struggles: number;
  doubtful: number;
  turnsSince: number;
}): boolean {
  if (o.struggles > 0 || o.doubtful > 0 || o.signals.has("declined") || o.signals.has("self-corrected")) return true;
  if (o.signals.has("instruction") || o.signals.has("decision")) return true; // "from now on, …" stands whether or not anything ran
  if (o.work && (o.signals.has("unhappy") || o.signals.has("confirmed"))) return true;
  return o.turnsSince >= REFLECT_EVERY_TURNS;
}

/** The note for a turn that is going badly (pure). It sends the agent back to think; what it learns is decided later. */
export const UNHAPPY_NUDGE =
  "The user's last message reads as unhappy with how this is going. Before doing more, work out what you assumed and " +
  "what they actually asked for. If your approach is not working, change it instead of repeating it. Do not apologise " +
  "at length, and do not mention this note.";

export const REPEATING_NUDGE =
  "The last attempts at this failed the same way. Do not try it a third time unchanged: work out why it fails, then " +
  "take a different approach. Do not mention this note.";
