/**
 * bannerFit.ts — what the header row shows at a given width. Always exactly one row.
 *
 * The header was laid out as a row of text pieces with nothing deciding what happens when they do
 * not fit, so the layout engine wrapped each piece inside its own box: "Mindweave 1" broke into
 * "Mindwe" over "ve 1", the model name into "stub:" over "7b", and the header grew a second row
 * that the transcript then scrolled into. How long the header is depends on the model and the
 * mode, so the same window width was fine with one model and broken with another, which is why it
 * came and went.
 *
 * Instead, when space runs out the header gives things up in a fixed order, least useful first,
 * and never breaks a word:
 *   1. "LIGHTNING MODE ON" becomes "LIGHTNING"
 *   2. a long model name is shortened with "…"
 *   3. the busy animation goes
 *   4. the effort level goes
 *   5. the title goes
 *   6. whatever is left is cut at the edge
 */

export interface BannerParts {
  title: string;
  /** The mode's name, upper case ("LIGHTNING"). */
  mode: string;
  /** The model's label, or "" when there is none. */
  model: string;
  /** The effort level, upper case, or "". */
  effort: string;
  /** Width of the busy animation. */
  shuttle: number;
}

export interface BannerLayout {
  title: string;
  showShuttle: boolean;
  mode: string;
  model: string;
  effort: string;
  /** Spaces between the left side and the status. */
  gap: number;
}

const SEP = " | ";
/** The shortest a shortened model name is allowed to get before something else gives way. */
const MIN_MODEL = 10;

function rightOf(mode: string, model: string, effort: string): string {
  return [mode, model, effort].filter(Boolean).join(SEP);
}

function leftWidth(title: string, shuttle: boolean, shuttleCells: number): number {
  if (!title) return shuttle ? shuttleCells : 0;
  return title.length + (shuttle ? 1 + shuttleCells : 0);
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

/** The header for `width` columns of content (the row's inset already taken off). Pure. */
export function fitBanner(width: number, p: BannerParts): BannerLayout {
  const full = `${p.mode} MODE ON`;
  let title = p.title;
  let shuttle = true;
  let mode = full;
  let model = p.model;
  let effort = p.effort;
  const used = () => leftWidth(title, shuttle, p.shuttle) + 1 + rightOf(mode, model, effort).length;
  const done = (): BannerLayout => ({ title, showShuttle: shuttle, mode, model, effort, gap: Math.max(1, width - used() + 1) });

  if (used() <= width) return done();
  mode = p.mode;
  if (used() <= width) return done();
  if (model.length > MIN_MODEL) {
    const over = used() - width;
    model = clip(p.model, Math.max(MIN_MODEL, p.model.length - over));
    if (used() <= width) return done();
  }
  shuttle = false;
  if (used() <= width) return done();
  effort = "";
  if (used() <= width) return done();
  title = "";
  if (used() <= width) return done();
  // Only the status is left: cut it at the edge, keeping the mode first.
  const status = clip(rightOf(mode, model, effort), Math.max(0, width - 1));
  return { title: "", showShuttle: false, mode: status, model: "", effort: "", gap: 1 };
}
