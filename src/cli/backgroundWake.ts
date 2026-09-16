/**
 * backgroundWake.ts — when a finished background command may start a turn on its own.
 *
 * A background command that finishes while Mindweave is idle wakes the model so it can
 * report the result. That wake is a turn nobody asked for at that moment, so it has to
 * wait for the same things a message the user queued waits for: no turn already running,
 * and nothing open on screen that is waiting for the user.
 *
 * It used to wait only for the first. A command finishing while `/continue` or `/model`
 * was open started a turn underneath the picker, and picking a session from that picker
 * swaps the session a turn is still running on. So an open menu or screen holds the wake
 * back, and closing it lets the wake through: the caller re-checks whenever that changes.
 */
export interface WakeState {
  /** The session has finished loading. */
  ready: boolean;
  /** A turn is already running. */
  busy: boolean;
  /** No usable key yet, so no turn could run. */
  needsKey: boolean;
  /** A wake is already under way. */
  reacting: boolean;
  /** Any picker, dialog or full screen that is waiting for the user. */
  modalOpen: boolean;
  /** Background events worth interrupting for. */
  pending: number;
}

export function shouldReactToBackground(s: WakeState): boolean {
  return s.ready && !s.busy && !s.needsKey && !s.reacting && !s.modalOpen && s.pending > 0;
}
