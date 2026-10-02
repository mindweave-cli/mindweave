/**
 * revealQueue.ts — the order and the moment each piece of a turn reaches the screen.
 *
 * A turn arrives as a stream of events (text, tool calls opening and closing, progress). This
 * decides, for whatever is waiting, what may be shown right away and what has to wait for the
 * beat (see revealPace.ts). It is pure: App's pump drives it and the tests replay it, so the
 * screen and the tests can never disagree about the rules.
 *
 * ## A tool is shown while it works
 *
 * A tool call reaches the screen as soon as its beat comes, with a pulsing dot and its verb in
 * the present tense ("Reading views.py"). When its result arrives the row resolves in place
 * ("Read views.py", the dot still). A call that has already finished by the time its beat comes
 * is shown finished, in one paint: pulsing a dot for a read that took two milliseconds would be
 * motion with nothing behind it.
 *
 * ## The beat comes after the result
 *
 * While a row on screen is still working, nothing new is revealed. The next block waits for that
 * row's result, then for the beat. So the rhythm reads: the agent does something, you see it
 * finish, a moment, the next thing. Calls the model fired together still appear one after
 * another, each waiting for the one before it to finish.
 *
 * A row's result and its progress are applied the moment they arrive, wherever they sit in the
 * queue: when calls run together their events interleave, and the result of the row on screen
 * can be queued behind the start of a call that is not shown yet.
 *
 * ## Reads fold into one row
 *
 * Consecutive reads (see isGroupable) share one row. The first opens it on the beat; every read
 * after it joins at once, and the row keeps working, pulsing, until every read in it is done.
 */
import type { Action } from "./transcript.js";

export interface Pacer {
  /** Everything not shown yet, in the order it happened. */
  queue: Action[];
  /** Tool calls on screen whose result has not come yet. */
  running: Set<string>;
  /** A read row is open, so the next read joins it instead of waiting for a beat. */
  groupOpen: boolean;
  /** A live row (a command) is not resolved before this time, so its running state can be seen
   *  even when the command ends in a blink. Call id -> epoch ms. */
  holdUntil: Map<string, number>;
}

export interface PaceFlags {
  /** Esc: show the rest now. */
  flushing: boolean;
  /** The stream is over: no further event will arrive. */
  streamDone: boolean;
  /** Text is waiting that will seal into a visible sentence before the next tool row. */
  narrationPending: boolean;
  /** The clock, for rows held to a minimum running time. Absent: nothing is held. */
  now?: number;
}

export function newPacer(queue: Action[] = []): Pacer {
  return { queue, running: new Set(), groupOpen: false, holdUntil: new Map() };
}

/** Whether an action is a new block, which reaches the screen only on the beat. */
export function isPaced(a: Action, groupOpen: boolean): boolean {
  if (a.type === "toolStart") return a.group ? !groupOpen : true;
  return (
    a.type !== "token" &&
    a.type !== "toolEnd" &&
    a.type !== "toolProgress" &&
    a.type !== "subToolStart" &&
    a.type !== "subToolEnd" &&
    a.type !== "subagentEnd"
  );
}

/** Remove and return this call's result from the queue, if it has arrived. */
function takeEnd(queue: Action[], toolId: string): Action | undefined {
  const i = queue.findIndex((x) => x.type === "toolEnd" && x.toolId === toolId);
  return i === -1 ? undefined : queue.splice(i, 1)[0];
}

/** A tool call going on screen: with its result in the same paint when that is already here,
 *  otherwise on its own, and remembered as running. */
function openCall(p: Pacer, start: Action & { type: "toolStart" }): Action[] {
  const end = takeEnd(p.queue, start.toolId);
  if (end) return [start, end];
  p.running.add(start.toolId);
  return [start];
}

/**
 * Take everything that may be shown right now, without waiting for a beat, in order: results and
 * progress of rows already on screen, then whatever sits at the front and is not a new block
 * (text accumulating silently, a read joining the open read row, a sub-agent's own steps).
 */
export function takeImmediate(p: Pacer, f: PaceFlags): Action[] {
  const out: Action[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    if (p.running.size > 0) {
      for (let i = 0; i < p.queue.length; ) {
        const x = p.queue[i]!;
        const held = x.type === "toolEnd" && !f.flushing && f.now !== undefined && (p.holdUntil.get(x.toolId) ?? 0) > f.now;
        if ((x.type === "toolEnd" || x.type === "toolProgress") && p.running.has(x.toolId) && !held) {
          p.queue.splice(i, 1);
          out.push(x);
          if (x.type === "toolEnd") {
            p.running.delete(x.toolId);
            p.holdUntil.delete(x.toolId);
          }
          changed = true;
        } else i++;
      }
    }
    while (p.queue.length > 0 && !isPaced(p.queue[0]!, p.groupOpen)) {
      const a = p.queue.shift()!;
      if (a.type === "toolStart") out.push(...openCall(p, a));
      else out.push(a);
      // A read row stays open while reads keep coming; anything else closes it, as the
      // transcript's own closeToolGroup does on the same actions.
      if (a.type === "toolStart" && a.group) p.groupOpen = true;
      else if (a.type !== "toolEnd" && a.type !== "toolProgress") p.groupOpen = false;
      changed = true;
    }
  }
  // Nothing more can arrive (or the user asked for everything now): a row still waiting for a
  // result that is not coming must not hold the rest of the turn back.
  if ((f.flushing || f.streamDone) && p.running.size > 0) p.running.clear();
  return out;
}

/**
 * What the pump does next: `wait` while a row on screen is still working (its result releases
 * it), `idle` when nothing is queued, `beat` when the next block is ready for its beat.
 */
export function nextMove(p: Pacer): "wait" | "idle" | "beat" {
  if (p.running.size > 0) return "wait";
  if (p.queue.length === 0) return "idle";
  return "beat";
}

/** The block that goes on screen when the beat comes. Measured then, not when the beat was
 *  scheduled: the queue keeps growing in between, and a result that arrived meanwhile belongs
 *  in the same paint as its call. */
export function takePaced(p: Pacer, f: PaceFlags): Action[] {
  const front = p.queue[0];
  if (!front) return [];
  // A sentence in front of a tool row gets its own beat, so the two never land in one paint.
  if (front.type === "toolStart" && f.narrationPending) {
    p.groupOpen = false;
    return [{ type: "sealNarration" }];
  }
  p.queue.shift();
  if (front.type === "toolStart") {
    p.groupOpen = !!front.group;
    return openCall(p, front);
  }
  p.groupOpen = false;
  return [front];
}

/** When the next held result may be shown: the earliest hold whose result is already waiting. */
export function nextHoldAt(p: Pacer): number | null {
  let at: number | null = null;
  for (const x of p.queue) {
    if (x.type !== "toolEnd") continue;
    const t = p.holdUntil.get(x.toolId);
    if (t !== undefined && (at === null || t < at)) at = t;
  }
  return at;
}
