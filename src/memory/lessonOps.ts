/**
 * lessonOps.ts — carrying out a change to the lessons: keep one, change one, delete one.
 *
 * Apart from the background call (lessonReflect.ts) because the `lesson` tool uses these too, and that
 * call reaches the tool registry, which lists the tool.
 */
import { deleteMemory, listMemories, saveMemory, slugify } from "./autoMemory.js";
import {
  isLessonKind,
  lessonId,
  lessonRefusal,
  MAX_LESSON_CHARS,
  MAX_LESSONS,
  rankLessons,
  retireLesson,
  ruleOverlap,
  writeLesson,
  type Lesson,
  type LessonKind,
  type LessonScope,
  type LessonSource,
  type LessonState,
} from "./lessons.js";

/** Deletions one look back may make. A bad answer should not be able to empty the store. */
const MAX_DELETES = 5;
/** Lessons one look back may write. */
const MAX_SAVES = 4;
/** Two rules this alike are one lesson said twice. */
const SAME_LESSON = 0.7;
/** Memories one look back may write, and how long one may be. A memory is a fact and its reason, not a report. */
const MAX_REMEMBERED = 2;
const MAX_MEMORY_CHARS = 1_200;
/** What a look back may file as a memory. How to work is a lesson, not a memory. */
const REMEMBERED_TYPES = ["project", "user", "reference"] as const;

export interface LessonSaveOp {
  id?: string;
  name?: string;
  kind: LessonKind;
  rule: string;
  why: string;
  from: LessonSource;
  commands: string[];
  files: string[];
  everywhere: boolean;
}
/** A fact to keep in the session-to-session memory: true about the work, not about how to behave. */
export interface MemoryOp {
  name: string;
  description: string;
  type: (typeof REMEMBERED_TYPES)[number];
  body: string;
  hook: string;
}
export interface LessonOps {
  save: LessonSaveOp[];
  delete: { id: string; reason: string }[];
  remember: MemoryOp[];
  forget: { name: string; reason: string }[];
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, 8) : [];
}

/** A model's answer as operations, or null when it is not an answer at all (pure). What cannot be used in it is dropped. */
export function parseLessonOps(reply: string): LessonOps | null {
  const from = reply.indexOf("{");
  const to = reply.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(from, to + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { save, delete: del, remember, forget } = raw as { save?: unknown; delete?: unknown; remember?: unknown; forget?: unknown };
  const ops: LessonOps = { save: [], delete: [], remember: [], forget: [] };
  for (const m of Array.isArray(remember) ? remember : []) {
    const o = m as Record<string, unknown>;
    if (typeof o?.name !== "string" || !o.name.trim() || typeof o.body !== "string" || !o.body.trim()) continue;
    const description = typeof o.description === "string" ? o.description.trim() : "";
    ops.remember.push({
      name: o.name.trim(),
      description,
      type: (REMEMBERED_TYPES as readonly unknown[]).includes(o.type) ? (o.type as MemoryOp["type"]) : "project",
      body: o.body.trim(),
      hook: typeof o.hook === "string" && o.hook.trim() ? o.hook.trim() : description || o.name.trim(),
    });
  }
  for (const f of Array.isArray(forget) ? forget : []) {
    const o = f as Record<string, unknown>;
    if (typeof o?.name === "string" && o.name.trim()) ops.forget.push({ name: o.name.trim(), reason: typeof o.reason === "string" ? o.reason : "" });
  }
  for (const s of Array.isArray(save) ? save : []) {
    const o = s as Record<string, unknown>;
    if (typeof o?.rule !== "string" || !o.rule.trim() || !isLessonKind(o.kind)) continue;
    ops.save.push({
      ...(typeof o.id === "string" && o.id.trim() ? { id: o.id.trim() } : {}),
      ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim() } : {}),
      kind: o.kind,
      rule: o.rule.trim(),
      why: typeof o.why === "string" ? o.why.trim() : "",
      from: o.from === "user" ? "user" : "work",
      commands: stringList(o.commands),
      files: stringList(o.files),
      everywhere: o.everywhere === true,
    });
  }
  for (const d of Array.isArray(del) ? del : []) {
    const o = d as Record<string, unknown>;
    if (typeof o?.id === "string" && o.id.trim()) ops.delete.push({ id: o.id.trim(), reason: typeof o.reason === "string" ? o.reason : "" });
  }
  return ops;
}

/**
 * Carry out one lesson's save: on the same id, or on a rule that is the same one said again; refused if
 * it may not be kept. Mutates `state.lessons` and writes the file. Returns what was written, or why not.
 */
export async function saveLessonOp(state: LessonState, op: LessonSaveOp): Promise<{ lesson?: Lesson; refused?: string }> {
  if (op.rule.length > MAX_LESSON_CHARS) return { refused: `the rule is over ${MAX_LESSON_CHARS} characters` };
  const reason = lessonRefusal(`${op.rule} ${op.why}`);
  if (reason) return { refused: reason };
  const now = Date.now();
  const scope: LessonScope = op.everywhere ? "user" : "project";
  const existing =
    (op.id ? state.lessons.find((l) => l.id === op.id) : undefined) ??
    state.lessons.find((l) => ruleOverlap(l.rule, op.rule) >= SAME_LESSON);
  const id = existing?.id ?? uniqueId(state, op.name ?? op.rule);
  const lesson: Lesson = {
    id,
    kind: op.kind,
    scope: existing && !op.everywhere ? existing.scope : scope,
    // What the person said stays theirs even when the agent rewords it.
    source: existing?.source === "user" ? "user" : op.from,
    rule: op.rule.replace(/\s+/g, " "),
    why: op.why.replace(/\s+/g, " ").slice(0, MAX_LESSON_CHARS),
    commands: op.commands,
    files: op.files,
    created: existing?.created ?? now,
    updated: now,
    applied: existing?.applied ?? 0,
    // A corrected lesson starts its record again: the old counts were about the old words.
    worked: existing && existing.rule === op.rule ? existing.worked : 0,
    failed: existing && existing.rule === op.rule ? existing.failed : 0,
    ...(existing?.lastApplied ? { lastApplied: existing.lastApplied } : {}),
  };
  if (existing && existing.scope !== lesson.scope) await retireLesson(state.cwd, existing, "moved to another scope");
  await writeLesson(state.cwd, lesson);
  state.lessons = [...state.lessons.filter((l) => l.id !== id), lesson];
  await enforceCap(state, lesson.scope);
  return { lesson };
}

function uniqueId(state: LessonState, name: string): string {
  const base = lessonId(name);
  let id = base;
  for (let n = 2; state.lessons.some((l) => l.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** Past the cap the weakest goes. What the person said is the last to go. */
async function enforceCap(state: LessonState, scope: LessonScope): Promise<void> {
  const inScope = state.lessons.filter((l) => l.scope === scope);
  if (inScope.length <= MAX_LESSONS) return;
  for (const l of rankLessons(inScope).slice(MAX_LESSONS)) {
    await retireLesson(state.cwd, l, "over the cap");
    state.lessons = state.lessons.filter((x) => x !== l);
  }
}

export async function deleteLessonOp(state: LessonState, id: string, reason: string): Promise<boolean> {
  const lesson = state.lessons.find((l) => l.id === id);
  if (!lesson) return false;
  await retireLesson(state.cwd, lesson, reason);
  state.lessons = state.lessons.filter((l) => l !== lesson);
  return true;
}

/** Carry out a model's answer. Deletes first, so a merge's new lesson does not collide with what it replaces. */
/**
 * Keep what a look back found to be true. Never over a memory of another kind: a name that happens to land on
 * the user's own note must not replace it. Only `project` memories can be forgotten this way, since they are
 * the ones that go out of date; who the user is and where things are kept are theirs to take back.
 */
export async function applyMemoryOps(cwd: string, ops: Pick<LessonOps, "remember" | "forget">): Promise<{ remembered: number; forgotten: number; refused: number }> {
  let remembered = 0;
  let forgotten = 0;
  let refused = 0;
  const known = await listMemories(cwd);
  for (const f of ops.forget.slice(0, MAX_DELETES)) {
    const slug = slugify(f.name);
    const m = known.find((x) => x.file === `${slug}.md` || x.name === f.name);
    if (m?.type === "project" && (await deleteMemory(cwd, m.file, f.reason))) forgotten++;
  }
  for (const m of ops.remember.slice(0, MAX_REMEMBERED)) {
    const there = known.find((x) => x.file === `${slugify(m.name)}.md`);
    if (m.body.length > MAX_MEMORY_CHARS || lessonRefusal(`${m.name} ${m.description} ${m.body}`) || (there && there.type !== m.type)) {
      refused++;
      continue;
    }
    await saveMemory(cwd, { name: m.name, description: m.description, type: m.type, body: m.body, indexLine: m.hook });
    remembered++;
  }
  return { remembered, forgotten, refused };
}

export async function applyLessonOps(state: LessonState, ops: Pick<LessonOps, "save" | "delete">, maxDeletes = MAX_DELETES): Promise<{ saved: number; deleted: number; refused: number }> {
  let deleted = 0;
  let saved = 0;
  let refused = 0;
  for (const d of ops.delete.slice(0, maxDeletes)) if (await deleteLessonOp(state, d.id, d.reason)) deleted++;
  for (const s of ops.save.slice(0, MAX_SAVES)) {
    const done = await saveLessonOp(state, s);
    if (done.lesson) saved++;
    else refused++;
  }
  return { saved, deleted, refused };
}
