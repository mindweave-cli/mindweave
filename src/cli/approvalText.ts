/**
 * approvalText.ts — what the conversation keeps of a question the agent asked you (pure).
 *
 * The question itself is a box at the bottom of the screen, and it is gone once it is answered. What stays in
 * the conversation is a block, and it has to stand on its own: the question, what it is about, and how it
 * was answered. It used to hold the command alone, under "Permission Request", with nothing to say why it had
 * been asked or what the answer was.
 */

/** The block printed when a question comes with something to read (a command, a plan): question first, then it. */
export function approvalBlock(question: string, detail: string): string {
  const q = question.trim();
  const d = detail.trim();
  return q === "" ? d : `${q}\n${d}`;
}

/** The dim line printed after it is answered: allowed, declined, or the answer as given (pure). */
export function approvalAnswer(choice: string | undefined): string | null {
  const said = String(choice ?? "").trim();
  if (said === "") return null;
  const kind = /^yes\b/i.test(said) ? "allowed" : /^no\b/i.test(said) ? "declined" : "answered";
  return `  ${kind}: ${said.length > 90 ? `${said.slice(0, 89)}…` : said}`;
}

/**
 * The seconds the working line shows: time since the turn began, less the time spent waiting for an answer
 * (pure). Waiting for the person is not the agent working, and a line that kept counting through six minutes
 * of an unanswered question read as a turn that had been busy for six minutes.
 */
export function workedSeconds(now: number, startedAt: number, waitedMs: number): number {
  return Math.max(0, Math.floor((now - startedAt - waitedMs) / 1000));
}
