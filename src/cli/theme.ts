/**
 * theme.ts — the terminal's colours, taken from the desktop app's palette.
 *
 * The CLI used the terminal's own named colours (cyan for "this one", green for a pass),
 * which every terminal theme draws differently and none of which belong to Mindweave. The
 * app has a palette of its own: near-black ground, jade for what is selected or in use,
 * a yellow-green for success, a soft red for failure, and a warm cream for code. Using the
 * same values here means the two front ends read as one product, and a colour means the
 * same thing in both.
 *
 * Exact hex values, so a truecolor terminal shows exactly these. One place, so a palette
 * change is one edit (mirror it in mwcode-desktop/styles.css, `:root`).
 */

/** Selected, in use, or under the cursor: the prompt marker, the chosen row of a list. The
 *  app's `--accent-hi`, the brighter jade, so it stays legible on a dark terminal. */
export const ACCENT = "#52BF92";

/** A finished result that succeeded (a passing test run, an exit code 0). App `--good`. */
export const GOOD = "#A3CF6E";

/** Failure or danger. App `--bad`. */
export const BAD = "#EC7C72";

/** Inline code and file names in the agent's prose. App `--syn-prop`. */
export const CODE = "#E3CFA8";

/** Links in the agent's prose. App `--accent`. */
export const LINK = "#3DA37A";

/**
 * Your own message: a grey band with white text, so it is findable in a long conversation
 * without competing with the agent's words. App `--glass-3` and `--text`.
 */
export const USER_BG = "#202523";
export const USER_FG = "#EEF2EF";

/** A warning or something waiting on you (low context, a background note). App `--warn`. */
export const WARN = "#EAB767";

/**
 * Code in fenced blocks, coloured with the app's syntax palette (`--syn-*` in styles.css), so a
 * code block reads the same in the terminal as in the app. highlight.js's own terminal theme
 * drew keywords in blue, which belongs to neither.
 */
export const SYNTAX = {
  keyword: "#F0A36B",
  string: "#A9CF8C",
  type: "#8FC0B8",
  number: "#E8C070",
  fn: "#F2CF7A",
  prop: "#E3CFA8",
  comment: "#87928D",
} as const;
