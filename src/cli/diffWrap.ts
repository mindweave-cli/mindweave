/**
 * diffWrap.ts — a long diff line carried onto more rows (pure).
 *
 * The first row keeps the line as it was, with its `+ ` or `- ` mark. A continuation has a blank
 * mark and two columns of indent, so it reads as the rest of the line above it and never as a
 * line of its own that was added or removed. Each row is a whole row of the band, so the tint
 * can be painted under all of them.
 */
const GUTTER = 2;
const INDENT = 2;

export function wrapDiffLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const room = Math.max(4, width - GUTTER - INDENT);
  const first = Math.max(4, width - GUTTER);
  const mark = line.slice(0, GUTTER);
  const body = line.slice(GUTTER);
  const rows = [mark + body.slice(0, first)];
  for (let at = first; at < body.length; at += room) {
    rows.push(" ".repeat(GUTTER + INDENT) + body.slice(at, at + room));
  }
  return rows;
}
