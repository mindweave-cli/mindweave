/**
 * lessons.ts — what the agent has learned about working in this project, and with this person.
 *
 * A lesson is a sentence or two the agent keeps for itself: how things run here, how the user
 * wants work done, what they mean by a word. It is written and deleted by the agent, in the
 * background, and nothing about it is shown. It sits below the things a person wrote: the
 * standing rules and MINDWEAVE.md win any conflict, and a lesson can never loosen a permission.
 *
 * Layout, one file per lesson, so two instances writing at once cannot lose each other's work and
 * there is no index to fall out of step (what the agent is shown is rendered from the files):
 *   ~/.mindweave/projects/<slug>/lessons/<id>.md   this project
 *   ~/.mindweave/lessons/<id>.md                   everything this person works on
 *
 * This file is the store and the pure rules over it. `lessonSignals.ts` decides when something is
 * worth a look, and `lessonReflect.ts` makes the background call.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { globMatch } from "../governor/glob.js";
import { projectDir, stateRoot } from "./store.js";
import { slugify } from "./autoMemory.js";
import type { Entry } from "./types.js";

export const LESSON_KINDS = ["environment", "workflow", "approach", "understanding"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];
export type LessonScope = "project" | "user";
/** Where a lesson came from: the person said it, or the agent worked it out from the work. */
export type LessonSource = "user" | "work";

export interface Lesson {
  id: string;
  kind: LessonKind;
  scope: LessonScope;
  source: LessonSource;
  rule: string;
  why: string;
  /** The commands it is about, as their leading words ("git commit"). */
  commands: string[];
  /** The files it is about, as globs from the project root ("CHANGELOG.md"). */
  files: string[];
  created: number;
  updated: number;
  /** Times it was put in front of the agent at the moment of an action. */
  applied: number;
  /** Of those, how the action then went. */
  worked: number;
  failed: number;
  lastApplied?: number;
}

/** How long a rule and its reason may be: a lesson is a sentence or two, and every one is read back. */
export const MAX_LESSON_CHARS = 300;
/** Lessons kept per scope. Past it the weakest is dropped, so the store cannot grow without bound. */
export const MAX_LESSONS = 60;
/** The always-on block, in characters. What does not fit still comes up at the action it is about. */
export const LESSON_BLOCK_CHARS = 4_000;
/** The note of what changed since that block was frozen. Re-sent on every step, so kept small. */
const LESSON_TAIL_CHARS = 1_500;
/** Old enough that acting on it without checking is a real risk. */
const STALE_AFTER_MS = 60 * 86_400_000;
/** Retired lessons kept on disk for the record. They are never read back to the agent. */
const RETIRED_LOG = ".retired.jsonl";
const RETIRED_KEEP = 200;

/** Whether lessons run at all. On, unless switched off. */
export function lessonsEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.MINDWEAVE_LESSONS ?? "");
}

export function isLessonKind(v: unknown): v is LessonKind {
  return typeof v === "string" && (LESSON_KINDS as readonly string[]).includes(v);
}

export function lessonsDir(cwd: string, scope: LessonScope): string {
  return scope === "user" ? join(stateRoot(), "lessons") : join(projectDir(cwd), "lessons");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A lesson's file: flat frontmatter, then the words. Written to be read by a person too (pure). */
export function renderLessonFile(l: Lesson): string {
  const head = [
    "---",
    `id: ${l.id}`,
    `kind: ${l.kind}`,
    `source: ${l.source}`,
    ...(l.commands.length > 0 ? [`commands: ${l.commands.map(oneLine).join(" | ")}`] : []),
    ...(l.files.length > 0 ? [`files: ${l.files.map(oneLine).join(" | ")}`] : []),
    `created: ${new Date(l.created).toISOString()}`,
    `updated: ${new Date(l.updated).toISOString()}`,
    `applied: ${l.applied}`,
    `worked: ${l.worked}`,
    `failed: ${l.failed}`,
    ...(l.lastApplied ? [`lastApplied: ${new Date(l.lastApplied).toISOString()}`] : []),
    "---",
    "",
    oneLine(l.rule),
  ];
  return [...head, ...(l.why ? ["", `Why: ${oneLine(l.why)}`] : []), ""].join("\n");
}

/** A lesson back from its file, or null for one that cannot stand as a lesson (pure). */
export function parseLessonFile(raw: string, scope: LessonScope): Lesson | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const meta = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const body = match[2]!.trim();
  const whyAt = body.search(/^Why:/m);
  const rule = oneLine(whyAt >= 0 ? body.slice(0, whyAt) : body);
  const why = whyAt >= 0 ? oneLine(body.slice(whyAt + 4)) : "";
  const id = meta.get("id") ?? "";
  const kind = meta.get("kind");
  if (!id || !rule || !isLessonKind(kind)) return null;
  const list = (key: string) => (meta.get(key) ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const time = (key: string) => {
    const t = Date.parse(meta.get(key) ?? "");
    return Number.isFinite(t) ? t : 0;
  };
  const count = (key: string) => {
    const n = Number(meta.get(key));
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const lastApplied = time("lastApplied");
  return {
    id,
    kind,
    scope,
    source: meta.get("source") === "user" ? "user" : "work",
    rule,
    why,
    commands: list("commands"),
    files: list("files"),
    created: time("created"),
    updated: time("updated"),
    applied: count("applied"),
    worked: count("worked"),
    failed: count("failed"),
    ...(lastApplied ? { lastApplied } : {}),
  };
}

async function loadScope(cwd: string, scope: LessonScope): Promise<Lesson[]> {
  const dir = lessonsDir(cwd, scope);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const read = await Promise.all(
    names
      .filter((n) => n.endsWith(".md") && !n.startsWith("."))
      .map(async (n) => {
        try {
          return parseLessonFile(await fs.readFile(join(dir, n), "utf8"), scope);
        } catch {
          return null;
        }
      }),
  );
  return read.filter((l): l is Lesson => l !== null);
}

/** Everything saved for this project and this person. A project's lesson hides a personal one of the same id. */
export async function loadLessons(cwd: string): Promise<Lesson[]> {
  const [mine, here] = await Promise.all([loadScope(cwd, "user"), loadScope(cwd, "project")]);
  const seen = new Set(here.map((l) => l.id));
  return [...here, ...mine.filter((l) => !seen.has(l.id))];
}

export async function writeLesson(cwd: string, lesson: Lesson): Promise<void> {
  const dir = lessonsDir(cwd, lesson.scope);
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, `${lesson.id}.md`), renderLessonFile(lesson));
}

/** Delete a lesson's file, keeping a line of it in the retired log. */
export async function retireLesson(cwd: string, lesson: Lesson, reason: string): Promise<void> {
  const dir = lessonsDir(cwd, lesson.scope);
  try {
    await fs.rm(join(dir, `${lesson.id}.md`), { force: true });
    const log = join(dir, RETIRED_LOG);
    let kept: string[] = [];
    try {
      kept = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean);
    } catch {
      // no log yet
    }
    kept.push(JSON.stringify({ at: new Date().toISOString(), id: lesson.id, rule: lesson.rule, why: lesson.why, reason: oneLine(reason) }));
    await writeFileAtomic(log, `${kept.slice(-RETIRED_KEEP).join("\n")}\n`);
  } catch {
    // Best-effort: the next pass sees the lesson is still there and can decide again.
  }
}

/**
 * Why a lesson may not be kept, or null when it may (pure).
 *
 * A lesson is read back to the agent in every later session, so one written from a bad moment, or
 * talked into existence by text the agent read, is a standing instruction nobody asked for. So it
 * can tighten how the agent works and never loosen what protects the person: anything that reads
 * as getting past an approval, a guard or a check is refused, while "never skip the hooks" is fine.
 */
export function lessonRefusal(text: string): string | null {
  const t = oneLine(text);
  if (/-----BEGIN|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{12,}|\b(api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S{6,}/i.test(t)) {
    return "it holds a secret";
  }
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(ba|z|da)?sh\b|\|\s*iex\b/i.test(t)) return "it pipes a download into a shell";
  if (/\b(user|owner|person|they|he|she)\s+(has\s+|have\s+|had\s+)?(already\s+)?(approved|authori[sz]ed|permitted|allowed|agreed)\b/i.test(t)) {
    return "it claims a permission";
  }
  const loosen =
    /\b(skip|skipping|bypass|bypassing|disable|disabling|turn(ing)? off|ignore|ignoring|get(ting)? (around|past)|work(ing)? around|without|no need for|do not need|don'?t need|remove|removing)\b[^.]{0,40}\b(approval|approvals|permission|permissions|confirm\w*|sentinel|guard|guards|forbidden|protected|hooks?|verif\w*|sandbox|safety|review|checks?)\b|--no-verify|--dangerously\w*|--force\b/gi;
  for (const m of t.matchAll(loosen)) {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    if (!/\b(never|not|don'?t|avoid|must not|should not|stop|refuse)\b[^,;.]*$/i.test(before)) return "it loosens a safeguard";
  }
  return null;
}

/** How a lesson has fared, for keeping the strong ones and doubting the weak ones (pure). */
export function lessonDoubtful(l: Pick<Lesson, "worked" | "failed">): boolean {
  return l.failed >= 2 && l.failed > l.worked;
}

function lessonScore(l: Lesson, now: number): number {
  const lastUsed = l.lastApplied ?? l.updated;
  const recent = Math.max(0, 1 - (now - lastUsed) / STALE_AFTER_MS);
  return (l.source === "user" ? 100 : 0) + (l.worked - l.failed) * 5 + recent * 10;
}

/** Strongest first, with the id as the tie-break so the same store always renders the same bytes (pure). */
export function rankLessons(lessons: readonly Lesson[], now = Date.now()): Lesson[] {
  return [...lessons].sort((a, b) => lessonScore(b, now) - lessonScore(a, now) || (a.id < b.id ? -1 : 1));
}

function lessonLine(l: Lesson, now: number): string {
  const age = now - l.updated >= STALE_AFTER_MS ? " (months old: check it still holds)" : "";
  return `- [${l.id}] ${oneLine(l.rule)}${l.why ? ` Why: ${oneLine(l.why)}` : ""}${age}`;
}

/**
 * The lessons as the block in the system prompt (pure).
 *
 * That is the cached part of every request, so this is made once and kept until the prompt is being
 * rewritten anyway (a new session, a compaction). Scores decay, so the order is taken when it is
 * rendered and not again. Doubtful lessons are left out while they wait to be corrected or deleted.
 */
export function renderLessonsBlock(lessons: readonly Lesson[], now = Date.now()): string {
  const lines: string[] = [];
  let size = 0;
  for (const l of rankLessons(lessons.filter((x) => !lessonDoubtful(x)), now)) {
    const line = lessonLine(l, now);
    if (size + line.length + 1 > LESSON_BLOCK_CHARS) continue;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** The ids and text a frozen block carries, to tell later what changed since. */
export type LessonSnapshot = Map<string, string>;

export function snapshotOf(lessons: readonly Lesson[]): LessonSnapshot {
  return new Map(lessons.map((l) => [l.id, l.rule]));
}

/**
 * What changed since the block was frozen, for the part of the request that is sent fresh (pure).
 * Learned this session, it counts now; the cached block catches up at the next compaction or session.
 */
export function renderLessonChanges(lessons: readonly Lesson[], frozen: LessonSnapshot, now = Date.now()): string {
  const added = lessons.filter((l) => frozen.get(l.id) !== l.rule && !lessonDoubtful(l)).map((l) => lessonLine(l, now));
  const live = new Set(lessons.filter((l) => !lessonDoubtful(l)).map((l) => l.id));
  const gone = [...frozen.keys()].filter((id) => !live.has(id));
  if (added.length === 0 && gone.length === 0) return "";
  const parts: string[] = [];
  if (added.length > 0) {
    let size = 0;
    const kept = added.filter((line) => (size += line.length + 1) <= LESSON_TAIL_CHARS);
    parts.push(`Lessons learned since this session began:\n${kept.join("\n")}`);
  }
  if (gone.length > 0) parts.push(`Lessons withdrawn since this session began, no longer to be followed: ${gone.join(", ")}.`);
  return parts.join("\n");
}

/** The words of a shell command's parts, without quotes or leading VAR=value (pure). */
function commandParts(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/^["']|["']$/g, "").toLowerCase())
        .filter(Boolean),
    )
    .map((words) => {
      let i = 0;
      while (i < words.length && /^[a-z_][a-z0-9_]*=/.test(words[i]!)) i++;
      return words.slice(i);
    })
    .filter((words) => words.length > 0);
}

/**
 * Whether a command runs what a lesson is about (pure). The first word must be the program, and the
 * rest must follow in order, so "git commit" finds `git -C sub commit -m x` and never `echo git commit`.
 */
export function commandMatches(command: string, pattern: string): boolean {
  const want = pattern.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (want.length === 0) return false;
  return commandParts(command).some((words) => {
    const program = words[0]!.replace(/\\/g, "/").split("/").pop()!.replace(/\.(exe|cmd|bat|ps1)$/, "");
    if (program !== want[0]) return false;
    let at = 1;
    for (let i = 1; i < words.length && at < want.length; i++) if (words[i] === want[at]) at++;
    return at === want.length;
  });
}

const EDITING_TOOLS = new Set(["edit", "write_file", "replace_symbol_body"]);

/** The path a call changes, from the project root with forward slashes, or null (pure). */
export function editedPath(name: string, args: Record<string, unknown>, root: string): string | null {
  if (!EDITING_TOOLS.has(name)) return null;
  const raw = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
  if (!raw) return null;
  const path = raw.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const inRoot = path.toLowerCase().startsWith(`${base.toLowerCase()}/`);
  return (inRoot ? path.slice(base.length + 1) : path).replace(/^\.\//, "");
}

/** The lessons a call is about (pure). */
export function lessonsForCall(lessons: readonly Lesson[], name: string, args: Record<string, unknown>, root: string): Lesson[] {
  const command = name === "run_command" && typeof args.command === "string" ? args.command : null;
  const path = editedPath(name, args, root);
  if (command === null && path === null) return [];
  return lessons.filter((l) => {
    if (lessonDoubtful(l)) return false;
    if (command !== null) return l.commands.some((p) => commandMatches(command, p));
    return l.files.some((g) => globMatch(path!, g) || globMatch(path!.split("/").pop()!, g));
  });
}

/** What a call that was held back is told (pure). */
export function renderLessonHold(lessons: readonly Lesson[]): string {
  return (
    "Not run yet. What you learned earlier about this:\n" +
    lessons.map((l) => `- ${oneLine(l.rule)}${l.why ? ` Why: ${oneLine(l.why)}` : ""}`).join("\n") +
    "\nIf the call already fits, make the same call again; if not, change it. If the user's request now says otherwise, " +
    "follow the user and correct or delete the lesson. This is your own note, so do not mention it."
  );
}

/** The share of words two rules have in common, for finding the same lesson said twice (pure). */
export function ruleOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** A rule's id: from the name given, or from its first words (pure). */
export function lessonId(name: string): string {
  return slugify(name).slice(0, 50).replace(/-+$/, "") || "lesson";
}

/** The live lessons of a session, and what is known about them while it runs. See `openLessons`. */
export interface LessonState {
  cwd: string;
  lessons: Lesson[];
  /** The block in the cached system prompt, and what it held when made. */
  block: string;
  frozen: LessonSnapshot;
  /** Lessons already put in front of the agent at an action. Each comes up once until the next compaction. */
  held: Set<string>;
  /** Of those, the ones whose next matching call has not been seen, so its outcome can be counted. */
  awaiting: Set<string>;
  /** Failed attempts per goal, and the attempts that got past them. See lessonSignals.ts. */
  attempts: Map<string, { call: string; error: string }[]>;
  struggles: { goal: string; failed: { call: string; error: string }[]; worked: string }[];
  /** The last entry the reflection has read. */
  cursor: Entry | null;
  /** Turns ended with tool work since the last reflection. */
  turnsSince: number;
  /** The agent itself saved or deleted one since the last reflection, so that stretch is already dealt with. */
  wrote: boolean;
  /** The note for this turn when it is going badly. */
  nudge: string;
  /** Failed calls of the reflection this session, to stop trying a model that cannot do it. */
  failures: number;
  run?: Promise<void>;
}

/** The session's lessons at open. Null when switched off, and nothing else in the engine runs then. */
export async function openLessons(cwd: string, transcript: readonly Entry[], read?: number): Promise<LessonState | null> {
  if (!lessonsEnabled()) return null;
  const lessons = await loadLessons(cwd).catch(() => [] as Lesson[]);
  return {
    cwd,
    lessons,
    block: renderLessonsBlock(lessons),
    frozen: snapshotOf(lessons),
    held: new Set(),
    awaiting: new Set(),
    attempts: new Map(),
    struggles: [],
    // How far it was read when the session was last saved: closing it right after a correction must not lose
    // the correction. A session from before this was kept is taken as read.
    cursor: (read !== undefined && read <= transcript.length ? transcript[read - 1] : transcript[transcript.length - 1]) ?? null,
    turnsSince: 0,
    wrote: false,
    nudge: "",
    failures: 0,
  };
}

/**
 * The prompt is being rewritten anyway (a compaction): bring the block up to date, and let a lesson come
 * up at its action again, since what was said about it may have been cut away.
 */
export function refreshLessonBlock(state: LessonState): void {
  state.block = renderLessonsBlock(state.lessons);
  state.frozen = snapshotOf(state.lessons);
  state.held.clear();
  state.awaiting.clear();
}

/**
 * The call to hold back so the agent reads what it learned first, or null to let it run. Once per
 * lesson: being told again adds nothing, and a call made again after being told must go through.
 */
export function lessonHold(state: LessonState, name: string, args: Record<string, unknown>): string | null {
  const due = lessonsForCall(state.lessons, name, args, state.cwd).filter((l) => !state.held.has(l.id)).slice(0, 3);
  if (due.length === 0) return null;
  const now = Date.now();
  for (const l of due) {
    state.held.add(l.id);
    state.awaiting.add(l.id);
    l.applied++;
    l.lastApplied = now;
  }
  return renderLessonHold(due);
}

/** Count how the call after a hold went. Returns the lessons whose counts changed, for saving. */
export function noteLessonOutcome(state: LessonState, name: string, args: Record<string, unknown>, isError: boolean): Lesson[] {
  if (state.awaiting.size === 0) return [];
  const settled = lessonsForCall(state.lessons, name, args, state.cwd).filter((l) => state.awaiting.has(l.id));
  for (const l of settled) {
    state.awaiting.delete(l.id);
    if (isError) l.failed++;
    else l.worked++;
  }
  return settled;
}
