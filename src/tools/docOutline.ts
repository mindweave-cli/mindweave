/**
 * docOutline.ts — the outline of a file that is not code: markdown headings, and the keys of JSON, YAML, TOML and
 * ini files, with line numbers.
 *
 * `outline` knew code, HTML and stylesheets. For everything else the only way to orient in a file was to read it,
 * which is the expensive habit the tool exists to prevent. This is read straight from the text on demand rather
 * than put in the code graph: a heading or a key such as `name` is not a symbol, and indexing them would make
 * every definition lookup for a common word answer with every package.json in the repo.
 *
 * Pure text in, lines out. A file it cannot read the shape of gives null, and the caller says nothing about it.
 */
import { extname } from "node:path";

/** Largest file read to outline. Past it a file's shape is not something to list line by line. */
export const DOC_MAX_BYTES = 512 * 1024;
/** Entries shown for one file. */
export const DOC_MAX_ENTRIES = 80;

const KINDS: Record<string, "markdown" | "json" | "yaml" | "toml" | "csv"> = {
  ".md": "markdown", ".markdown": "markdown", ".mdx": "markdown",
  ".json": "json", ".jsonc": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".ini": "toml", ".cfg": "toml",
  ".csv": "csv", ".tsv": "csv",
};

/** Lock files and generated manifests: huge, and a list of their keys says nothing. */
const SKIP_NAME = /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock)$/i;

/** Whether this path is a file the outline can read the shape of. */
export function isDocFile(path: string): boolean {
  return extname(path).toLowerCase() in KINDS && !SKIP_NAME.test(path);
}

const row = (line: number, indent: number, text: string) => `  ${String(line).padStart(4)}  ${"  ".repeat(indent)}${text}`;
const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The outline of `text` as printable lines, or null when the file type is not one it reads. */
export function docOutline(path: string, text: string, limit = DOC_MAX_ENTRIES): string[] | null {
  const kind = KINDS[extname(path).toLowerCase()];
  if (!kind || SKIP_NAME.test(path)) return null;
  const lines =
    kind === "markdown" ? markdown(text)
    : kind === "json" ? json(text)
    : kind === "yaml" ? yaml(text)
    : kind === "toml" ? toml(text)
    : csv(text);
  if (lines.length === 0) return null;
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `  … ${lines.length - limit} more entries`];
}

function markdown(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) out.push(row(i + 1, h[1]!.length - 1, `${h[1]} ${clip(h[2]!, 80)}`));
  });
  return out;
}

interface Frame { type: "{" | "["; items: number; seen: boolean; rec: { text: string; line: number; indent: number; name: string } | null }

/** Keys down to the second level of a JSON document, each with what its value is. Reads JSON with comments too. */
function json(text: string): string[] {
  const recs: { text: string; line: number; indent: number; name: string }[] = [];
  const stack: Frame[] = [];
  let line = 1;
  let pendingKey: { line: number; name: string } | null = null;
  let lastRec: { text: string; line: number; indent: number; name: string } | null = null;
  const n = text.length;
  const top = () => stack[stack.length - 1];
  const countValue = () => {
    const t = top();
    if (t && !t.seen) { t.seen = true; t.items = 1; }
  };
  // Only keys of objects nested in objects are listed: an array of records would repeat its keys once per element.
  const listed = () => stack.length >= 1 && stack.length <= 2 && stack.every((f) => f.type === "{");

  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    if (c === "\n") { line++; continue; }
    if (c === " " || c === "\t" || c === "\r") continue;
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; i--; continue; }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") line++; i++; }
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === "\\") i++; if (text[i] === "\n") line++; i++; }
      const lit = text.slice(start + 1, i);
      let j = i + 1;
      while (j < n && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j++;
      const t = top();
      if (text[j] === ":" && t?.type === "{") {
        pendingKey = { line, name: lit };
        if (!t.seen) { t.seen = true; t.items = 1; }
        if (listed()) {
          const rec = { text: "", line, indent: stack.length - 1, name: lit };
          recs.push(rec);
          lastRec = rec;
        } else lastRec = null;
        i = j; // past the colon
        // a scalar value: preview it
        let k = i + 1;
        while (k < n && (text[k] === " " || text[k] === "\t")) k++;
        if (lastRec && text[k] !== "{" && text[k] !== "[") {
          let e = k;
          if (text[k] === '"') { e = k + 1; while (e < n && text[e] !== '"') { if (text[e] === "\\") e++; e++; } e++; }
          else while (e < n && !",}\n\r".includes(text[e]!)) e++;
          lastRec.text = `${lit}: ${clip(text.slice(k, e).trim())}`;
        }
      } else countValue();
      continue;
    }
    if (c === "{" || c === "[") {
      const rec = pendingKey && listed() ? lastRec : null;
      pendingKey = null;
      countValue();
      stack.push({ type: c, items: 0, seen: false, rec });
      continue;
    }
    if (c === "}" || c === "]") {
      const f = stack.pop();
      if (f?.rec) f.rec.text = `${f.rec.name}: ${c === "}" ? `{${f.items} key${f.items === 1 ? "" : "s"}}` : `[${f.items} item${f.items === 1 ? "" : "s"}]`}`;
      continue;
    }
    if (c === ",") { const t = top(); if (t) t.items++; pendingKey = null; continue; }
    // a bare scalar (number, true, false, null)
    countValue();
    while (i + 1 < n && !",}] \t\r\n".includes(text[i + 1]!)) i++;
  }
  return recs.filter((r) => r.text).map((r) => row(r.line, r.indent, r.text));
}

/** Top-level keys and their direct children in a YAML file, with a preview of a plain value. */
function yaml(text: string): string[] {
  const out: string[] = [];
  let block = -1; // indent of a block scalar's key: its lines are text, not keys
  let child = -1; // indent of the keys one level below the current top-level key
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || /^\s*#/.test(raw) || /^---|^\.\.\./.test(raw)) return;
    const indent = raw.length - raw.trimStart().length;
    if (block >= 0) { if (indent > block) return; block = -1; }
    const m = /^(\s*)(?:-\s+)?("[^"]+"|'[^']+'|[^\s:#][^:#]*?):(?:\s+(.*))?$/.exec(raw);
    if (!m) return;
    // The second level is whatever indent the first nested key under a top-level key uses; anything deeper is left out.
    if (indent === 0) child = -1;
    else if (child < 0) child = indent;
    const depth = indent === 0 ? 0 : indent === child ? 1 : 2;
    if (depth > 1) return;
    const value = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
    if (/^[|>][+-]?\d*$/.test(value)) block = indent;
    const shown = value && !/^[|>]/.test(value) ? `: ${clip(value)}` : ":";
    out.push(row(i + 1, depth, `${m[2]!.replace(/^["']|["']$/g, "")}${shown}`));
  });
  return out;
}

/** Tables (`[a.b]`, `[[c]]`) and the keys before the first one, for TOML and ini files. */
function toml(text: string): string[] {
  const out: string[] = [];
  let inTable = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(raw);
    if (t) { inTable = true; out.push(row(i + 1, 0, t[1]!)); return; }
    if (inTable || /^\s*[#;]/.test(raw)) return;
    const k = /^\s*([A-Za-z0-9_.\-"']+)\s*[=:]\s*(.*)$/.exec(raw);
    if (k) out.push(row(i + 1, 0, `${k[1]}: ${clip(k[2]!.trim())}`));
  });
  return out;
}

/** A table's header row and how many rows follow. */
function csv(text: string): string[] {
  const rows = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (rows.length === 0) return [];
  return [row(1, 0, `columns: ${clip(rows[0]!, 120)}`), row(1, 0, `${rows.length - 1} row${rows.length === 2 ? "" : "s"}`)];
}
