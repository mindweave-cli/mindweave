/**
 * messageQueue.ts — messages typed while Mindweave is working.
 *
 * The queue existed before this file did, as six lines inside App.tsx: push on send,
 * shift on turn end. That is enough to not lose a message and not enough to be a
 * feature. Three things were missing, and all three were things a user would only
 * discover by being burned:
 *
 *  - **No way back out.** Once queued, a message was going to be sent. Pressing ↑
 *    looked like editing it — the text appeared, because sending had already written
 *    it to history — but the queued copy was untouched. Editing and sending produced
 *    TWO messages: the edit, and the original the user thought they had just replaced.
 *  - **One turn each.** Three queued messages meant three full turns, each re-sending
 *    the whole conversation. The model also answered each in ignorance of the next,
 *    which is the wrong reading of someone typing three things in a row.
 *  - **Unbounded on screen.** The queue renders in the footer, and the footer is not
 *    height-bounded. Enough queued lines make the frame taller than the terminal,
 *    which corrupts the whole screen rather than clipping (see App's frameHeight
 *    note). Nothing stopped that.
 *
 * The shape: ↑ or Esc pulls the WHOLE queue back into the input as editable text, and
 * the drain batches. Kept deliberately as pure functions
 * over a plain array — the queue is small, always local to one App, and every rule in
 * it is worth a test.
 *
 * ## Two drains, because there are two moments
 *
 * A fourth thing was missing for longer than the other three: the queue only ever
 * emptied when the turn was completely over. A message typed twenty seconds into a four
 * minute task was not read for four minutes, and by then it was a comment on finished
 * work rather than a correction to work in progress. Waiting is the wrong default for
 * the only kind of message anyone types while watching an agent run.
 *
 * So `takeSteerable` hands what it can to the turn that is ALREADY RUNNING, at its next
 * step boundary, and `drain` keeps the turn-boundary behaviour for what cannot be handed
 * over — commands, and anything typed in the gap before the turn ended. The rules for
 * which is which are on each function.
 */

import { isUserCommandText } from "../memory/localCommand.js";

/** Rows of queue the footer will show before collapsing the rest into a count. */
export const MAX_VISIBLE_QUEUED = 3;

/**
 * WHEN a queued message may be delivered. Not how important it is.
 *
 *  - `next`  — into the running turn, at its next step boundary. Ordinary prose typed
 *              while Mindweave works: it is about the work, so it goes to the work.
 *  - `now`   — as its own turn, as soon as the current one is dead. Set when the user
 *              has already pressed Esc: they stopped the turn, so nothing they type
 *              after that may be fed back into it.
 *  - `later` — as its own turn, once the current one ends by itself. Slash commands,
 *              which are things to DO and need the turn to be over before they can be
 *              done.
 *
 * There is deliberately no reordering between them. One person types at one keyboard,
 * in one order, and a queue that let a later message overtake an earlier one would run
 * them in an order nobody typed. Priority here answers "may this go into the running
 * turn", never "which of these goes first".
 */
export type Priority = "now" | "next" | "later";

/** A message waiting to be sent, and the earliest moment it may be. */
export interface Queued {
  text: string;
  priority: Priority;
}

/**
 * Whether this text runs as a command rather than being said to the model: a slash command, or a
 * shell command the person typed after `!`. Both are things to DO, so both wait for the turn to be
 * over and go on their own (see `takeSteerable` and `drain`).
 */
export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("/") || isUserCommandText(text);
}

/**
 * Queue a message, deciding when it may go.
 *
 * `interrupting` is true when the user has already pressed Esc and the turn is still
 * winding down. Without it the message would be steered into the turn they just
 * stopped — Esc, then a fast correction, and the correction lands in the dying turn as
 * if the stop had never happened. There is no mode field beyond this: a slash command
 * is recognised by its own syntax, the same way the send path recognises it, so the
 * queue cannot disagree with the thing that eventually runs it.
 */
/**
 * What ctrl+F does with the turn, given what it is doing (pure).
 *
 *  - "send"     nothing is running: it is Enter.
 *  - "ends"     a command was moved to the background, or could not be: the step ends of its own accord and the message arrives.
 *  - "wait"     sub-agents are at work: they are not cut (they cost a great deal and nobody asked to stop them); the message arrives when
 *               they are back, and the screen says so.
 *  - "cut"      the model is writing and nothing else would end the step soon: that request is stopped, the work so far is kept, and
 *               the message goes out at once as the next turn.
 */
export type ForceSendPlan = "send" | "ends" | "wait" | "cut";
export function forceSendPlan(s: { busy: boolean; movedCommand: "moved" | "none" | "stuck"; workersAtWork: boolean; userCommandRunning: boolean }): ForceSendPlan {
  if (!s.busy) return "send";
  if (s.movedCommand !== "none") return "ends";
  if (s.workersAtWork) return "wait";
  // A person's own ! command is theirs to stop; cutting the turn would not end it.
  return s.userCommandRunning ? "ends" : "cut";
}

export function queueMessage(text: string, opts: { interrupting?: boolean } = {}): Queued {
  if (isCommand(text)) return { text, priority: "later" };
  return { text, priority: opts.interrupting ? "now" : "next" };
}

/**
 * What may be delivered INTO a turn that is already running, and what stays queued.
 *
 * A message typed while Mindweave is working is almost always about the work in
 * progress. Held until the turn ends, it arrives after the thing it was about is
 * finished, which is the wrong moment for every message worth typing — a correction
 * lands too late to correct anything. So prose is handed to the running turn at its next
 * step boundary and the model changes course.
 *
 * Only `next` is eligible, and only the unbroken run of it at the FRONT.
 *
 * A slash command (`later`) is not something to say to the model, it is something to DO,
 * and doing it needs the turn to be over: `/model` mid-flight would change models
 * between two calls of one conversation.
 *
 * A message typed after Esc (`now`) is not eligible either, and that one is easy to get
 * wrong. The user stopped the turn; feeding them back into it would carry out their
 * correction inside the very turn they cancelled.
 *
 * Stopping at the FIRST ineligible entry is what keeps the order honest. Someone who
 * types a message, then `/model`, then another message meant the last one to come after
 * the switch; steering it would run the three in an order they were never typed in.
 */
export function takeSteerable(queue: readonly Queued[]): { send: Queued[]; rest: Queued[] } {
  let i = 0;
  while (i < queue.length && queue[i]!.priority === "next") i++;
  return { send: queue.slice(0, i), rest: queue.slice(i) };
}

/**
 * What to send next as its OWN turn, and what stays queued.
 *
 * The turn-boundary drain. What reaches it is what could not be steered: slash commands,
 * and anything typed in the gap between the last step boundary and the turn ending.
 *
 * Consecutive plain messages go out TOGETHER, as one turn. Someone who types three
 * sentences while waiting meant them as one thought, and answering the first without
 * having read the third is how you get an answer that is immediately obsolete. It is
 * also the cheaper read: one turn re-sends the conversation once instead of three
 * times.
 *
 * A slash command always goes alone. It is not something to say to the model, it is
 * something to DO — merging `/model` into the prose around it would send the literal
 * word to the model instead of switching anything.
 *
 * Messages batch only with others of the SAME priority, which in practice means only
 * `next` with `next`. A message typed after Esc is put to the model differently — it
 * says the user stopped the work to send it — and merging one into the prose around it
 * would apply that to text it was not true of.
 */
export function drain(
  queue: readonly Queued[],
): { send: string; priority: Priority; rest: Queued[] } | undefined {
  if (queue.length === 0) return undefined;
  const first = queue[0]!;
  if (first.priority !== "next") return { send: first.text, priority: first.priority, rest: queue.slice(1) };

  let i = 0;
  while (i < queue.length && queue[i]!.priority === "next") i++;
  // A blank line between them, not a bare newline: these were separate messages, and
  // run together they read as one rambling paragraph.
  return {
    send: queue.slice(0, i).map((q) => q.text).join("\n\n"),
    priority: "next",
    rest: queue.slice(i),
  };
}

export interface PopResult {
  /** The full text to put in the input box. */
  text: string;
  /** Where to leave the cursor in it. */
  cursor: number;
}

/**
 * Pull the whole queue back into the input for editing.
 *
 * ALL of it, not just the last one. Partial removal would need the user to hold a
 * selection in their head across a screen that is also printing tool output at them;
 * emptying it and letting them re-send what they still want is fewer moving parts and
 * cannot leave a message queued that they believe they cancelled.
 *
 * Anything already typed is kept and moved to the END, and that ordering is the whole
 * point: a half-written line is the newest thing the user was saying, so it belongs
 * after the older queued messages, not in front of them. The cursor lands where that
 * draft starts, which is where they were.
 */
export function popAll(
  queue: readonly Queued[],
  currentInput: string,
  currentCursor: number,
): PopResult | undefined {
  if (queue.length === 0) return undefined;
  const queuedText = queue.map((q) => q.text).join("\n");
  if (currentInput === "") return { text: queuedText, cursor: queuedText.length };
  return {
    text: `${queuedText}\n${currentInput}`,
    // +1 for the newline that joins the draft on.
    cursor: queuedText.length + 1 + currentCursor,
  };
}

/**
 * What the footer shows: the first few entries, and how many are hidden.
 *
 * Capped because the footer is not height-bounded and an over-tall frame corrupts the
 * screen rather than clipping. The count is not decoration — a user who queued six
 * messages needs to know six are coming, even when they can only see three.
 */
export function visibleQueue(queue: readonly Queued[]): { rows: Queued[]; hidden: number } {
  return {
    rows: queue.slice(0, MAX_VISIBLE_QUEUED),
    hidden: Math.max(0, queue.length - MAX_VISIBLE_QUEUED),
  };
}
