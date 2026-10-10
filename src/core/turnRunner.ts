/**
 * turnRunner.ts — drives one Mindweave turn for a caller that is not a terminal.
 *
 * `respond()` in dynamo/engine.ts already speaks nothing but plain JSON: a Session in,
 * a stream of EngineEvents out, no filesystem or terminal coupling of its own (see
 * dynamo/README.md). What the CLI adds on top is the reveal pacer that times each event
 * onto the alt-screen — real UI concerns, of no use to a caller that draws its own
 * chat. This module is the other front door: it maps the same events into a plain
 * TurnEvent stream (the tool display names and colours come from cli/toolDisplay.ts,
 * so a tool call reads the same way in every surface) with no Ink, no pacing, no
 * terminal assumptions. A GUI or a server can drive a session with just this file.
 */
import { compactNow, respond, type EngineEvent, type SteeredMessage } from "../dynamo/engine.js";
import {
  startMarathon,
  resumeMarathon,
  clearMarathon,
  describeMarathonEvent,
  verifyGoal,
  type MarathonDeps,
  type MarathonEvent,
  type MarathonOptions,
  type MarathonState,
} from "../dynamo/marathon.js";
export { clearMarathon, describeMarathonEvent, MAX_MARATHON_VERIFY_FAILS, type MarathonEvent, type MarathonState, type MarathonStatus } from "../dynamo/marathon.js";
/** How full the context is against the auto-compaction bar, for a context meter. */
export { contextFill } from "../dynamo/engine.js";
import { createSession, resumeSession, reloadProjectMemory } from "../memory/session.js";
import { saveSession, listSessions as listSessionsRaw } from "../memory/store.js";
import type { Session, SessionMeta, ToolCallRecord } from "../memory/types.js";
import { toolDisplay, isGroupable, narrationShown, noteReads } from "../cli/toolDisplay.js";
import { accessRefusal, providerOutage, statusOf } from "../drivers/providerError.js";
import { failoverKey, noteKeyWorked } from "./providerKeys.js";
import { providerOf, modelLabel, refreshModels, DISCOVERY_TTL_MS, withModel, saveModelConfig, thinkLevels, thinkLabel } from "../dynamo/model.js";
import type { ThinkLevel, Effort } from "../drivers/types.js";
import { allProviders, modelsOf } from "../drivers/registry.js";
import { errText } from "../tools/editTarget.js";
import { loadConfig, hasApiKey, saveApiKey, removeApiKey, saveSetting } from "../cli/bootstrap.js";
import { parseAddress } from "../drivers/ollama/endpoint.js";
import { describeImage, isRejection, type ImageRef } from "../memory/images.js";
import { resolveAttachments, stripAttachments, attachedFiles, hideAttachedNames } from "../cli/attachments.js";
export { attachedFiles, hideAttachedNames } from "../cli/attachments.js";
import { isRewindPoint } from "../memory/rewind.js";
export { rewindPoints, rewindTo, pasteSlot, type RewindPoint, type RewindResult, type EditableMessage } from "../memory/rewind.js";
import { wrapPastedText, collapsePastes } from "../memory/pastedText.js";
import { manifestForModel } from "../drivers/registry.js";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTES_FILE } from "../memory/projectNotes.js";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { shownText, withoutClearedNote } from "../memory/compaction.js";
import { stopChassis } from "../alternator/lane.js";
import type { TodoItem, ToolContext, UiDisplay, UiLiveEvent, WebDisplay } from "../tools/types.js";
import { stopUi } from "../tools/ui.js";
import { runCommand } from "../tools/runCommand.js";
import { APPROVAL_TEXT, APPROVAL_DISMISSED } from "../tools/approval.js";
import { MODES, DEFAULT_MODE, modeById, modeFromFlags, type Mode, type ModeId } from "../cli/modes.js";
import { sharpContextWindow } from "../dynamo/contextWindow.js";

/**
 * The interaction modes (Lightning/Architect/Sentinel) — a client concept, same
 * pure data/functions the CLI's shift-tab indicator uses (cli/modes.ts). The
 * engine never sees a mode name, only the `planMode`/`guarded` flags it implies.
 */
export { MODES, DEFAULT_MODE, modeById, modeFromFlags, type Mode, type ModeId };

/**
 * `requestApproval`'s resolved string is a plain option label UNLESS the caller
 * offered `freeText`: a typed answer comes back prefixed with `APPROVAL_TEXT`
 * (strip it to get what was typed), and a dialog closed with no choice made should
 * resolve to `APPROVAL_DISMISSED` exactly, never an empty string or a thrown error.
 */
export { APPROVAL_TEXT, APPROVAL_DISMISSED };

/** The typed-answer row exit_plan offers. A front end compares against it to know an
 *  approval is a PLAN (shown in full) rather than a question, without matching prose. */
export { PLAN_FEEDBACK } from "../tools/exitPlan.js";
/** The user's machine-wide profile (what to call them), shared with the CLI. */
export { readProfile, saveProfile, type Profile } from "../memory/profile.js";
/** Feedback to the maintainer: the CLI's /feedback, same payload, same checks. */
export { buildFeedback, refuseReason, sendFeedback, ISSUES_URL, MAX_MESSAGE, type Feedback, type SendResult } from "../cli/feedback.js";
/** The anonymous usage count: the same id, on/off flag and ping the CLI uses. */
export { analyticsEnabled, setAnalyticsEnabled, sendAnalyticsPing } from "../cli/analytics.js";
export { appVersion } from "../cli/version.js";
/** Permissions: protected files, blocked commands and MCP tools, Sentinel allowances,
 *  default mode — per project or for every project. */
export {
  permissionsView,
  addPermission,
  removePermission,
  movePermission,
  revokeSessionGrant,
  setDefaultMode,
  defaultModeFor,
  type PermissionsView,
  type PermissionKind,
  type PermissionScope,
  type PermissionResult,
} from "./permissions.js";
/** The user's own auto-compaction bar: this project's, all-projects', or Mindweave's
 *  own model-anchored default (with a one-line reason why it's what it is). */
export {
  contextView,
  contextRecommendationFor,
  setContextOverride,
  resetContextOverride,
  CONTEXT_PRESETS,
  CONTEXT_MIN_TOKENS,
  type ContextView,
  type ContextScope,
  type ContextSource,
  type ContextRecommendation,
  type ContextResult,
} from "./contextSettings.js";
/** Tokens spent so far, across every project this machine has state for — by model
 *  and by day/week/month. Read-only; tokens only, no dollar figure. */
export { spendView, type SpendView, type SpendBucket, type ModelSpend } from "./spendView.js";
export { limitsView, saveLimitsFromPanel, analyzeForPanel, type LimitsView } from "./limitsView.js";
/** Rules and skills as files, for this project or all projects. */
export {
  listRulesSkills,
  readRuleSkill,
  saveRuleSkill,
  createRuleSkill,
  deleteRuleSkill,
  moveRuleSkill,
  importRuleSkill,
  type RSItem,
  type RSKind,
  type RSResult,
} from "./rulesSkills.js";
/** MCP servers: list, add/edit, remove, enable/disable, reconnect, sign in/out. */
export {
  listMcpServers,
  mcpServerDetail,
  saveMcpServer,
  removeMcpServer,
  setMcpServerDisabled,
  reconnectMcpServer,
  signInMcpServer,
  signOutMcpServer,
  allowChangedMcpTools,
  onMcpChange,
  type McpServerView,
  type McpServerDetail,
  type McpServerForm,
  type McpResult,
} from "./mcpServers.js";
/** Several keys per provider: add, edit, name, switch off, make default, auto-switch. */
export {
  providerKeys,
  addProviderKey,
  editProviderKey,
  removeProviderKey,
  useProviderKey,
  makeDefaultProviderKey,
  renameProviderKey,
  setProviderKeyDisabled,
  setProviderAutoSwitch,
  type KeyView,
  type ProviderKeysView,
  type KeyResult,
} from "./providerKeys.js";

/**
 * Load the API key(s) into process.env — the same global `~/.mindweave/.env` /
 * project `.env` / shell-env layering the CLI uses (see cli/bootstrap.ts). Call
 * this once, at startup, before the first `startSession`.
 */
export { loadConfig };

export interface ProviderSummary {
  id: string;
  label: string;
  apiKeyEnv: string;
  keysUrl: string;
  connected: boolean;
  /** A runtime on this machine (Ollama): no key; connected means it answered with a model. */
  local: boolean;
  models: { id: string; label: string; description?: string }[];
}

export interface ProviderModelDetail {
  id: string;
  label: string;
  description?: string;
  /** USD per 1M tokens, the driver's own rate table (the same numbers cost math uses). */
  /** `cacheWrite` is null where writing to the cache costs nothing beyond ordinary input. */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number | null };
  acceptsImages: boolean;
  /** True when the model can think before answering. */
  thinks: boolean;
}

/**
 * One provider's models with what each costs and can do, for a detail screen. Read from
 * the same manifests the engine bills and routes by, so the screen can never show a
 * price the cost math does not use. Null for an unknown provider id.
 */
export function providerDetail(id: string): (ProviderSummary & { models: ProviderModelDetail[] }) | null {
  const p = allProviders().find((m) => m.id === id);
  if (!p) return null;
  return {
    id: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    keysUrl: p.keysUrl,
    connected: hasApiKey(p.apiKeyEnv),
    local: !!p.local,
    models: modelsOf(p).map((m) => {
      const manifest = manifestForModel(m.id);
      const price = manifest.price(m.id);
      return {
        id: m.id,
        label: m.label,
        description: m.description,
        price: {
          input: price.cacheMiss,
          output: price.output,
          cacheRead: price.cacheHit,
          cacheWrite: price.cacheWrite ?? null,
        },
        acceptsImages: manifest.acceptsImages?.(m.id) ?? false,
        thinks: manifest.thinkLevels(m.id).some((l) => l.thinking),
      };
    }),
  };
}

/**
 * Every installed provider — the real registry (drivers/registry.ts), not a
 * decorative list — with whether a key is already on file for it and the
 * models it currently offers. Call `refreshDiscoveredModels()` first if the
 * caller wants a discovered provider's (e.g. OpenRouter's) list fully current.
 */
export function providerSummaries(): ProviderSummary[] {
  return allProviders().map((p) => ({
    id: p.id,
    label: p.label,
    apiKeyEnv: p.apiKeyEnv,
    keysUrl: p.keysUrl,
    connected: hasApiKey(p.apiKeyEnv),
    local: !!p.local,
    models: modelsOf(p).map((m) => ({ id: m.id, label: m.label, description: m.description })),
  }));
}

/** Pull fresh model lists for providers that discover theirs live (OpenRouter and
 *  any local-runtime provider) — same TTL the CLI's own picker uses. */
export function refreshDiscoveredModels(): Promise<string[]> {
  return refreshModels({ maxAgeMs: DISCOVERY_TTL_MS });
}

/** Where the Ollama server is, when it was pointed somewhere other than this computer ("" = this computer). */
export function ollamaAddress(): string {
  return process.env.MINDWEAVE_OLLAMA_URL?.trim() ?? "";
}

/**
 * Point Ollama at another address (a server on the network), or back at this computer with an empty
 * value. Saved like a key, so the terminal uses it too; the next look at the provider list asks that
 * address.
 */
export function setOllamaAddress(input: string | null): { ok: true; url: string | null } | { ok: false; error: string } {
  if (input === null || !input.trim()) {
    saveSetting("MINDWEAVE_OLLAMA_URL", null);
    return { ok: true, url: null };
  }
  const url = parseAddress(input);
  if (!url) return { ok: false, error: "That does not look like an address. Try 192.168.1.20:11434 or http://my-server:11434." };
  saveSetting("MINDWEAVE_OLLAMA_URL", url);
  return { ok: true, url };
}

/** Save a key for a provider (slot 1 — the primary key). Takes effect immediately;
 *  no restart needed, same as the CLI's `/key`. */
export function setProviderKey(apiKeyEnv: string, key: string): void {
  saveApiKey(apiKeyEnv, key);
}

/** Remove the stored key at slot 1. A provider with no key on file falls back to
 *  whatever `requestApproval`-less refusal path its driver already has. */
export function clearProviderKey(apiKeyEnv: string): void {
  removeApiKey(apiKeyEnv, 1);
}

/** The model driving a session's NEXT turn — read after `setSessionModel`, or at
 *  session load, to show the composer's picker the model that's actually active. */
export function sessionModel(session: Session): { id: string; label: string; providerId: string; providerLabel: string } {
  const id = session.modelConfig.model;
  const manifest = providerOf(id);
  return { id, label: modelLabel(id), providerId: manifest.id, providerLabel: manifest.label };
}

/**
 * Switch a live session onto a different model, mid-conversation — the same thing
 * `/model` does in the CLI. Synchronous onto the session (the next `runTurn` picks
 * it up automatically; `ensureDriver` inside `respond()` loads that provider's wire
 * code lazily, same as any other model choice), and persisted so the choice survives
 * a restart. `withModel` also clamps the reasoning level onto whatever ladder the
 * new model actually offers, so a thinking-heavy setting doesn't silently misfire
 * on a model that has no such dial.
 */
export async function setSessionModel(session: Session, model: string): Promise<void> {
  session.modelConfig = withModel(session.modelConfig, model);
  await saveModelConfig(session.cwd, session.modelConfig);
}

/**
 * The `/think` ladder for a session's CURRENT model, and which rung it's on now.
 * Every model has its own ladder shape — DeepSeek is Standard/High/Maximum,
 * Gemini is Standard/Thinking/Maximum, some models can't turn thinking off at
 * all — so a fixed three-option Off/Standard/Extended picker is wrong for most
 * of them. This is what the composer's thinking picker should build itself from,
 * fresh, every time the model changes.
 */
export function sessionThinkLevels(session: Session): { levels: ThinkLevel[]; current: string } {
  return { levels: thinkLevels(session.modelConfig.model), current: thinkLabel(session.modelConfig) };
}

/** Switch a live session onto a different rung of its model's OWN reasoning
 *  ladder — the same thing `/think` does in the CLI. Persisted like a model
 *  switch; takes effect on the next turn. */
export async function setSessionThinking(session: Session, level: { thinking: boolean; effort: Effort }): Promise<void> {
  session.modelConfig = { ...session.modelConfig, thinking: level.thinking, effort: level.effort };
  await saveModelConfig(session.cwd, session.modelConfig);
}

export type TurnEvent =
  | { type: "userMessage"; text: string; images?: string[]; files?: string[] }
  | { type: "text"; delta: string }
  /** The words since the last one of these are a draft the engine threw away: drop them. */
  | { type: "replyReset" }
  /** Whether the words just streamed lead to anything shown (see the engine's event). */
  | { type: "narration"; shown: boolean }
  /** A thinking model's reasoning stream. Not rendered — Mindweave doesn't show
   *  reasoning text — but the provider bills it as output, so a live token counter
   *  that skipped this would undershoot on a thinking model. */
  | { type: "reasoning"; delta: string }
  | { type: "toolStart"; id: string; name: string; arg?: string; kind: string; group: boolean; covers?: number; /** The tool itself (`ui`), where `name` is how the row reads ("Click"). */ tool?: string; /** What the call was given (full paths, a read range, a command), long text clipped. For a front end that shows the work itself rather than a one-line label. */ args?: Record<string, unknown> }
  | { type: "toolProgress"; id: string; text: string }
  | { type: "toolEnd"; id: string; ok: boolean; summary: string; detail?: string; detailFull?: string; detailKind?: "diff" | "text" | "shell"; quiet?: boolean; images?: string[]; web?: WebDisplay; ui?: UiDisplay }
  | { type: "subagentStart"; id: string; task: string; readOnly: boolean }
  | { type: "subagentEnd"; id: string; ok: boolean; summary: string }
  /** A tool call made BY a spawned sub-agent, not the lead — nests under that
   *  worker's own block instead of the main stream. */
  | { type: "subToolStart"; agentId: string; toolId: string; name: string; arg?: string; kind: string }
  | { type: "subToolEnd"; agentId: string; toolId: string; ok: boolean; summary: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "activity"; line: string; error?: boolean }
  | { type: "compaction"; before: number; after: number; window: number }
  /** A summarizing compaction started / ended (ended whether or not it succeeded). */
  | { type: "compactionStart" }
  | { type: "compactionEnd" }
  | { type: "notice"; title: string; body: string }
  /** The model's task list, whole, each time it is rewritten. Not a chat row: the source
   *  for a live checklist (drawn while a Marathon runs). */
  | { type: "todos"; items: TodoItem[] }
  /** Progress of a Marathon run itself. `text` is the one-line wording every front end
   *  shows, so the CLI and the app cannot phrase the same moment differently. */
  | { type: "marathon"; event: MarathonEvent; text: string }
  | { type: "error"; text: string }
  | { type: "done" };

export interface TurnHandlers {
  onEvent: (event: TurnEvent) => void;
  /** Messages typed while the turn is already running (a chat "send" mid-stream). */
  steer?: () => Promise<SteeredMessage[]>;
  signal?: AbortSignal;
}

/** Start a brand-new session rooted at `cwd` — one per open project/window. */
export function startSession(cwd: string): Promise<Session> {
  return createSession(cwd);
}

/** Reopen a session that was saved earlier, so a chat window can be closed and reopened. */
export function loadSession(cwd: string, sessionId: string): Promise<Session | null> {
  return resumeSession(cwd, sessionId);
}

/**
 * Release a session's live resources — background shells, MCP server processes,
 * chassis (LSP) instances — before switching away from it. Same cleanup as the
 * CLI's `stopCurrentLanes`: these are child processes / open handles the session
 * owns, not garbage-collectable state, so leaving them running across a switch
 * leaks a process pool per session swapped away from.
 */
export async function disposeSession(session: Session): Promise<void> {
  const ctx = session.toolContext;
  ctx.backgroundShells?.dispose();
  await ctx.mcp?.dispose();
  for (const ch of ctx.chassisByRoot?.values() ?? (ctx.chassis ? [ctx.chassis] : [])) {
    await stopChassis(ch);
  }
}

/** Every saved session for a project, most-recent first — for a session picker. */
export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  const metas = await listSessionsRaw(cwd);
  return [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
}

export type ReplayEvent =
  | { type: "userMessage"; text: string; expiredImages?: string[]; images?: string[]; files?: string[]; noRewind?: true }
  | { type: "assistantMessage"; text: string }
  | { type: "toolReplay"; name: string; arg?: string; kind: string; ok: boolean; summary: string; detail?: string; detailFull?: string; detailKind?: "diff" | "text" | "shell"; images?: string[]; web?: WebDisplay; ui?: UiDisplay; tool?: string; /** The call's arguments, clipped as on a live toolStart: which file a row is about. */ args?: Record<string, unknown>; /** A quiet result (only searches are replayed quiet): not a row of its own. */ quiet?: true }
  | { type: "compactionSummary"; text: string };

/** Compaction appends "[<paths> was attached here but is no longer in context …]" to a
 *  user message whose image it evicted (see IMAGE_CLEARED_STUB; older sessions carry an
 *  earlier wording). That note is for the MODEL. Replay shows the person their own words,
 *  plus which attachments have expired. */
const EXPIRED_IMAGE_NOTE = /\s*\[([^[\]]+?) was attached here but is no longer in context[^\]]*\]/g;
function splitExpiredImages(content: string): { text: string; expiredImages?: string[] } {
  const expired: string[] = [];
  const text = content.replace(EXPIRED_IMAGE_NOTE, (_m, names: string) => {
    for (const n of names.split(", ")) expired.push(n.split(/[\\/]/).pop() ?? n);
    return "";
  });
  return expired.length ? { text: text.trimEnd(), expiredImages: expired } : { text: content };
}

/**
 * Turn a loaded session's stored transcript back into the same shape the live
 * TurnEvent stream uses, so a session switch in the UI can redraw the whole
 * conversation with the one set of renderers instead of a second code path.
 * A synthetic user entry (an internal nudge, never typed by the person) is
 * skipped — see Entry's `synthetic` field.
 */
export function replayHistory(session: Session): ReplayEvent[] {
  const calls = new Map<string, ToolCallRecord>();
  const readThisTurn = new Set<string>(); // for narrationShown, as live
  const out: ReplayEvent[] = [];
  // What compaction took out comes first, so the chat shows the whole conversation.
  // None of it can be rewound to: it is no longer part of the conversation.
  const earlier = new Set(session.earlier ?? []);
  for (const entry of [...earlier, ...session.transcript]) {
    if (entry.role === "user") {
      if (!entry.synthetic) readThisTurn.clear();
      // Shown as typed: file bodies hidden and pastes collapsed, the same as it looked live.
      if (!entry.synthetic) {
        const paths = (entry.images ?? []).map((i) => i.path);
        const files = attachedFiles(entry.content, session.cwd);
        const shown = splitExpiredImages(displayText(entry.content));
        out.push({
          ...shown,
          type: "userMessage",
          text: hideAttachedNames(shown.text, [...paths, ...files]),
          ...(paths.length ? { images: paths } : {}),
          ...(files.length ? { files } : {}),
          // Typed mid-turn, or from before messages were stamped: nothing to go back to.
          ...(isRewindPoint(entry) && !earlier.has(entry) ? {} : { noRewind: true as const }),
        });
      }
    } else if (entry.role === "assistant") {
      // Words that led only to unseen tools were left out live, and are left out here too.
      const stepCalls = (entry.toolCalls ?? []).map((c) => ({ name: c.name, args: safeParseArgs(c.arguments) }));
      const shown = stepCalls.length === 0 || narrationShown(stepCalls, readThisTurn);
      noteReads(stepCalls, readThisTurn);
      // What was SAID is shown. Clearing old context leaves a note for the model in its place
      // and keeps the words for the screen (`shown`); the note itself is never shown.
      const said = shownText(entry);
      if (shown && said && said.trim()) out.push({ type: "assistantMessage", text: said });
      for (const call of entry.toolCalls ?? []) calls.set(call.id, call);
    } else if (entry.role === "tool") {
      const call = calls.get(entry.toolCallId);
      // Quiet results, and loading a tool even from sessions saved before it was quiet. A search
      // is quiet too, but it is still replayed (marked quiet): a front end may list what was searched.
      if (call?.name === "find_tools") continue;
      if (entry.quiet && call?.name !== "search") continue;
      // The same display name a live toolStart carries ("Run", "Read"), not the raw
      // tool id — a reopened session was showing `run_command` where the live one said Run.
      let name = entry.displayName ?? call?.name ?? "tool";
      let arg: string | undefined;
      let kind = entry.displayKind ?? "meta";
      const callArgs = call ? safeParseArgs(call.arguments) : undefined;
      if (call) {
        const d = toolDisplay(call.name, callArgs ?? {});
        if (!entry.displayName) name = d.name;
        arg = d.arg;
        if (!entry.displayKind) kind = d.kind;
      }
      out.push({
        type: "toolReplay",
        name,
        ...(call ? { tool: call.name, args: clipArgs(callArgs) } : {}),
        arg,
        kind,
        ok: !entry.isError,
        summary: entry.summary ?? withoutClearedNote(entry.content),
        detail: entry.detail,
        ...(entry.detailFull ? { detailFull: entry.detailFull } : {}),
        detailKind: entry.detailKind,
        ...(entry.imagePaths?.length ? { images: entry.imagePaths } : {}),
        ...(entry.web ? { web: entry.web } : {}),
        ...(entry.ui ? { ui: entry.ui } : {}),
        ...(entry.quiet ? { quiet: true as const } : {}),
      });
    } else if (entry.role === "summary") {
      out.push({ type: "compactionSummary", text: entry.content });
    }
  }
  return out;
}

/** Resolve dropped/attached file paths into ImageRefs, same checks the CLI applies
 *  (format, size, dimensions). A rejected file is reported through `onEvent` and
 *  otherwise just left out — it never blocks the rest of the message from sending. */
async function resolveImages(paths: string[], onEvent: (e: TurnEvent) => void) {
  const refs = [];
  for (const path of paths) {
    try {
      const st = await stat(path);
      const described = await describeImage(path, st.size);
      if (isRejection(described)) onEvent({ type: "activity", line: `${path}: ${described.reason}`, error: true });
      else refs.push(described);
    } catch {
      onEvent({ type: "activity", line: `${path}: couldn't read that file`, error: true });
    }
  }
  return refs;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Wire the client-side channels a session needs beyond `respond()` itself — the
 * same seam App.tsx's `attachApproval` fills for the CLI. Without `requestApproval`
 * every approval call fails CLOSED (see tools/approval.ts): reads and in-workspace
 * writes still work, but a forbidden-path lift, a write outside the workspace, an
 * ask_user question, or reading another agent's data all get refused outright
 * instead of asking. Call this once per session, right after `startSession` /
 * `loadSession`, before the first `runTurn`.
 */
export function attachHandlers(
  session: Session,
  handlers: {
    requestApproval?: ToolContext["requestApproval"];
    interrupt?: () => void;
    /** Fired when the ENGINE moves planMode/guarded on its own mid-turn (a plan
     *  gets approved via exit_plan, then restored when the turn ends) — read
     *  `sessionMode(session)` to see what it became. */
    onModeChange?: () => void;
    /** Frames of the app the agent is testing, while it tests (see ToolContext.onLive). */
    onLive?: (event: UiLiveEvent) => void;
  },
): void {
  if (handlers.requestApproval) session.toolContext.requestApproval = handlers.requestApproval;
  if (handlers.interrupt) session.toolContext.interrupt = handlers.interrupt;
  if (handlers.onModeChange) session.toolContext.onModeChange = handlers.onModeChange;
  if (handlers.onLive) session.toolContext.onLive = handlers.onLive;
}

/**
 * Esc: stop everything the agent has running. The caller aborts the turn itself; this
 * stops what outlives a turn: every background command (and so any app one launched)
 * and the app being tested with its live view. Background commands are stopped as by
 * the USER, so the model is told they were stopped rather than woken to restart them.
 */
export async function stopEverything(session: Session): Promise<void> {
  const mgr = session.toolContext.backgroundShells;
  for (const sh of mgr?.running() ?? []) mgr?.kill(sh.id, "user");
  await stopUi(session.toolContext);
}

/** The mode a session's CURRENT flags amount to — read after load, or after
 *  `onModeChange` fires, to show the UI what's actually active. */
export function sessionMode(session: Session): ModeId {
  return modeFromFlags(session.toolContext);
}

/**
 * Switch a session's interaction mode — same thing shift-tab does in the CLI.
 * A client concept: sets the `planMode`/`guarded` flags the engine reads, never
 * anything the engine itself knows the name of. Entering Sentinel clears any
 * earlier per-tool grants, so it starts genuinely vigilant rather than carrying
 * over permissions given under a looser mode.
 */
export function applySessionMode(session: Session, id: ModeId): void {
  const mode = modeById(id);
  session.toolContext.planMode = mode.readOnly;
  session.toolContext.guarded = mode.guarded;
  if (mode.guarded) session.toolContext.guardAllowed = undefined;
}

/**
 * Run one turn: append the user's message, stream the reply, persist after every step.
 * Mirrors App.tsx's streamRespond — same event mapping, without the reveal pacer.
 */
export async function runTurn(
  session: Session,
  message: { content: string; imagePaths?: string[]; images?: ImageRef[]; arrival?: "interrupting" },
  handlers: TurnHandlers,
): Promise<void> {
  await reloadProjectMemory(session).catch(() => {});
  const images = [...(message.images ?? []), ...(await resolveImages(message.imagePaths ?? [], handlers.onEvent))];
  await recordUserMessage(session, message.content, images, message.arrival);
  await streamTurn(session, handlers);
}

/**
 * Adds the user's message to the conversation and writes it to disk at once, before any model
 * call. The first save of a turn used to come after the model's first step, so a kill or a crash
 * during a slow first answer lost the message the user had just sent.
 */
export async function recordUserMessage(session: Session, content: string, images: ImageRef[] = [], arrival?: "interrupting"): Promise<void> {
  session.transcript.push({
    role: "user",
    content,
    // Sent by stopping the turn that was running (the app's "Send now"): the model is
    // told it was stopped on purpose, as the CLI tells it after Esc.
    ...(arrival ? { arrival } : {}),
    ...(images.length > 0 ? { images } : {}),
  });
  await saveSession(session);
}

/**
 * A reply that was being written when the app died. A front end that kept the streamed words
 * hands them here on the next start; they join the conversation, marked as cut off, so the
 * user (and the model) can see what had been said. Nothing is added if a saved reply already
 * holds those words: the kill may have come just after the step was saved.
 */
export async function appendInterruptedReply(session: Session, text: string): Promise<boolean> {
  const words = text.trim();
  if (!words) return false;
  const recent = session.transcript.slice(-4).filter((e) => e.role === "assistant" && typeof e.content === "string").map((e) => (e.content as string).trim());
  if (recent.some((c) => c && (c.includes(words.slice(0, 160)) || words.startsWith(c)))) return false;
  session.transcript.push({ role: "assistant", content: `${words}\n\n(interrupted)` });
  await saveSession(session);
  return true;
}

/**
 * What was typed, plus files added through the UI and long pastes, turned into what the
 * model gets and what the chat shows. Shared by a fresh send and a message queued into a
 * running turn, so the two can't resolve the same message differently.
 *
 * Files go through the CLI's own `resolveAttachments`, exactly as if they had been
 * dropped into the prompt as quoted paths: images take the vision path when the running
 * model can see them, text files arrive as `<attached_file>` blocks, binaries are skipped
 * with a note. Pastes are wrapped with the CLI's `wrapPastedText`. So a message reads the
 * same to the model whichever front end it was typed in.
 */
/** A quarter of the model's window, in tokens: what one message may attach (see cli/attachments.ts). */
export function attachmentBudget(model: string): number {
  return Math.max(8_000, Math.floor(sharpContextWindow(model) * 0.25));
}

export async function prepareMessage(
  session: Session,
  input: { text: string; filePaths?: string[]; pastes?: string[] },
  onEvent: (e: TurnEvent) => void,
): Promise<{ content: string; images: ImageRef[]; imagePaths: string[]; files: string[]; displayText: string }> {
  const paths = input.filePaths ?? [];
  const withPaths = paths.length
    ? `${input.text}${input.text ? "\n" : ""}${paths.map((p) => `"${p}"`).join(" ")}`
    : input.text;
  const model = session.modelConfig.model;
  const canSee = manifestForModel(model).acceptsImages?.(model) ?? false;
  const resolved = await resolveAttachments(withPaths, session.cwd, canSee, undefined, attachmentBudget(model));
  // Only what went wrong is news; "attached a.ts (+40 lines)" is already on screen as a chip.
  for (const note of resolved.notes) {
    if (/^skipped |can't see images/.test(note)) onEvent({ type: "activity", line: note, error: true });
  }
  const pastes = (input.pastes ?? []).filter((p) => p.trim().length > 0);
  const content = pastes.length
    ? `${resolved.modelText}${resolved.modelText ? "\n\n" : ""}${pastes.map(wrapPastedText).join("\n\n")}`
    : resolved.modelText;
  const imagePaths = resolved.images.map((i) => i.path);
  const files = attachedFiles(content, session.cwd);
  return { content, images: resolved.images, imagePaths, files, displayText: hideAttachedNames(displayText(content), [...imagePaths, ...files]) };
}

/** A user message as the chat shows it: attached file bodies hidden, pastes as their chip. */
function displayText(content: string): string {
  return collapsePastes(stripAttachments(content));
}

/**
 * Continue a session with NO new message — the engine notices what changed on its
 * own (a background shell finished) from state already on the session. Mirrors the
 * CLI's `reactToBackground`: it calls the exact same `streamRespond` a typed message
 * would, just without anything new having been said.
 */
/**
 * Compact the conversation now, whatever its size: the app's button, the CLI's /compact.
 * It sends the same compaction events an automatic one does inside a turn, then saves.
 */
export async function compactSession(session: Session, onEvent: (e: TurnEvent) => void): Promise<void> {
  await compactNow(session, {
    onActivity: (line, opts) => onEvent({ type: "activity", line, error: opts?.error }),
    onCompaction: (report) => onEvent({ type: "compaction", before: report.before, after: report.after, window: report.window }),
    onCompactionStart: () => onEvent({ type: "compactionStart" }),
    onCompactionEnd: () => onEvent({ type: "compactionEnd" }),
  });
  await saveSession(session);
}

export function continueTurn(session: Session, handlers: TurnHandlers): Promise<void> {
  return streamTurn(session, handlers);
}

/** Re-export of the CLI's own wake decision (cli/backgroundWake.ts) — plain state in,
 *  boolean out, no Ink involved — so a caller can reuse the exact same rule for when a
 *  finished background command is worth waking the model for. */
export { shouldReactToBackground, type WakeState } from "../cli/backgroundWake.js";

/** A tool call's arguments for display: long strings (a whole file being written) are cut, since a front end
 *  that wants the file reads it from disk. */
const ARG_TEXT_MAX = 2000;
export function clipArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const clip = (v: unknown): unknown =>
    typeof v === "string" ? (v.length > ARG_TEXT_MAX ? v.slice(0, ARG_TEXT_MAX) : v)
    : Array.isArray(v) ? v.map(clip)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
    : v;
  return (clip(args ?? {}) as Record<string, unknown>);
}

/**
 * One engine event, as the plain TurnEvent a front end draws. Shared by an ordinary turn
 * and a Marathon run so a tool call, a task list or a token reads identically in both.
 */
export function forwardEngineEvent(e: EngineEvent, onEvent: (event: TurnEvent) => void): void {
  if (e.type === "text") {
    onEvent({ type: "text", delta: e.delta });
  } else if (e.type === "reasoning") {
    onEvent({ type: "reasoning", delta: e.delta });
  } else if (e.type === "todos") {
    onEvent({ type: "todos", items: e.items });
  } else if (e.type === "narration") {
    onEvent({ type: "narration", shown: e.shown });
  } else if (e.type === "replyReset") {
    onEvent({ type: "replyReset" });
  } else if (e.type === "tool" && e.phase === "start") {
    // The spawn is rendered by the subagentStart block; loading a tool is never shown.
    if (e.name === "spawn_subagent" || e.name === "find_tools") return;
    const d = toolDisplay(e.name, e.args);
    if (e.agent) {
      onEvent({ type: "subToolStart", agentId: e.agent, toolId: e.id, name: d.name, arg: d.arg, kind: d.kind });
    } else {
      onEvent({ type: "toolStart", id: e.id, name: d.name, arg: d.arg, kind: d.kind, tool: e.name, group: isGroupable(e.name), args: clipArgs(e.args), ...(d.covers ? { covers: d.covers } : {}) });
    }
  } else if (e.type === "tool" && e.phase === "end") {
    if (e.name === "spawn_subagent" || e.name === "find_tools") return;
    if (e.agent) {
      onEvent({ type: "subToolEnd", agentId: e.agent, toolId: e.id, ok: !e.error, summary: e.summary });
    } else {
      onEvent({ type: "toolEnd", id: e.id, ok: !e.error, summary: e.summary, detail: e.detail, detailFull: e.detailFull, detailKind: e.detailKind, quiet: e.quiet, ...(e.images?.length ? { images: e.images } : {}), ...(e.web ? { web: e.web } : {}), ...(e.ui ? { ui: e.ui } : {}) });
    }
  } else if (e.type === "tool" && e.phase === "progress") {
    // What a call that takes a while is doing meanwhile (the ui tool waiting for an
    // app to finish building). Latest-wins text, not a log.
    if (!e.agent) onEvent({ type: "toolProgress", id: e.id, text: e.text });
  } else if (e.type === "subagent" && e.phase === "start") {
    onEvent({ type: "subagentStart", id: e.id, task: e.task, readOnly: e.readOnly });
  } else if (e.type === "subagent" && e.phase === "end") {
    onEvent({ type: "subagentEnd", id: e.id, ok: !e.error, summary: e.summary });
  } else if (e.type === "usage") {
    onEvent({ type: "usage", promptTokens: e.promptTokens, completionTokens: e.completionTokens, totalTokens: e.totalTokens });
  }
}

/**
 * A key refused for credit, a rate limit or rejection: when the user allowed it, move to
 * their next key so the caller can carry on from where the turn stopped. A refusal happens
 * on the status line, before any reply arrived, so nothing is half-written to resume over.
 * True when it switched; false leaves the error for the caller to report.
 */
function tryFailover(
  session: Session,
  error: unknown,
  signal: AbortSignal | undefined,
  triedKeys: Set<string>,
  onEvent: (event: TurnEvent) => void,
): boolean {
  const provider = providerOf(session.modelConfig.model);
  const status = statusOf(error);
  if (status === null || signal?.aborted || !accessRefusal(error, provider.label, false)) return false;
  const moved = failoverKey(manifestForModel(session.modelConfig.model).apiKeyEnv, status, triedKeys);
  if (!moved) return false;
  const why = moved.reason === "no-credit" ? "is out of credit" : moved.reason === "rate-limited" ? "hit its rate limit" : "was rejected";
  onEvent({ type: "activity", line: `${provider.label} key ${moved.from} ${why}, switched to ${moved.to}` });
  return true;
}

async function streamTurn(session: Session, handlers: TurnHandlers): Promise<void> {
  const { onEvent, steer, signal } = handlers;
  // Keys already refused in THIS turn, so switching can't go round in a circle.
  const triedKeys = new Set<string>();

  for (;;) {
  try {
    await respond(session, {
      steer,
      signal,
      onActivity: (line, opts) => onEvent({ type: "activity", line, error: opts?.error }),
      onCompaction: (report) => onEvent({ type: "compaction", before: report.before, after: report.after, window: report.window }),
      onCompactionStart: () => onEvent({ type: "compactionStart" }),
      onCompactionEnd: () => onEvent({ type: "compactionEnd" }),
      onEvent: (e) => forwardEngineEvent(e, onEvent),
      persist: () => saveSession(session),
    });
    noteKeyWorked(manifestForModel(session.modelConfig.model).apiKeyEnv);
    onEvent({ type: "done" });
    await saveSession(session);
    return;
  } catch (error) {
    if (tryFailover(session, error, signal, triedKeys, onEvent)) continue;
    reportFailure(session, error, onEvent);
    onEvent({ type: "done" });
    await saveSession(session);
    return;
  }
  }
}

/** A turn that ended in an error, as a notice (a refusal or an outage the user can act on)
 *  or a plain error line. */
function reportFailure(session: Session, error: unknown, onEvent: (event: TurnEvent) => void): void {
  const refusal =
    accessRefusal(error, providerOf(session.modelConfig.model).label, false) ??
    providerOutage(error, providerOf(session.modelConfig.model).label, modelLabel(session.modelConfig.model));
  if (refusal) onEvent({ type: "notice", title: refusal.title, body: refusal.body });
  else onEvent({ type: "error", text: errText(error) });
}

/**
 * Run a Marathon for a front end: the same events an ordinary turn streams, plus the
 * run's own progress and the live task list, with the same key failover and error
 * reporting. `run` is the start/resume call; `override` swaps the engine calls for a fake
 * in a test.
 */
async function driveMarathon(
  session: Session,
  handlers: MarathonHandlers,
  run: (options: MarathonOptions, deps: MarathonDeps) => Promise<MarathonState | null>,
  override: Partial<MarathonDeps> = {},
): Promise<MarathonState | null> {
  const { onEvent, steer, signal } = handlers;
  const triedKeys = new Set<string>();
  const deps: MarathonDeps = {
    // Every turn of the run gets the failover an ordinary turn gets.
    respond: async (s, options) => {
      for (;;) {
        try {
          return await respond(s, options);
        } catch (error) {
          if (tryFailover(s, error, signal, triedKeys, onEvent)) continue;
          throw error;
        }
      }
    },
    verify: verifyGoal,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...override,
  };
  let state: MarathonState | null = null;
  try {
    state = await run(
      {
        signal,
        ...(steer ? { steer } : {}),
        ...(handlers.limits ? { limits: handlers.limits } : {}),
        onActivity: (line, opts) => onEvent({ type: "activity", line, error: opts?.error }),
        onCompaction: (report) => onEvent({ type: "compaction", before: report.before, after: report.after, window: report.window }),
        onCompactionStart: () => onEvent({ type: "compactionStart" }),
        onCompactionEnd: () => onEvent({ type: "compactionEnd" }),
        onEvent: (e) => forwardEngineEvent(e, onEvent),
        onMarathon: (event) => onEvent({ type: "marathon", event, text: describeMarathonEvent(event) }),
        persist: () => saveSession(session),
      },
      deps,
    );
    noteKeyWorked(manifestForModel(session.modelConfig.model).apiKeyEnv);
  } catch (error) {
    // The run stays "running" on the session, so it can be resumed once the cause is fixed.
    reportFailure(session, error, onEvent);
  }
  onEvent({ type: "done" });
  await saveSession(session);
  return state;
}

export interface MarathonHandlers extends TurnHandlers {
  /** Optional cost/time ceiling for the whole goal. */
  limits?: MarathonOptions["limits"];
}

/**
 * Start a Marathon on `goal`: the user armed it and sent their goal. Replaces any
 * Marathon the session already holds. Resolves when the run reaches an outcome or is
 * stopped (the same signal that stops a turn); a stopped run stays resumable.
 */
export async function startMarathonRun(
  session: Session,
  goal: string | { content: string; imagePaths?: string[]; images?: ImageRef[] },
  handlers: MarathonHandlers,
  override?: Partial<MarathonDeps>,
): Promise<MarathonState | null> {
  // Same preparation as the first message of any turn: the project's notes re-read, and
  // attached images resolved (and rejected loudly) the way `runTurn` does it.
  const message = typeof goal === "string" ? { content: goal } : goal;
  await reloadProjectMemory(session).catch(() => {});
  const goalImages = [
    ...(("images" in message && message.images) || []),
    ...(await resolveImages(("imagePaths" in message && message.imagePaths) || [], handlers.onEvent)),
  ];
  return driveMarathon(
    session,
    handlers,
    (options, deps) => startMarathon(session, message.content, { ...options, ...(goalImages.length ? { goalImages } : {}) }, deps),
    override,
  );
}

/** Carry on a Marathon that was stopped, or that a restart interrupted. Resolves null
 *  when there is nothing to resume. */
export function resumeMarathonRun(
  session: Session,
  handlers: MarathonHandlers,
  override?: Partial<MarathonDeps>,
): Promise<MarathonState | null> {
  return driveMarathon(session, handlers, (options, deps) => resumeMarathon(session, options, deps), override);
}

/** Close a Marathon for good: dropped from the session AND from its saved file, so
 *  reopening the session later does not bring a dismissed run back. */
export async function dismissMarathon(session: Session): Promise<void> {
  clearMarathon(session);
  await saveSession(session);
}

/** The session's Marathon, if it has one — running, stopped, or finished. */
export function marathonOf(session: Session): MarathonState | null {
  return session.marathon ?? null;
}

/**
 * Start a command the USER asked for (the app's Run button) as a background shell, through
 * the same run_command tool the agent uses, so it lands in the same shell list, the agent
 * can read its output, and stopping it is the same kill. The click is the approval, so no
 * gate is asked. `notify: "never"` because the user starting their own app is not an event
 * to wake the model for. Returns the shell id, or an error message.
 */
export async function startUserCommand(
  session: Session,
  command: string,
  cwd?: string,
): Promise<{ id: number } | { error: string }> {
  // A fresh context: the session's may still carry the last turn's (aborted) signal.
  // `cwd` is for an app that lives in a subfolder of the project.
  const ctx: ToolContext = { ...session.toolContext, abortSignal: undefined, cwd: cwd ?? session.toolContext.cwd };
  // hidden: false because the user pressed Run to see their app, whatever its script says.
  const result = await runCommand.execute({ command, run_in_background: true, notify: "never", hidden: false }, ctx);
  const id = /shell #(\d+)/.exec(`${result.summary ?? ""} ${result.output}`)?.[1];
  if (result.isError || !id) return { error: result.output || "Could not start the command." };
  return { id: Number(id) };
}

/** The project's MINDWEAVE.md (in the project root, the notebook the agent keeps) and
 *  what it says. A missing file is empty, not an error. */
export async function readProjectNotes(cwd: string): Promise<{ path: string; text: string; exists: boolean; modifiedAt: number | null }> {
  const path = join(cwd, NOTES_FILE);
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { path, text, exists: true, modifiedAt: info.mtimeMs };
  } catch {
    return { path, text: "", exists: false, modifiedAt: null };
  }
}

/**
 * Replace the project's MINDWEAVE.md, then re-read it into the live session so the NEXT
 * message already follows it. That costs one prompt-cache rebuild, which is what an edit
 * the user made on purpose is worth; the model's own mid-session edits keep the cheaper
 * deferred path.
 */
export async function saveProjectNotes(cwd: string, text: string, session?: Session | null): Promise<void> {
  await writeFileAtomic(join(cwd, NOTES_FILE), text);
  if (session) await reloadProjectMemory(session, { force: true });
}
