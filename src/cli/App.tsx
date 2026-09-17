/**
 * App — the terminal UI shell (the "eyes and hands" of Mindweave).
 *
 * The transcript is a pure state machine (transcript.ts): a `committed` list
 * (append-only) and a live `tail` (the block currently streaming + any running
 * tool). A block drains from tail → committed the instant it and every earlier
 * block is done — that lets streamed text reveal WHOLE (tokens accumulate
 * silently; the block appears at once when it seals), never typewriter.
 *
 * Mindweave runs in the terminal's alternate screen (altScreen.ts) with a
 * pinned header, a pinned footer, and the full committed+tail history in a
 * flexGrow middle region that fills whatever space they don't use — there
 * is no real terminal scrollback to lean on inside alt-screen, so nothing
 * here is capped: the whole conversation stays in memory and only the
 * render is windowed (clipped to the newest content that fits).
 *
 * The UI owns the session for the whole conversation: it creates one on startup,
 * appends each user turn to its transcript, asks the dynamo (engine) for a reply,
 * and persists after every turn. It still knows nothing about any provider, prompts,
 * or compaction internals — it calls `respond()` / `compactNow()` and renders the
 * stream events they emit.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { isAbsolute, resolve } from "node:path";
import { Box, Static, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from "ink";
import { compactNow, contextUsed, respond } from "../dynamo/engine.js";
import type { SteeredMessage } from "../dynamo/engine.js";
import { contextPressure, sharpContextWindow, autoCompactThreshold } from "../dynamo/contextWindow.js";
import { contextBudget, formatBudget } from "../dynamo/contextBudget.js";
import { createSession, resumeSession, reloadProjectMemory } from "../memory/session.js";
import { saveSession, listSessions } from "../memory/store.js";
import { stopChassis } from "../alternator/lane.js";
import { loadSkillBody, substituteSkillArgs } from "../governor/skills.js";
import { appendForbidden, appendForbiddenCommand } from "../governor/write.js";
import { addRoot, removeRoot } from "../tools/workspace.js";
import { discoverRelatedRoots } from "../tools/workspaceDiscover.js";
import { rootLabel, rootsOf, relativize } from "../tools/paths.js";
import { APPROVAL_DISMISSED, APPROVAL_TEXT } from "../tools/approval.js";
import { KeySetup } from "./components/KeySetup.js";
import { setupView } from "./keySetup.js";
import { KeyManager } from "./components/KeyManager.js";
import { McpMinitabs } from "./components/McpMinitabs.js";
import { providerRows, keyRowsFor, nextSlotFor } from "./keyManager.js";
import { keysFor } from "./keyStore.js";
import { TrustGate } from "./components/TrustGate.js";
import { rootBreadth, breadthWarning, trustPersists, isTrusted, rememberTrust } from "./trust.js";
import { projectDir } from "../memory/store.js";
import { parseUndoArg, undoNotice } from "../tools/checkpoints.js";
import { DEFAULT_MODEL_CONFIG, thinkLevels, thinkLabel, modelLabel, modelsOfProvider, providerOf, usableFallback, needsKeySetup, withModel, saveModelConfig, refreshModels, DISCOVERY_TTL_MS, type ModelConfig } from "../dynamo/model.js";
import { allProviders, manifestForModel, modelsOf } from "../drivers/registry.js";
import { orderProviders, orderModels } from "./pickerOrder.js";
import { accessRefusal, providerOutage } from "../drivers/providerError.js";
import { resolveAttachments, stripAttachments } from "./attachments.js";
import { collapsePastes, wrapPastedText } from "../memory/pastedText.js";
import { createDropHandles, expandHandles } from "./dropHandles.js";
import { shouldReactToBackground } from "./backgroundWake.js";
import { TIPS, TipLine, nextTip, randomTipIndex } from "./components/TipLine.js";
import { completePath } from "./pathComplete.js";
import { formatHelp } from "./help.js";
import { hasApiKey, saveApiKey, removeApiKey, useApiKey, globalEnvPath, reloadConfig } from "./bootstrap.js";
import { versionLabel, appVersion } from "./version.js";
import { checkForUpdate } from "./updateCheck.js";
import {
  ANALYTICS_EXPLANATION,
  analyticsEnabled,
  sendAnalyticsPing,
  setAnalyticsEnabled,
  startupStatusLine,
} from "./analytics.js";
import { PromptInput } from "./components/PromptInput.js";
import { Picker } from "./components/Picker.js";
import { ApprovalBox } from "./components/ApprovalBox.js";
import { BlockView } from "./components/BlockView.js";
import { initialState, reduce, trimNarration, type Action, type Block, type TranscriptState } from "./transcript.js";
import { isTight } from "./blockSpacing.js";
import { parseScreenArg, screenChoices, screenNotice, startupMode, type ScreenMode } from "./screenMode.js";
import { applyScreenMode } from "./screenShell.js";
import { saveScreenMode } from "./screenStore.js";
import { needsMeasure, pruneHeights } from "./blockHeights.js";
import { BASE_COMMANDS } from "./commands.js";
import { manualCommand, refusalReason } from "./selfUpdate.js";
import { currentInstall, requestRestart, runUpdate } from "./updateRunner.js";
import { enableMouse, readMouse, readWheel, stripMouse } from "./mouse.js";
import { applySelection, ctrlCShouldCopy, isEmpty, selectionText, type Selection } from "./selection.js";
import { latestScreen, repaintOverlay, setFrameOverlay } from "./framebuffer/overlay.js";
import { requestFullRepaint } from "./framebuffer/writer.js";
import { copyToClipboard } from "./clipboard.js";
import { chatLayout, reflowScroll, growScroll } from "./chatAnchor.js";
import { growFill, INLINE_LIVE_RESERVE, NO_FILL } from "./startupFill.js";
import { setRowsBelowCaret } from "./exitCursor.js";
import { caretCell } from "./caretPark.js";
import { countNewReplies, hitsPill, pillBounds, scrollPill, type PillBounds } from "./scrollPill.js";
import { virtualWindow } from "./virtualWindow.js";
import { perf, perfEnabled } from "./perfLog.js";
import { isGroupMember, groupSettled, planGroupReveal, planStandaloneReveal, resultQueued, STANDALONE_HOLD_MS } from "./groupReveal.js";
import { drain as drainQueue, popAll as popAllQueued, queueMessage, takeSteerable, visibleQueue, type Queued } from "./messageQueue.js";
import { routeCommand, parseCommandLine, unknownCommandMessage } from "./commandRoute.js";
import { resolveChoice, splitModelArg } from "./commandArgs.js";
import { carryAcrossFreshSession } from "./sessionCarry.js";
import { toolDisplay, isGroupable, KIND_COLOR } from "./toolDisplay.js";
import { workingVerb } from "./workingVerb.js";
import { narrationPending, revealWait } from "./revealPace.js";
import { summarizeTask, formatTokens, type TaskUsage } from "../dynamo/pricing.js";
import { meterReset, meterDelta, meterTick, meterValue, type MeterState } from "../dynamo/liveMeter.js";
import type { Usage } from "../drivers/types.js";
import type { ShellInfo } from "../tools/backgroundShells.js";
import { addServerToConfig, configPathFor, parseAddSpec, removeServerFromConfig, resolveConfigPath, splitArgs, type AddSpec } from "../mcp/configWrite.js";
import { mapPromptArguments, promptCommand, promptUsage } from "../mcp/prompts.js";
import type { Entry, Session, SessionMeta } from "../memory/types.js";
import { DEFAULT_MODE, modeById, modeFromFlags, nextMode, type ModeId } from "./modes.js";
import { ApprovalChannel } from "./approvalChannel.js";

const MINDWEAVE_DOCS_URL = "https://mindweave.dev";

/** How long each hint under the input box stays up. Long enough to read twice without
 *  hurrying, short enough that a session sees the whole set rather than one of them. */
const TIP_ROTATE_MS = 12_000;

/** Commands whose whole job is to open a surface in the box under the input. Written out
 *  in full, because only a bare invocation opens anything: given an argument each of these
 *  acts directly and there is no surface to hold the frame for. */
const OVERLAY_COMMANDS = new Set([
  "/analytics",
  "/continue",
  "/key",
  "/mcp",
  "/model",
  "/provider",
  "/shells",
  "/think",
]);

/**
 * The provider whose key we're missing, and what to tell the user about it.
 *
 * `pending` is the switch this key would unlock. Its presence is also what makes the
 * prompt escapable: a first-run gate has nothing behind it, but a gate reached by
 * choosing a provider does — the session you were already in.
 */
/** What a model's provider needs before it can answer. Used to DECIDE, never to render:
 *  the screens that ask for a key are KeySetup and KeyManager. */
type KeyNeed = {
  envVar: string;
  label: string;
  keysUrl: string;
};

/**
 * The key a model needs, or null if we already have it. Each provider declares
 * its own variable name and key page, so this stays correct as providers are
 * added — nothing here names a provider.
 */
function missingKeyFor(model: string): KeyNeed | null {
  const provider = manifestForModel(model);
  if (hasApiKey(provider.apiKeyEnv)) return null;
  return { envVar: provider.apiKeyEnv, label: provider.label, keysUrl: provider.keysUrl };
}

/**
 * The providers `/provider` lists, in display order: the default first, then the ones
 * you have a key for, then the rest, each group alphabetical. Called by the render, the
 * selection handler and the initial-cursor lookup, so all three index the same order —
 * see pickerOrder.
 */
function orderedProviderList() {
  return orderProviders(allProviders(), (p) => hasApiKey(p.apiKeyEnv), providerOf(DEFAULT_MODEL_CONFIG.model).id);
}

/** One provider's models in display order: its default first, the rest alphabetical. */
function orderedModelList(model: string) {
  return orderModels(modelsOfProvider(model));
}

/** The same order, for a provider named by id rather than by one of its models. */
function orderedModelsOf(providerId: string) {
  const provider = allProviders().find((p) => p.id === providerId);
  return provider ? orderModels(modelsOf(provider)) : [];
}


/**
 * An interactive overlay that temporarily takes over the keyboard (rendered as a
 * Picker below the transcript). `sessions` resumes a past chat; `model`/`think`
 * choose the model + reasoning; `approval` is the forbidden-path Yes/No/other
 * prompt, carrying the promise resolver the blocked tool is awaiting.
 */
type Overlay =
  | { kind: "analytics" }
  | { kind: "sessions"; items: SessionMeta[] }
  | { kind: "resumeMode"; meta: SessionMeta }
  | { kind: "provider" }
  /** `providerId` absent means the provider in use; `filter` pre-fills the picker's filter. */
  | { kind: "model"; providerId?: string; filter?: string }
  | { kind: "think" }
  | { kind: "screen" }
  | { kind: "shells"; items: ShellInfo[] }
  | {
      kind: "approval";
      question: string;
      options: string[];
      freeText?: { label: string; placeholder: string };
      resolve: (choice: string) => void;
    };

// After you pick a session in /continue, the three ways to resume it.
const RESUME_MODES = [
  { label: "Compact & continue", description: "summarize the old chat first so it won't eat your context, then pick up where you left off" },
  { label: "Continue as-is", description: "resume the full conversation unchanged" },
  { label: "Fresh start", description: "leave it and start a new empty session here instead" },
];

/**
 * `resumeSessionId` is set only by a relaunch after `/update` — see `restart.ts`. It is
 * what makes the restart invisible: the new version opens on the conversation the old
 * one was in, rather than on an empty session that happens to be in the same folder.
 */
export interface AppProps {
  /** Set only by a relaunch after `/update`. */
  resumeSessionId?: string;
  /** The shell to open in, already resolved from the env var and the project's saved
   *  choice. Resolved by the caller because reading it touches the disk, and because the
   *  same answer decides whether to take the alternate screen at all — before this ever
   *  renders. See index.ts. */
  initialScreen?: ScreenMode;
}

export function App({ resumeSessionId, initialScreen }: AppProps) {
  // The transcript state machine lives in a ref and is advanced by the reducer as
  // the stream arrives; `render` forces a paint. A ref (not useState) so the async
  // streaming loop always reads/writes the latest state without stale closures.
  const stateRef = useRef<TranscriptState>(initialState());
  const [, render] = useReducer((n: number) => n + 1, 0);
  const dispatch = (action: Action) => {
    stateRef.current = reduce(stateRef.current, action);
    render();
  };
  // Apply WITHOUT a repaint — for streamed text tokens: they accumulate silently
  // (the assistant block shows nothing until it seals, by design — whole-block
  // reveal, never typewriter), so painting per token is pure churn (the thing that
  // made the old version glitch). The next real event (tool/seal) paints and picks
  // up the accumulated text.
  const applySilent = (action: Action) => {
    stateRef.current = reduce(stateRef.current, action);
  };
  // Apply several actions as ONE frame: everything but the last lands silently, so
  // the terminal never shows a block part-way through being assembled. Ink mounts a
  // legacy React root, which flushes each dispatch synchronously — so "one dispatch"
  // and "one frame" are the same thing, and a block that needs two actions to be
  // complete must batch them or it will be seen incomplete.
  const applyBatch = (actions: Action[]) => {
    for (let i = 0; i < actions.length; i++) {
      if (i === actions.length - 1) dispatch(actions[i]!);
      else applySilent(actions[i]!);
    }
  };

  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Interaction mode (Lightning / Architect), cycled with shift-tab. The ref
  // mirrors the state so the async streaming loop and session setup read the
  // latest without a stale closure; `planMode` on the toolContext is the single
  // flag the engine actually acts on (set by applyMode / attachApproval).
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);
  const modeRef = useRef<ModeId>(DEFAULT_MODE);
  // The hint under the input box. It ADVANCES (see TipLine): picking one at startup and
  // holding it meant a whole session showed a single hint out of the set, so the rest were
  // written and never read. Starts somewhere random so consecutive launches differ.
  // The drag in progress, or the one just finished and still highlighted. A REF and not
  // state: it is painted by the framebuffer overlay rather than by React, so changing it
  // must not cost a render (see the pointer effect).
  const selection = useRef<Selection | null>(null);
  /**
   * Drop the highlight, if there is one, and stop tinting frames.
   *
   * The overlay is installed only for as long as a selection exists, which matters
   * because the renderer keeps a spare copy of every frame while one is installed (so a
   * drag can be re-tinted without a re-render). That copy is worth its cost during a drag
   * and is pure waste the rest of the time, which is nearly all of it. Repaint FIRST,
   * then uninstall: the repaint is what takes the highlight off the screen.
   */
  const clearSelection = useCallback(() => {
    if (!selection.current) return;
    selection.current = null;
    repaintOverlay();
    setFrameOverlay(null);
  }, []);
  // PromptInput installs the handler that turns a click into a caret position; only it
  // knows what its rows currently hold. Null until the input is on screen.
  const caretClick = useRef<((x: number, y: number) => void) | null>(null);
  /** Offers a finished drag to the input as an editable range; false if it was not text
   *  the input owns. */
  const textSelect = useRef<((a: { x: number; y: number }, b: { x: number; y: number }) => boolean) | null>(null);
  const placeCaretAt = useCallback((x: number, y: number) => {
    caretClick.current?.(x, y);
  }, []);

  const [tipIdx, setTipIdx] = useState(randomTipIndex);
  // Slow on purpose. The line sits under the box the user is typing in, so it has to read
  // as something that changed while they were not looking, never as movement competing
  // for attention. One interval for the process, not one per render.
  useEffect(() => {
    const timer = setInterval(() => setTipIdx((i) => nextTip(i)), TIP_ROTATE_MS);
    return () => clearInterval(timer);
  }, []);
  // How far the transcript is scrolled back, in LINES from the bottom. Alt-screen
  // has no terminal scrollback of its own (altScreen.ts), so this is ours to
  // implement; 0 means pinned to the newest.
  const [scrollUp, setScrollUp] = useState(0);
  /**
   * The newest block id at the moment the view left the bottom, or null while pinned.
   *
   * This is what "new since you scrolled away" is counted from. A REF rather than
   * state, and that is the point: it is written in an effect and read during render,
   * so recording it costs no re-render of its own. The count it feeds only changes
   * when a block arrives — which is a render already.
   */
  const scrollMark = useRef<number | null>(null);
  /**
   * How far the transcript can actually travel, from the last frame.
   *
   * Only the render knows it — it needs the measured content and viewport heights —
   * but the scroll handlers, which run between frames, are what have to respect it.
   * A ref is the one thing both can reach without the handlers being rebuilt on every
   * height change.
   */
  const maxScrollRef = useRef(0);
  // The transcript's real rendered height, from measureElement — never estimated.
  const contentRef = useRef<DOMElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  /** Reading position captured at a width change, pending the first measurement at the
   *  new width. Null except across that one frame. See the width-change block below. */
  const reflowFrom = useRef<{ scrolled: number; maxScroll: number } | null>(null);
  /** `contentHeight` as of the last measurement, so growth between renders is a delta
   *  the scroll position can be compensated by. See the growth-compensation block below. */
  const prevContentHeight = useRef<number | null>(null);
  // Each block's real rendered height, so blocks off screen can be replaced by a
  // spacer of the exact same size instead of being laid out in full — see
  // `virtualWindow.ts` for why that is the whole performance story, and why exact
  // is the word that matters.
  //
  // Each entry keeps the BLOCK OBJECT it was measured from, and a lookup only counts
  // when that object is still the current one. That is load-bearing rather than
  // stylistic: the transcript reducer returns a NEW object whenever a block changes
  // (streaming text growing, `live` flipping at turn end) and the same object when it
  // does not. So a changed block simply has no usable height, is rendered in full, and
  // is re-measured — cache invalidation falls out of the data model instead of needing
  // a rule that could be forgotten for some future block type.
  //
  // A Map keyed by id rather than a WeakMap keyed by the object, for one reason: a
  // WeakMap cannot be iterated, and a resize needs to walk every height to rescale it
  // (see the width-change block below). The identity check gives the same invalidation
  // a WeakMap gave for free; `pruneHeights` gives the same bounded memory.
  /** `scaled` marks a height that was RESCALED by a width change rather than measured:
   *  good enough to size a spacer with, and still owed a real measurement. See the
   *  width-change branch in the render. */
  const blockHeights = useRef<Map<number, { height: number; block: Block; scaled?: boolean }>>(new Map());
  // Nodes captured this render, waiting to be measured once Yoga has laid them out.
  const toMeasure = useRef<Map<Block, DOMElement>>(new Map());
  // The width every cached height was measured at. A height is only true for one width.
  const heightsWidth = useRef(0);
  // Bumped when a measurement lands, purely to re-render so the new height can be
  // used. Never read.
  const [, bumpHeights] = useState(0);
  // Same idea, for the footer (status line / background bar / queued bar / input
  // box / command palette / tip). Its height genuinely changes — the command
  // palette alone is 5+ rows taller open than closed — and guessing it drifted
  // from reality exactly the way an unmeasured chat height once did: either
  // wasted space above the footer, or the footer's own bottom edge pushed past
  // the terminal, which corrupts the whole frame if that's the row that tips
  // outputHeight to stdout.rows. Measured, this can't drift.
  const footerRef = useRef<DOMElement | null>(null);
  /** The inline shell's whole live region, measured so the exit path knows how far the
   *  caret sits above the last row drawn. See exitCursor.ts. */
  const liveRef = useRef<DOMElement | null>(null);
  /** The chip's row WITHIN the live region, from the layout, or null when it is not up. */
  const pillRow = useRef<number | null>(null);
  /** The chip's cells in SCREEN coordinates, for the pointer handler. Null when there is
   *  nothing to click. Published by the render, read between frames. */
  const pillHit = useRef<PillBounds | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // The chat viewport's REAL height. Yoga decides it now (flexGrow beside a
  // flexShrink:0 footer); this is read back purely so the scroll maths knows how
  // much of the content is on screen.
  const chatRef = useRef<DOMElement | null>(null);
  const [chatHeight, setChatHeight] = useState(0);
  // Bumped by PromptInput when its suggestion menu changes size. Its only job is
  // to re-render App so the footer measurement below re-runs: the menu is
  // PromptInput's own state, so App is not re-rendered by it and would otherwise
  // keep sizing the chat against a footer that no longer exists — leaving the
  // menu clipped off the bottom of the frame with nothing to correct it.
  const [, bumpFooter] = useState(0);
  const onMenuChange = useCallback(() => bumpFooter((t) => t + 1), []);
  // Turn timing for the status line: when the current turn started, how long the
  // last one took, the token count, and which whimsical verb-pair this turn uses.
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [taskUsage, setTaskUsage] = useState<TaskUsage | null>(null);
  const turnStart = useRef<number | null>(null);
  // Token accounting for the status line. A task (one turn) may span several model
  // calls; we keep each call's REAL usage and fold it into a meaningful summary
  // (context size + cache-aware cost), not a raw sum of re-sent context — that sum
  // counted the cached prefix once per step and made every task look like ~700K.
  // Nothing is shown while working: mid-stream counts aren't reliable, and a
  // provider may not report usage until the turn ends.
  const usageSamples = useRef<Usage[]>([]);
  // Read live by the status line each tick. A getter rather than state so a usage event
  // does not force a re-render of the whole transcript — the line already re-renders
  // once a second for its timer, which is often enough for a running count.
  // The live figure the status line reads each tick. Held in a ref, and advanced by the
  // pure reducers in dynamo/liveMeter.ts, so a streamed delta does not re-render the
  // transcript just to move a number: the status line re-renders on its own timer and
  // reads the current value there.
  const meter = useRef<MeterState>(meterReset());
  const liveTokens = useCallback(() => meterValue(meter.current), []);
  const advanceTokens = useCallback(() => {
    meter.current = meterTick(meter.current);
  }, []);
  // Aborts the in-flight turn when the user presses Esc (created fresh per turn).
  const abortRef = useRef<AbortController | null>(null);
  // Which provider's key we still need, or null once we have it. Not a bare
  // boolean: with more than one provider, the key we must ask for depends on the
  // model the user is about to run, and switching models can make a different key
  // become the missing one.
  // Only when NOTHING can run. Asking about the default provider alone turned a key for
  // any of the other twelve into a dead end: a prompt the user never chose, with no way
  // There is no separate "paste this one provider's key" screen any more. It asked for
  // whichever provider happened to be configured, could not be escaped, and reappeared
  // after setup had already taken a key. Both jobs belong to screens that do them
  // properly: KeySetup on a first run, KeyManager for everything after.
  const [setupOpen, setSetupOpen] = useState(() => needsKeySetup(DEFAULT_MODEL_CONFIG.model, hasApiKey));
  // Where we are working is the widest permission there is — every other guard is scoped
  // to the workspace — so it is confirmed once, before anything else. See trust.ts.
  const { exit } = useApp();
  const startCwd = useRef(process.cwd());
  const [trustBreadth] = useState(() => rootBreadth(startCwd.current));
  const [trustOpen, setTrustOpen] = useState(() => !isTrusted(projectDir(startCwd.current), rootBreadth(startCwd.current)));
  // Bumped when a key is saved, so the list re-reads and marks it.
  const [, setSetupTick] = useState(0);
  // Opened by /key rather than by a first run, so Esc is a way back rather than a way out.
  // /key opens the key MANAGER — the keys you have, and what you can do to them.
  // Distinct from the first-run setup screen, which only ever needs to get one key in.
  const [keysOpen, setKeysOpen] = useState(false);
  const [keysTick, setKeysTick] = useState(0);
  // Opened by /mcp — the minitabs manager: a server list, and picking one drops into
  // everything you can do to it. Its own footer overlay, same shape as /key's.
  const [mcpOpen, setMcpOpen] = useState(false);
  /** Which MCP servers we hold a stored credential for. Read when the box opens rather
   *  than kept live: it changes only when someone signs in or out, both of which close
   *  the box, and each entry is a file read that has no business on a render path. */
  const [mcpSignedIn, setMcpSignedIn] = useState<ReadonlySet<string>>(() => new Set());
  // A /provider switch held back because that provider had no key. Finished the moment
  // one is saved for it, so choosing a provider and adding its key is one flow rather
  // than two commands with a dead end in between.
  const pendingSwitch = useRef<{ model: string; apiKeyEnv: string; label: string } | null>(null);
  // The keyboard belongs to a setup screen while one is open.
  const needsKey = setupOpen || keysOpen;
  // Sent-message history, oldest-first — walked with ↑/↓ in the input.
  const [history, setHistory] = useState<string[]>([]);
  // Which shell the app is wearing. See `screenMode.ts`; `/screen` switches it.
  //
  // State rather than a ref, because the render branches on it. The terminal side of the
  // switch — alternate screen, mouse, framebuffer — is applied by the effect below, not
  // here, so the escape codes never go out during a render.
  const [shell, setShell] = useState<ScreenMode>(() => initialScreen ?? startupMode());
  /**
   * Reading mode: the inline shell, scrolling with the prompt PINNED.
   *
   * The inline shell prints into the terminal's scrollback and the terminal owns the
   * wheel, so looking back at anything carries the prompt off the top of the screen
   * with everything else. That is how a shell prompt behaves and it is what the shell
   * is for — right up until you want to read the middle of a long answer and reply to
   * it, which is most of the time.
   *
   * A pinned prompt is normally something only a full-screen layout offers, because
   * pinning means owning the screen. Offering it here without owning the screen is what
   * this mode is, and it is built to cost nothing while it is not in use.
   *
   * While reading, the app renders a frame of its own into the live region and scrolls
   * INSIDE it — the same viewport, offset and measurement the full-screen shell uses,
   * with the footer pinned under it. Leaving it hands the terminal back.
   *
   * DERIVED from `scrollUp`, not its own state, and that is what fixes the flicker an
   * earlier version had. That version tracked reading separately and opened it with
   * `setReading(true)` followed by `setScrollUp(...)` — two calls, and Ink runs React
   * in LegacyRoot mode, where state updates outside a React event are NOT batched. Each
   * call flushed its own synchronous render: one frame painted with reading true and
   * `scrollUp` still at its old value (0, on the way in — the "at rest" shape), and the
   * very next painted the real scrolled position. Two different frames for one
   * keystroke is a flicker by definition, and the same shape hit on the way out — a
   * separate effect watched for `scrollUp` reaching 0 and called `setReading(false)` a
   * render late, so the screen showed the framed view sitting at the bottom for one
   * frame before dropping to the tail view.
   *
   * `scrollUp > 0` means the same thing `reading` did, computed in the SAME render as
   * the scroll position that decides it, in the same commit. Entering and leaving both
   * become the ordinary case of one state value changing once — no closing effect, no
   * second render, nothing for the terminal to paint twice.
   */
  const reading = shell === "inline" && scrollUp > 0;
  // Where the reprint starts, and how many blank rows go above it. Both are decided ONCE
  // when the inline shell is entered and then held: <Static> prints its items a single
  // time, so anything that changed between renders would either never be printed or be
  // printed twice.
  const reprintFrom = useRef(0);
  const startFill = useRef(0);
  // Bumped to remount <Static> when the inline shell is entered. See below.
  const [staticEpoch, setStaticEpoch] = useState(0);
  /**
   * A second remount counter, bumped DURING RENDER when the reading view closes.
   *
   * Separate from `staticEpoch` because of WHEN it changes, not what it means. The shell
   * switch can afford an effect; closing the reading view cannot — see the block that
   * writes this, next to the inline return.
   */
  const closeEpoch = useRef(0);
  /** The inline startup fill and the terminal height it was sized for. Declared here,
   *  above the effects that also seat the fill, so all of them share one basis and the
   *  render-phase grow does not re-fire on a switch that already sized it. See
   *  startupFill.ts. */
  const fillState = useRef(NO_FILL);
  /** Whether the inline reading view was open on the previous render — declared here,
   *  above the first-run gates, because a hook below them changes the hook count when a
   *  gate closes and React crashes the app. Its render-phase logic stays near the inline
   *  return. */
  const wasReadingInline = useRef(false);
  /** How far <Static> was allowed to reach while the reading viewport is open, or null
   *  when closed. Declared above the gates for the same reason as wasReadingInline. */
  const frozenStatic = useRef<number | null>(null);
  /**
   * Whether a `<Static>` remount should reprint the one-time header.
   *
   * True for a remount that is replacing a screen the header is genuinely absent from —
   * arriving from the full-screen shell, whose alternate buffer discarded it. False for
   * one that is only refilling rows below a header still sitting in scrollback, where
   * printing it again would put a second banner in the middle of the conversation.
   */
  const showHeader = useRef(true);
  const shellBefore = useRef<ScreenMode | null>(null);
  useEffect(() => {
    applyScreenMode(shell);
    // Arriving in the inline shell from the other one, the conversation so far has to be
    // REPRINTED, and nothing else will do it.
    //
    // Ink's <Static> keeps a count of how many items it has already emitted and renders
    // only `items.slice(index)` — printed once is its whole contract. Every one of those
    // items was written into the ALTERNATE screen buffer, which leaving just discarded.
    // So the terminal came back to the primary buffer holding whatever was there before
    // the session started, and the transcript existed only in a counter's memory: no
    // banner, no history, and nothing to scroll back to.
    //
    // A new key remounts it, which resets that counter to zero and prints the whole list
    // into the buffer the user is actually looking at. Only on the transition, never on
    // first mount — there, <Static> has printed nothing yet and remounting would emit
    // every block a second time.
    if (shell === "inline" && (shellBefore.current === null || shellBefore.current !== shell)) {
      // Only the RECENT conversation is reprinted, not the whole session.
      //
      // Everything printed while fullscreen went into the alternate screen buffer and is
      // gone whatever we do; reprinting all of it costs about 1.7ms a block, measured, so
      // a long session spent a third of a second on a blank screen printing scrollback
      // nobody asked to see. A couple of screens is all that can be looked at anyway.
      reprintFrom.current = Math.max(0, committed.length - INLINE_REPRINT_BLOCKS);
      // Blank rows so the conversation lands at the BOTTOM of the screen rather than the
      // top. A terminal prints from wherever the cursor is, which after leaving the
      // alternate screen is wherever the shell left it — usually near the top, with the
      // prompt then floating in the middle of an empty window. These push it down. They
      // are printed ONCE, into scrollback, so they cost nothing after the first screen
      // and disappear the moment there is enough conversation to fill it.
      startFill.current = Math.max(0, rows - INLINE_LIVE_RESERVE);
    fillState.current = { fill: startFill.current, basis: rows };
      // Keep the render-phase grow in step, so it does not treat this as a fresh void.
      fillState.current = { fill: startFill.current, basis: rows };
      // This reprint IS replacing a discarded screen, so it owns the header.
      showHeader.current = true;
    }
    if (shellBefore.current !== null && shellBefore.current !== shell && shell === "inline") {
      setStaticEpoch((n) => n + 1);
    }
    shellBefore.current = shell;
  }, [shell]);



  // Messages typed while Mindweave is working — the input stays live. Ordinary prose is
  // handed to the RUNNING turn at its next step boundary; a slash command, and anything
  // typed after Esc, waits for the turn to be over. See messageQueue.ts.
  const queueRef = useRef<Queued[]>([]);
  const [queued, setQueued] = useState<Queued[]>([]);
  // Esc has been pressed and the turn is still winding down. Anything typed in that gap
  // belongs to the NEXT turn: steering it would carry out a correction inside the very
  // turn the user just stopped. Cleared when the next turn starts.
  const interrupting = useRef(false);
  // An interactive overlay (session picker, model/think chooser, or an approval
  // prompt). When set, it owns the keyboard and the input box is hidden.
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  // Set while a command that opens one of those surfaces is on its way, so the box that
  // holds them stays on screen for the gap between the command list closing and the
  // surface appearing. See `OVERLAY_COMMANDS`.
  const [opening, setOpening] = useState(false);

  // The approval channel handed to tools: a forbidden-path tool calls this to ask
  // the user Yes/No/other, and we render it as an overlay that resolves the promise.
  // A ref so the function injected into a session's tool context always reaches the
  // current setOverlay (and survives session swaps on /continue).
  //
  // `detail` (a plan, a long command) is printed into the TRANSCRIPT rather than the
  // prompt. The prompt lives in the footer, which is not height-bounded: a long one
  // makes the whole frame taller than the terminal, and at that point Ink stops
  // erasing correctly and the screen tears (see the frameHeight comment below). The
  // transcript is the part of the UI already built to hold arbitrary length — it is
  // clipped and scrollable — so long context goes there and the prompt stays one line.
  // Approvals WAIT FOR EACH OTHER rather than replacing each other. The rules and the
  // reasons live in approvalChannel.ts, where they can be tested directly; this holds
  // one instance for the session and keeps the visible slot in sync with it.
  const approvals = useRef(new ApprovalChannel<Overlay>());
  const showNextApproval = useRef(() => {
    setOverlay((current) => current ?? approvals.current.current);
  });
  const askApproval = useRef((
    question: string,
    options: string[],
    detail?: string,
    detailTitle?: string,
    freeText?: { label: string; placeholder: string },
  ) => {
    const body = detail?.trim();
    if (body) {
      // Titled → a facts block on a rail, rendered verbatim (a command must not be
      // reinterpreted as markdown). Untitled → prose, because it is a document to read.
      dispatch(detailTitle ? { type: "notice", title: detailTitle, body } : { type: "say", text: body });
    }
    const answer = approvals.current.ask({
      kind: "approval",
      question,
      options,
      // Answered through the channel, never by calling this directly — that is what
      // keeps "exactly once" and the queue order in one place.
      resolve: () => {},
      ...(freeText ? { freeText } : {}),
    } as Overlay);
    showNextApproval.current();
    return answer;
  });
  // Bumped whenever a background shell starts/finishes, to re-render the indicator.
  const [bgTick, setBgTick] = useState(0);
  // Guards the idle auto-react so a flurry of changes can't kick overlapping turns.
  const reactingRef = useRef(false);

  // ── Transcript helpers ──────────────────────────────────────────────────────
  // A dim meta line (a tool-less note / command header); `error` flags it red,
  // `context` sets it off as housekeeping (compaction / context trimming).
  const note = (text: string, opts?: { error?: boolean; context?: boolean }) =>
    dispatch(
      opts?.context ? { type: "context", text } : opts?.error ? { type: "error", text } : { type: "note", text },
    );
  // A spoken block: a ⚠-prefixed line is an error, everything else is markdown.
  const say = (text: string) => dispatch(text.startsWith("⚠") ? { type: "error", text } : { type: "say", text });
  // Alias kept so the command handlers below read unchanged.
  const addTool = note;

  // Rebuild the visible transcript from a (resumed) session by replaying it through
  // the SAME reducer actions the live stream uses — so a resumed chat shows the
  // exact rows it did before: user/assistant prose, every `● Tool(arg)` with its
  // `⎿` result/diff, the consolidated discovery groups, and a marker where context
  // was summarized. The tool display fields (summary/detail/detailKind/isError) were
  // stored on each tool entry at run time, so nothing about a row is lost across a resume.
  //
  // `detailKind` used to be missing from that list while this comment already claimed
  // the rows came back identical. They did not: the diff text survived and the fact that
  // it WAS a diff did not, so every resumed edit rendered as dim plain lines. Anything
  // added to a row's appearance has to be stored here too, or the claim above quietly
  // stops being true again.
  function showResumed(transcript: Entry[]) {
    for (const e of transcript) {
      if (e.role === "user") {
        // Engine nudges ride as `user` messages so the model reads them as instruction,
        // but they are ours, not the person's. Replaying one draws it as a `>` prompt
        // the user never typed — seen live as "> That was 3 sentences between tool
        // calls…" sitting in their own chat history.
        if (!e.synthetic) dispatch({ type: "user", text: collapsePastes(stripAttachments(e.content)) });
      } else if (e.role === "summary") {
        dispatch({ type: "note", text: "— resumed; earlier context summarized —" });
      } else if (e.role === "assistant") {
        // Narration came before the tools in the live turn, so seal it first, then
        // re-announce each tool call exactly as streamRespond does.
        // Same cut as the live path: prose that precedes tool calls is narration,
        // and a resumed chat must not print the essays the live one trimmed away.
        if (e.content.trim()) {
          const intermediate = (e.toolCalls?.length ?? 0) > 0;
          dispatch({ type: "say", text: intermediate ? trimNarration(e.content) : e.content });
        }
        for (const call of e.toolCalls ?? []) {
          // The spawn itself is drawn by its sub-agent block live, never as a raw row.
          // Replaying it as one puts a `● SpawnSubagent(...)` in a resumed transcript
          // that was not in the live one.
          if (call.name === "spawn_subagent") continue;
          const d = toolDisplay(call.name, parseToolArgs(call.arguments));
          dispatch({
            type: "toolStart",
            toolId: call.id,
            name: d.name,
            arg: d.arg,
            ...(d.meta ? { meta: d.meta } : {}),
            action: d.kind,
            group: isGroupable(call.name),
            ...(d.covers ? { covers: d.covers } : {}),
          });
        }
      } else {
        // A tool result resolves its row/group item, mirroring the live toolEnd.
        dispatch({
          type: "toolEnd",
          toolId: e.toolCallId,
          ok: e.isError === undefined ? !e.content.startsWith("Error:") : !e.isError,
          summary: e.summary,
          detail: e.detail,
          ...(e.detailKind ? { detailKind: e.detailKind } : {}),
          ...(e.quiet ? { quiet: true } : {}),
          ...(e.displayName ? { name: e.displayName } : {}),
          ...(e.displayKind ? { action: e.displayKind } : {}),
          ...(e.awaitsModel ? { awaitsModel: true } : {}),
        });
      }
    }
    // Close any discovery group left open at the end so it commits to scrollback.
    dispatch({ type: "sealNarration" });
    // Every replayed row belongs to a turn that finished long ago, so settle the
    // verbs. Without this a resumed chat opens with "Updating(App.tsx)" over an edit
    // that completed in a previous session — present tense claiming work is in
    // flight when nothing is running at all.
    dispatch({ type: "endTurn" });
  }

  // Parse a stored tool call's raw JSON arguments for display; malformed → {}.
  function parseToolArgs(raw: string): Record<string, unknown> {
    try {
      const p = raw ? JSON.parse(raw) : {};
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  // Called by the background-shell manager on any change: refresh the UI and surface
  // a one-line note for each shell that just finished.
  function handleBgChange() {
    setBgTick((t) => t + 1);
    const mgr = session.current?.toolContext.backgroundShells;
    for (const { info: sh, kind } of mgr?.takeUiEvents() ?? []) {
      // A shell reaching "ready" says nothing the tool row did not already say when it
      // backgrounded the command, and being killed at the user's request is not news
      // either — they asked for it. A command that DIED ON ITS OWN is news, because
      // nothing else on screen would tell them their dev server had fallen over.
      if (kind === "ready") continue;
      // The watchdog flagged a running shell as stuck — a prompt it is blocked on, or a
      // long silence on a command that should be working. Worth a line: otherwise it sits
      // invisible until it times out.
      if (kind === "stalled") {
        const why = sh.stallReason === "prompt" ? "waiting for input?" : "no output for a while — stuck?";
        addTool(`shell #${sh.id} (${clipCmd(sh.command)}) ${why}`, { error: true });
        continue;
      }
      if (sh.status === "killed" && sh.stoppedBy === "user") continue;
      const verb = sh.status === "killed" ? "killed" : `finished — exit ${sh.exitCode}`;
      addTool(`shell #${sh.id} (${clipCmd(sh.command)}) ${verb}`, { error: sh.status !== "killed" && sh.exitCode !== 0 });
    }
  }

  // A server's state moved. Repaint, and surface anything the pool needs the user to
  // know exactly once — chiefly a tool blocked because its description changed, which
  // would otherwise show up only as a silently shorter tool list.
  function handleMcpChange() {
    setBgTick((t) => t + 1);
    for (const notice of session.current?.toolContext.mcp?.takeNotices() ?? []) note(notice);
  }

  function attachApproval(s: Session) {
    s.toolContext.requestApproval = (q, o, detail, title, freeText) =>
      askApproval.current(q, o, detail, title, freeText);
    // Same stop Esc performs. A tool reaches for this when the USER has said, by
    // dismissing a question, that the work should not carry on without them.
    s.toolContext.interrupt = () => abortRef.current?.abort();
    s.toolContext.backgroundShells?.setOnChange(handleBgChange);
    // Servers connect in the background and can die or revive at any time; without this
    // the /mcp view would only ever show what was true when the last key was pressed.
    s.toolContext.mcp?.setOnChange(handleMcpChange);
    // A new/swapped session inherits the current mode's behavior.
    const m = modeById(modeRef.current);
    s.toolContext.planMode = m.readOnly;
    s.toolContext.guarded = m.guarded;
    s.toolContext.guardAllowed = undefined;
    // exit_plan moves these flags mid-turn when a plan is approved, and the engine
    // moves them back when the turn ends. The indicator has to follow, or it would
    // claim the session is still planning while it is carrying the plan out. Modes
    // stay a client concept: the flags are read back and named here, never there.
    s.toolContext.onModeChange = () => {
      const id = modeFromFlags(s.toolContext);
      // Both, like applyMode does: the ref is what a session swap reads back, so
      // updating only the rendered state would restore the pre-approval mode later.
      modeRef.current = id;
      setMode(id);
    };
  }

  // Switch interaction mode (shift-tab). Updates the indicator and the flags the
  // engine reads (planMode / guarded) so the next turn respects it immediately.
  function applyMode(id: ModeId) {
    modeRef.current = id;
    setMode(id);
    const m = modeById(id);
    const s = session.current;
    if (s) {
      s.toolContext.planMode = m.readOnly;
      s.toolContext.guarded = m.guarded;
      // Entering Sentinel restores fresh vigilance — earlier grants are cleared.
      if (m.guarded) s.toolContext.guardAllowed = undefined;
    }
    // No scrollback line on a mode switch — the ModeBar under the chat already shows
    // the current mode and updates in place, so cycling doesn't flood the transcript.
  }

  // Large pastes are shown as `[Pasted text #N +M lines]` chips; the real content
  // is stashed here (keyed by chip) and restored into the model message on send.
  const pasteStore = useRef(new Map<string, string>());
  const pasteSeq = useRef(0);
  function registerPaste(content: string): string {
    const lines = content.split("\n").length;
    // Multi-line pastes read best as "+M lines"; a long single-line paste as "+K chars".
    const size = lines > 1 ? `+${lines} lines` : `+${content.length} chars`;
    const chip = `[Pasted text #${++pasteSeq.current} ${size}]`;
    pasteStore.current.set(chip, content);
    return chip;
  }
  function expandPastes(text: string): string {
    let out = text;
    for (const [chip, content] of pasteStore.current) {
      if (out.includes(chip)) out = out.split(chip).join(wrapPastedText(content));
    }
    return out;
  }

  // The same trade for dropped files: the buffer holds `mwimg1`, this holds the path it
  // stands for. Resolution against the session's cwd happens here so the store is keyed
  // by one canonical form however the path was spelled when it landed.
  const dropHandles = useRef(
    createDropHandles((p) => (isAbsolute(p) ? resolve(p) : resolve(session.current?.cwd ?? process.cwd(), p))),
  );

  // File-path completion for the input's `@mention` picker (primary root).
  const pathComplete = useRef((prefix: string) => {
    const s = session.current;
    return s ? completePath(s.cwd, prefix) : Promise.resolve<string[]>([]);
  });

  // Live terminal width — drives message wrapping (Static items capture it at
  // commit time; the live input reflows on resize for free).
  // The inline shell defers a resize until the drag settles; the full-screen one takes
  // it immediately. See useTerminalSize for why the two differ.
  const { columns: width, rows } = useTerminalSize(shell === "inline");
  // Read live at render time as well as from the polled state above: mid-resize
  // the state can lag the real terminal by a tick, and a frame one row too TALL
  // is the failure that corrupts the screen (see the layout comment below).
  const { stdout } = useStdout();

  // A width change in the inline shell: reprint, rather than trust the erase.
  //
  // Ink redraws its live region by erasing the number of LINES it last wrote. After a
  // resize that number is wrong — the same content wraps differently at the new width, and
  // the terminal has reflowed what was already on screen — so it erases too few and leaves
  // half of the old region behind: a second status line, a fragment of the input box's
  // border, a ladder of them down a slow drag.
  //
  // Predicting the right number means predicting the post-resize wrapping of everything on
  // screen, which is the layout itself. So it is not predicted. The region is printed
  // again, below the mess, with the usual fill above it — the stale copy goes up into
  // scrollback where it belongs and the screen comes back clean with the conversation at
  // the bottom. A resize is rare enough to pay for that.
  //
  // Only on WIDTH. Height changes do not re-wrap anything, and reprinting on one would
  // fire on every vertical drag for nothing.
  const widthBefore = useRef(width);
  useEffect(() => {
    if (widthBefore.current === width) return;
    widthBefore.current = width;
    if (shell !== "inline") return;
    reprintFrom.current = Math.max(0, committed.length - INLINE_REPRINT_BLOCKS);
    startFill.current = Math.max(0, rows - INLINE_LIVE_RESERVE);
    setStaticEpoch((n) => n + 1);
  }, [width, shell]);

  // One session for the whole conversation (a ref so it survives re-renders).
  const session = useRef<Session | null>(null);

  useEffect(() => {
    // A relaunch after `/update` opens on the conversation it left. A resume that does
    // not work out — an id that names nothing, a session file that will not load —
    // falls through to a normal start rather than refusing to open: the point of the
    // whole mechanism is that an update costs you nothing, and failing to come up at
    // all is the one outcome worse than losing the thread. `/continue` still reaches it.
    const open = resumeSessionId
      ? resumeSession(process.cwd(), resumeSessionId).then((s) => s ?? createSession())
      : createSession();
    open.then((s) => {
      attachApproval(s);
      session.current = s;
      setReady(true);
      if (resumeSessionId && s.id === resumeSessionId) {
        showResumed(s.transcript);
        note(`— updated to v${appVersion()}, continuing —`);
      }
      // The project may have a model saved from a different provider than the
      // default, so re-check against what we're actually about to run.
      const cur = session.current;
      if (!cur) return;
      const need = missingKeyFor(cur.modelConfig.model);
      if (!need) return;
      // A saved config can outlive the key that made it usable. Rather than open
      // straight into an inescapable prompt, fall back to a provider we can actually
      // run and say so — the user can always pick again with /provider.
      const fallback = usableFallback(cur.modelConfig.model, hasApiKey);
      if (fallback) {
        void switchTo(fallback, providerOf(fallback).label).then(() =>
          note(`no ${need.label} key yet — using ${providerOf(fallback).label} instead. /provider to change.`),
        );
        return;
      }
      // Nothing can run at all: open setup, which is the screen for exactly that.
      void need;
      setSetupOpen(true);
    });
  }, []);

  // Anonymous usage ping — on by default. The status line shows every launch, not just
  // the first one; the full explanation lives in the /analytics box itself.
  useEffect(() => {
    note(startupStatusLine());
    sendAnalyticsPing(appVersion());
  }, []);

  // A quiet, backgrounded check for a newer release — independent of session startup so a
  // slow or unreachable registry can never delay the first prompt. checkForUpdate() is
  // itself the one that fails silent on every network path; a note only appears when a
  // genuinely newer version is confirmed.
  useEffect(() => {
    void checkForUpdate().then((latest) => {
      if (!latest) return;
      note(`update available: v${appVersion()} → v${latest} — /update to take it`);
    });
  }, []);

  // When a background shell finishes and Mindweave is idle, react to it automatically.
  // `modalOpen` is a dependency on purpose: an open menu holds the wake back, and closing
  // it has to re-run this check or the finished command waits for some unrelated render.
  const modalOpen = overlay !== null || mcpOpen || trustOpen || needsKey;
  useEffect(() => {
    const mgr = session.current?.toolContext.backgroundShells;
    const wake = shouldReactToBackground({
      ready,
      busy,
      needsKey,
      reacting: reactingRef.current,
      modalOpen,
      pending: mgr?.pendingCount() ?? 0,
    });
    if (wake) void reactToBackground();
  }, [bgTick, busy, ready, needsKey, modalOpen]);

  // When the turn ends, send what's queued — CONSECUTIVE plain messages together, as
  // one turn (see messageQueue.ts for why), a slash command on its own. Chains: each
  // send ends, this fires again, until the queue is empty.
  useEffect(() => {
    if (busy || !ready || needsKey || overlay) return;
    const next = drainQueue(queueRef.current);
    if (!next) return;
    queueRef.current = next.rest;
    setQueued(next.rest);
    void handleSubmit(next.send, { arrival: next.priority === "now" ? "interrupting" : undefined });
  }, [busy, ready, needsKey, overlay]);

  // ↑ or Esc takes the queue back into the input box, editable, and empties it. This
  // is the ONLY way to change your mind about something already queued, so it has to
  // work while Mindweave is still working — that is the whole moment it is for.
  //
  // Esc is the exception, and deliberately so: while a turn is running Esc means STOP,
  // and a keypress that both stopped the turn and silently emptied the queue would be
  // two decisions on one key. So mid-turn Esc is declined here and the interrupt
  // handler above has it alone. ↑ has no such conflict and always pops.
  const popQueue = useCallback(
    (input: string, cursor: number, via: "up" | "escape") => {
      if (via === "escape" && busy) return undefined;
      const popped = popAllQueued(queueRef.current, input, cursor);
      if (!popped) return undefined;
      queueRef.current = [];
      setQueued([]);
      return popped;
    },
    [busy],
  );

  // Start/stop a turn's timer (drives the persistent status line).
  function startTurn() {
    turnStart.current = Date.now();
    usageSamples.current = [];
    meter.current = meterReset();
    setTaskUsage(null); // clear the previous task's summary while this one runs
    interrupting.current = false;
    abortRef.current = new AbortController();
    setBusy(true);
  }

  // Esc interrupts the current turn: it aborts the model call AND kills a running
  // command — run_command listens to this same signal (see runShell), so a hung
  // command (e.g. an installer waiting on a GUI) can no longer freeze the agent.
  /**
   * Ctrl+C quits, all the way.
   *
   * Ink no longer does anything with it (`exitOnCtrlC: false` in index.ts), because what
   * it did was unmount and stop there: the process stayed up with the turn still running,
   * and the two `exit` hooks that matter — restoring the terminal, and synchronously
   * killing background shells — never ran, because nothing exited.
   *
   * `process.exit` is what runs them. 130 is the conventional code for a program ended by
   * SIGINT, so a shell script wrapping this reads the interruption correctly.
   *
   * Esc remains the way to stop a TURN without leaving. This is the way to leave.
   *
   * EXCEPT while a selection is on screen. The app owns the mouse in the full-screen
   * shell, so text is selected by dragging and Ctrl+C is the reflex to copy it — and
   * quitting on that reflex, right after someone highlighted something to keep, loses
   * both the selection and the session. So a Ctrl+C with a highlight up COPIES it (the
   * drag already did on release; this re-copies so the keystroke is never a no-op) and
   * takes the highlight down, and does not quit. With nothing selected it quits as
   * before — so a second Ctrl+C, once the highlight is gone, still leaves.
   */
  useInput(
    (input, key) => {
      if (!key.ctrl || input !== "c") return;
      const sel = selection.current;
      if (ctrlCShouldCopy(sel)) {
        const screen = latestScreen();
        if (screen) copyToClipboard(selectionText(screen, sel));
        clearSelection();
        return;
      }
      abortRef.current?.abort();
      process.exit(130);
    },
    { isActive: true },
  );

  // Only while working AND no overlay is open (an open Picker owns Esc for its own
  // cancel). The input ignores Esc, so typing-while-busy is safe.
  useInput(
    (_input, key) => {
      if (key.escape) {
        abortRef.current?.abort();
        // From here until the next turn starts, anything typed is for the NEXT turn.
        interrupting.current = true;
        // Anything still waiting to be asked is answered as declined. A queued approval
        // has no overlay to press Esc on, so without this the tool holding it would wait
        // for the rest of the session on a question the user has already stopped.
        approvals.current.dismissWaiting(APPROVAL_DISMISSED);
        // Esc means STOP — including anything running in the background (a starting app,
        // a dev server). Aborting the turn alone left those alive, so the app still opened.
        const mgr = session.current?.toolContext.backgroundShells;
        for (const sh of mgr?.running() ?? []) mgr?.kill(sh.id, "user");
        flush.current = true; // drain the rest of the queue immediately
        // A held-but-unsettled group (see pump()) waits for the NEXT enqueued
        // action to notice anything changed — nothing schedules a timer while
        // holding any more. If this was the interrupt that ends the turn with
        // no further engine events coming, that held group would otherwise
        // never get released. Nudging pump() here costs nothing when there's
        // nothing held (it's a no-op on an empty queue) and closes that gap.
        pump();
        // No "stopped." line. The spinner stops, the turn ends and the prompt comes
        // back — the screen already answers the keypress, and saying it again is one
        // more line of the app talking about itself.
      }
    },
    { isActive: busy && overlay === null },
  );

  // shift-tab cycles the interaction mode (Lightning ⇄ Architect). Active whenever
  // the input owns the keyboard (no overlay); takes effect from the next turn.
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) applyMode(nextMode(modeRef.current));
    },
    { isActive: ready && overlay === null },
  );

  // Scrolling the transcript. The alternate screen keeps no scrollback of its
  // own, so without this there is no way to look at anything that has left the
  // viewport. Moves by blocks rather than lines: a block is the unit the
  // transcript is made of, so a step never lands halfway through a diff.
  // Scrolls by LINES. The clamp to the content's real height happens at render,
  // where that height is known, so this only has to refuse to go below zero.
  //
  // APPLIED IMMEDIATELY, and that is a decision, not an omission. (An earlier comment
  // here described an eased version and a `smoothScroll.ts` that no longer exists —
  // left behind when the easing was removed, and exactly the kind of stale claim that
  // sends the next reader looking for a file that is not there.)
  //
  // An eased version was built and shipped (200ms ease-in-out) and it was WORSE,
  // immediately and obviously: a mouse wheel sends notches faster than 200ms apart, so
  // every notch queued behind the last one and the view visibly trailed the wheel.
  // Easing suits a scroll the PROGRAM initiates — jump to top, jump to a match — where
  // the animation explains a movement the user did not make. A wheel notch is a direct
  // manipulation, and direct manipulation must be 1:1
  // with the input or it reads as lag, because it IS lag. Do not re-add it here.
  //
  // CLAMPED AT BOTH ENDS, and the top one is not cosmetic. `chatLayout` clamps for
  // DISPLAY, so scrolling up past the first line looked like it had stopped while the
  // counter kept climbing — and every one of those phantom lines then had to be
  // scrolled back down before the view moved at all. A flick or two past the top bought
  // a second of a wheel that did nothing, which reads as the app having frozen.
  const scrollBy = useCallback((lines: number) => {
    // Repaint the whole next frame. A scroll can move a row out from under the
    // framebuffer's model (see requestFullRepaint), which is what left a transcript row
    // stranded on the pinned banner; a scroll already redraws almost every visible row, so
    // redrawing the stable ones on top is nearly free and stops that.
    requestFullRepaint();
    setScrollUp((s) => Math.max(0, Math.min(maxScrollRef.current, s + lines)));
  }, []);

  /**
   * Open the inline shell's reading view, moving by `lines` in the same gesture.
   *
   * ONE state change, `scrollUp` alone — `reading` is derived from it, so this cannot
   * reintroduce the two-render flicker a separate `setReading(true)` used to cause.
   *
   * UNCLAMPED, and that half has to stay. `maxScrollRef` is published by the render,
   * and until this frame exists there is no viewport, nothing measured, and the last
   * value it holds is zero. Routed through `scrollBy`, the very first notch would
   * therefore be clamped to nothing — `reading` would compute false, and the wheel
   * would appear to do nothing at all.
   *
   * Overshooting is the safe direction and it is self-correcting: `chatLayout` clamps
   * for display, so the frame shows the top rather than anything invalid, and the next
   * notch goes through `scrollBy` with a real measurement and pulls the number back to
   * what actually exists.
   */
  const openReading = useCallback((lines: number) => {
    setScrollUp((s) => Math.max(1, s + Math.abs(lines)));
  }, []);

  useInput(
    (_input, key) => {
      // In the inline shell, scrolling back is a MODE, and any of these opens it.
      //
      // Nothing below can do anything until the app is drawing its own frame — the
      // inline shell has no viewport to offset — so the first press has to build one.
      // The scroll it was asking for then happens in the same keystroke, because a key
      // that only "gets ready" and moves nothing reads as a key that did nothing.
      const back = key.pageUp || (key.upArrow && key.shift);
      if (shell === "inline" && back && !reading) {
        // Same first-notch problem the wheel has: there is no viewport yet, so nothing
        // is measured and a clamped scroll would move nothing. See openReading.
        openReading(key.pageUp ? PAGE_LINES : 1);
        return;
      }

      // Shift+arrows as well as PageUp/PageDown: Windows consoles routinely eat
      // the paging keys before an app sees them, so there has to be a second way in.
      if (key.pageUp) scrollBy(PAGE_LINES);
      else if (key.pageDown) scrollBy(-PAGE_LINES);
      else if (key.upArrow && key.shift) scrollBy(1);
      else if (key.downArrow && key.shift) scrollBy(-1);
      // Back to the newest in one keystroke, and back to the start of the conversation
      // in the other. Without these, the only way out of a long scroll was to scroll
      // the whole distance again by hand — and the chip that appears while scrolled
      // back (see scrollPill.ts) names ctrl+End, so this is the half that makes the
      // chip true. CTRL is what keeps them off the input: plain End and Home belong to
      // the caret, whether or not the input claims them yet.
      else if (key.end && key.ctrl) { requestFullRepaint(); setScrollUp(0); }
      else if (key.home && key.ctrl) { requestFullRepaint(); setScrollUp(maxScrollRef.current); }
    },
    { isActive: ready && overlay === null },
  );

  // Leaving the reading view when it reaches the bottom needs no effect of its own:
  // `reading` is `scrollUp > 0`, so landing on zero — the wheel, the keys, ctrl+End, or
  // a sent message snapping the view back before it delivers — closes it in the same
  // render that moved the scroll, not a render later. See the derivation above for why
  // a separate effect here was the other half of the flicker.

  /**
   * The wheel, for as long as the reading view is up.
   *
   * ON FOR THE WHOLE INLINE SESSION, not only while the reading view is up, and the
   * reason is that the wheel is how anyone actually scrolls.
   *
   * Reporting is what makes a wheel notch reach this process at all. Switched on only
   * once reading had already started, the gesture that starts reading could never be the
   * wheel — the first notch went to the terminal, which scrolled its own buffer and
   * carried the prompt off the top, which is the whole thing being fixed. There is no
   * way to watch for a wheel notch without taking the wheel.
   *
   * So the trade is made openly: while an inline session is running, the terminal's own
   * wheel scrolls nothing and this app scrolls instead. Its scrollbar still drags and
   * Shift still selects, both being the terminal's own doing, and everything printed is
   * still in the terminal's scrollback where it has always been.
   *
   * The full-screen shell is untouched here: it takes the mouse through
   * `applyScreenMode`, which is also what releases it on the way into this one — so this
   * effect runs after that release and is what puts it back for the inline shell.
   */
  useEffect(() => {
    if (shell !== "inline") return;
    const off = enableMouse();
    return () => off();
  }, [shell]);

  // Leaving the reading view needs no reprint, and an earlier version of this that
  // forced one is what actually caused the reported flicker — a full transcript area
  // going black for a frame, footer untouched, right at the instant the view landed on
  // the bottom.
  //
  // The reasoning that led there was borrowed from the wrong case. Coming back from the
  // FULL-SCREEN shell genuinely needs a reprint: everything <Static> had printed went
  // into the ALTERNATE screen buffer, which leaving it discards outright — nothing of
  // it survives in the terminal the user is now looking at. The reading view never
  // leaves the primary buffer at all. Every line it ever showed was already sitting in
  // real scrollback the moment <Static> printed it, before reading even opened, and nothing
  // about opening or closing the reading frame touches that. Shrinking the live region
  // from the frame's height back down to the ordinary tail is exactly the same erase the
  // live region already goes through many times an ordinary conversation — a reply
  // finishing and its block draining into <Static> shrinks the tail the same way, with
  // no special handling, because Ink's own line-count bookkeeping is what makes an
  // ordinary shrink safe.
  //
  // What the reprint bought instead was a REMOUNT: a new `<Static>` key forces every
  // held item — up to `INLINE_REPRINT_BLOCKS` of them, full diffs, syntax highlighting
  // and all — to be laid out and printed again, all in the same instant the frame is
  // already shrinking. That is real, synchronous work sitting between the erase and the
  // redraw, for content the terminal already had. Removed rather than budgeted, since
  // there was never a hole here to fill.

  // Reading mode belongs to the inline shell alone: the full-screen one is always
  // drawing its own frame, so there is no mode to be in.
  const readingInline = shell === "inline" && reading;

  /**
   * Where "new since you scrolled away" counts from.
   *
   * Set on the frame the view leaves the bottom and cleared the moment it returns, so
   * a reader who scrolls back, reads, and comes back down starts the next scroll with
   * a clean count rather than one carried over from the last.
   *
   * Depends on `scrollUp` alone. The transcript's own id is read at effect time, which
   * is after the render that moved the view — the same frame, nothing appended in
   * between, so the mark is exactly the newest block the reader had seen.
   *
   */
  useEffect(() => {
    if (scrollUp === 0) scrollMark.current = null;
    else if (scrollMark.current === null) scrollMark.current = stateRef.current.seq;
  }, [scrollUp]);

  // Measure the transcript's real rendered height after every render. Deliberately
  // has no dependency list: the height changes for reasons no dep could name — a
  // reply landing, a terminal resize re-wrapping every paragraph — and the guard
  // below means a render that changed nothing sets no state, so this settles
  // rather than looping.
  useEffect(() => {
    if (!contentRef.current) return;
    const { height } = measureElement(contentRef.current);
    setContentHeight((h) => (h === height ? h : height));
    // A resize re-wrapped the transcript and this is the first real height for the new
    // width, so the reading position recorded above can now be converted into a line
    // count that means the same thing. Cleared immediately: this must happen once per
    // resize, not on every measurement afterwards.
    const from = reflowFrom.current;
    if (from) {
      reflowFrom.current = null;
      const next = reflowScroll(from.scrolled, from.maxScroll, Math.max(0, height - chatRows));
      setScrollUp((s) => (s === next ? s : next));
    } else if (prevContentHeight.current !== null) {
      // Ordinary growth, not a resize — see growScroll for why this has to hold the
      // reader's absolute position rather than leave `scrollUp` where it was.
      const prev = prevContentHeight.current;
      const next = growScroll(scrollUp, prev, height);
      if (next !== scrollUp) setScrollUp(next);
    }
    prevContentHeight.current = height;
  });

  // Measure each block that was rendered without a known height yet, so the next
  // frame can replace it with an exact spacer when it scrolls out of view.
  //
  // No dependency list, for the same reason as the measurements around it: a block's
  // height changes for reasons no dep could name. It settles rather than looping
  // because a height is recorded once per block object and the re-render is only
  // requested when something was actually recorded.
  useEffect(() => {
    if (toMeasure.current.size === 0) return;
    let learned = false;
    for (const [block, node] of toMeasure.current) {
      // A block that is still OPEN is deliberately not recorded.
      //
      // Its content changes on every delta, so the reducer hands back a new object each
      // time and the height taken a moment ago is already wrong. Recording it anyway
      // cost a measurement AND a re-render per delta — the state bump below — which on
      // a streaming reply is the hottest path in the app. An open block is always the
      // last one, so leaving it out of the table costs a single block laid out in full.
      if (!block.done) continue;
      // The same rule the ref callback used to queue it, so the two can never disagree
      // about what still owes a measurement. See blockHeights.needsMeasure.
      if (!needsMeasure(blockHeights.current.get(block.id), block)) continue;
      const { height } = measureElement(node);
      // A height of 0 is not a measurement, it is a block that has not been laid out
      // yet. Recording it would collapse the block to nothing the moment it scrolled
      // off — the exact class of silent, permanent corruption this cache must not have.
      if (height > 0) {
        blockHeights.current.set(block.id, { height, block });
        learned = true;
      }
    }
    toMeasure.current.clear();
    // Only when something was actually recorded, which is now once per block rather
    // than once per delta: a height that nothing can use is not worth a frame.
    if (learned) {
      pruneHeights(blockHeights.current);
      bumpHeights((t) => t + 1);
    }
  });

  // Same measurement, for the footer — see footerHeight above.
  useEffect(() => {
    if (!footerRef.current) return;
    const { height } = measureElement(footerRef.current);
    setFooterHeight((h) => (h === height ? h : height));
  });

  // And for the chat viewport. Unlike the footer's, this measurement is not part
  // of any layout decision — it only tells the scroll maths how many rows are
  // visible, so a one-frame lag here is invisible.
  useEffect(() => {
    if (!chatRef.current) return;
    const { height } = measureElement(chatRef.current);
    setChatHeight((h) => (h === height ? h : height));
  });

  /**
   * How far the caret sits above the last row this app drew.
   *
   * Published for the exit path, which writes it as a cursor move so the shell that
   * takes the terminal back prints its prompt BELOW the conversation instead of on top
   * of it. See exitCursor.ts for what that fixes; the number has to be measured here
   * because only the layout knows it.
   *
   * No dependency list, like the measurements around it: what is under the caret changes
   * for reasons no dep could name — a wrapped input line, an opened palette, a picker, an
   * approval — and each one is a different distance.
   *
   * Zero for the full-screen shell, which needs no correction: it hands the terminal back
   * by leaving the alternate screen, and that restores the primary buffer's cursor too.
   */
  useEffect(() => {
    if (shell !== "inline" || !liveRef.current) {
      setRowsBelowCaret(0);
      return;
    }
    const caret = caretCell();
    const { height, y } = measureElement(liveRef.current) as { height: number; y?: number };
    if (!caret) {
      // NO CARET IS NOT "NOTHING TO DO". It is declared null whenever the input is not the
      // thing being typed into — a picker is open, a turn is in flight — and publishing
      // zero there says "the cursor is already on the last row", which is a claim, not an
      // absence. Exiting from that state left the cursor mid-frame and the shell printed
      // its prompt across the conversation, one row per Enter.
      //
      // The whole region's height is the safe answer instead: CUD is clamped by the
      // terminal at the bottom row, so overshooting costs a blank line and undershooting
      // costs the corruption above. Only the full-screen shell publishes a true zero, and
      // it means it — leaving the alternate buffer restores the cursor with it.
      setRowsBelowCaret(Math.max(0, height - 1));
      return;
    }
    // `caretCell` reports the caret's row within the live region; `liveRef` measures that
    // region. The last row it drew is `height - 1`, so the gap is what remains below.
    setRowsBelowCaret(height - 1 - (caret.y - (y ?? 0)));
  });

  /**
   * The pointer: the wheel, and dragging to select.
   *
   * Read straight off stdin rather than through useInput, because a mouse report is not
   * a keypress and Ink's key parser has no notion of one.
   *
   * The selection lives in a REF and is painted by the framebuffer overlay, so a drag
   * never causes a React render. That is deliberate: the pointer moves a column at a
   * time, and re-rendering the whole app on each of those would be both wasteful and a
   * chance to reflow the screen under a user who is only trying to highlight a word.
   * `repaintOverlay` re-tints the frame already on screen instead.
   */
  // Mouse reporting itself is switched on and off by  — it belongs to
  // the shell, not to this component, because the inline shell must never have it on.
  // What is left here is the highlight, which has to come down when the app unmounts.
  useEffect(() => {
    if (!ready) return;
    return () => setFrameOverlay(null);
  }, [ready]);

  /**
   * Everything the pointer does, read through `useInput`.
   *
   * NOT through a `data` listener on stdin, which is where this lived and why none of it
   * worked: Ink 7 pulls input by calling `read()` on a `readable` event, so it has taken
   * the bytes before a `data` handler is ever offered them. A listener attached that way
   * is not called at all — no error, no warning, simply nothing, which is the hardest
   * kind of wrong to see. Ink hands the same bytes here instead, with the ESC of a report
   * already eaten, which is why the parser in mouse.ts matches it optionally.
   *
   * One handler for the wheel, the drag and the keystroke that dismisses a highlight,
   * because they have to agree about what just happened: a mouse report arrives as
   * "input" too, and a separate handler that treated any input as a keystroke would clear
   * the selection on the very first drag event.
   */
  useInput(
    (input) => {
      const events = readMouse(input);
      const notches = readWheel(input);

      // ONE scroll for the whole flick, not one per notch.
      //
      // A single turn of the wheel arrives as several reports in one chunk (see
      // mouse.ts), and Ink runs React in LegacyRoot mode, so state updates from here are
      // NOT batched: every setState flushes its own synchronous render and its own full
      // terminal redraw. Scrolling a notch at a time therefore did three renders for one
      // flick, back to back, and the scroll lagged behind the hand turning the wheel.
      //
      // This is the same rule the input box already follows for keystrokes — one event
      // in, one render out — applied to the other thing that arrives in bursts.
      if (notches.length > 0) {
        // Content moves out from under a selection when the view scrolls, so the
        // highlight would be sitting on text that is no longer the text it copied.
        clearSelection();
        const lines = notches.reduce((n, dir) => n + (dir === "up" ? WHEEL_LINES : -WHEEL_LINES), 0);
        // The wheel is how anyone actually scrolls, so in the inline shell it is what
        // opens the reading view. Turning it UP is the gesture: the reader is going back
        // through the conversation and wants the prompt to stay where they can type into
        // it. Turning it down while already at the bottom is not — there is nothing
        // below to go to, and building a frame for it would mean the view snapping open
        // on a flick in the direction of the newest line.
        if (shell === "inline" && !reading && lines > 0) openReading(lines);
        else if (lines !== 0) scrollBy(lines);
      }

      // ONE re-tint for a whole drag, not one per motion report — the same rule the
      // wheel follows above, for the same reason. A terminal reports motion continuously
      // while a button is held, so a single sweep of the hand arrives as a chunk of
      // several reports; each one used to re-tint the entire screen and write it out,
      // which is thousands of cells re-scanned per report. Only the LAST focus position
      // in a chunk is on screen at the end of it, so the ones before it are painted for
      // nobody. Cleared by press and release, which do their own painting.
      let pendingDrag = false;
      for (const event of events) {
        if (event.kind === "press") {
          pendingDrag = false;
          // The chip is a button. It is the only thing on screen that says what it does,
          // so a press on it does that and nothing else — no selection is begun, because
          // starting one under a click that just moved the view would leave a highlight
          // sitting on text that is no longer there.
          //
          // On PRESS rather than release: the chip is a single row and the view moves out
          // from under the pointer the instant it is hit, so a release-matched-to-press
          // would be testing the pointer against a screen that had already changed.
          const hit = pillHit.current;
          if (hit && hitsPill(hit, event.x, event.y)) {
            clearSelection();
            requestFullRepaint();
            setScrollUp(0);
            continue;
          }
          selection.current = { anchor: { x: event.x, y: event.y }, focus: { x: event.x, y: event.y } };
          // Installed here rather than for the life of the session: see clearSelection.
          setFrameOverlay((screen) => applySelection(screen, selection.current));
          repaintOverlay();
        } else if (event.kind === "drag") {
          if (!selection.current) continue;
          selection.current = { anchor: selection.current.anchor, focus: { x: event.x, y: event.y } };
          pendingDrag = true;
        } else {
          pendingDrag = false;
          const sel = selection.current;
          if (!sel) continue;
          if (isEmpty(sel)) {
            // A click, not a drag. Nothing to copy; put the caret where it landed, and
            // take the overlay back down — a press installs it, and a click that selects
            // nothing would otherwise leave it running for the rest of the session.
            selection.current = null;
            repaintOverlay();
            setFrameOverlay(null);
            placeCaretAt(event.x, event.y);
            continue;
          }
          // Copied on release, so selecting IS copying. The highlight stays up afterwards
          // as the receipt for it, and goes when the next thing happens.
          const screen = latestScreen();
          if (screen) copyToClipboard(selectionText(screen, sel));
          // If what was dragged is text in the input box, hand the range to the input as
          // well, so Backspace takes the whole selection and typing replaces it — what
          // selecting text means anywhere else. A drag over the transcript is not editable
          // and the input declines it, leaving the selection as a copy and nothing more.
          textSelect.current?.(sel.anchor, sel.focus);
        }
      }
      if (pendingDrag) repaintOverlay();

      // A real keystroke, so put any highlight away — the same as a terminal's own
      // selection does the moment you type.
      if (events.length === 0 && notches.length === 0) clearSelection();
    },
    { isActive: true },
  );

  function endTurn() {
    if (turnStart.current != null) setLastMs(Date.now() - turnStart.current);
    // Settle every tool row this turn produced into its past-tense verb. The single
    // funnel for a turn ending (normal completion, error, interrupt), so no row is
    // left reading "Reading" once nothing is being read.
    dispatch({ type: "endTurn" });
    setBusy(false);
  }

  /**
   * Write a server's config and connect it live — shared by the typed `/mcp add`, the
   * `/mcp` box's Add and Edit, and (indirectly, through the same writer) the
   * `add_mcp_server` tool. One path so a config any of them accepts is one the others
   * would too. Connects immediately: writing the file and telling the user to restart
   * would defeat the entire point of a guided add.
   */
  async function mcpWriteAndConnect(spec: AddSpec) {
    const cur = session.current;
    if (!cur) return;
    const path = configPathFor(spec.scope, cur.cwd);
    try {
      const written = await addServerToConfig(path, spec);
      note(`${written.replaced ? "replaced" : "added"} '${spec.name}' in ${path} — connecting…`);
      const status = await cur.toolContext.mcp?.addServer(spec.config);
      if (status?.state === "connected") {
        say(`${spec.name}: connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (protocol ${status.version}).`);
      } else if (status) {
        // Say what went wrong HERE rather than leaving it to be discovered in /mcp: a
        // typo'd command is the most likely outcome of typing this by hand.
        say(`${spec.name}: ${status.state}${status.error ? ` — ${status.error}` : ""}. It's saved; fix the config and /mcp to retry.`);
      }
    } catch (e) {
      say(`Couldn't write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Stop a server and take it out of the config — the file half AND the live half.
   *
   * The file half alone used to be the whole of `/mcp remove`, with its own reply saying
   * "it stays connected until this session ends" — true, but not what "remove" sounds
   * like it means. `mcp.removeServer` is the live half: it closes the connection and
   * drops its tools from what the model is offered, right now, not at the next launch.
   */
  async function mcpRemove(name: string) {
    const cur = session.current;
    const mcp = cur?.toolContext.mcp;
    if (!cur || !mcp) return;
    const gone =
      (await removeServerFromConfig(configPathFor("project", cur.cwd), name)) ||
      (await removeServerFromConfig(configPathFor("global", cur.cwd), name));
    const stopped = await mcp.removeServer(name);
    if (!gone && !stopped) return say(`No server called '${name}' is configured.`);
    say(`Removed '${name}'${stopped ? " and stopped it" : " from the config (it was not running)"}.`);
  }

  /**
   * `/mcp add <name> <command|url> [args…]` and `/mcp remove <name>`.
   *
   * Shares its parser and writer with the `add_mcp_server` tool, so a config the command
   * accepts is exactly one the tool would, and vice versa.
   */
  async function mcpConfigCommand(arg: string) {
    const argv = splitArgs(arg);
    const verb = argv.shift();

    if (verb === "remove" || verb === "rm") {
      const target = argv[0];
      if (!target) return say("Usage: /mcp remove <name>");
      return mcpRemove(target);
    }

    const parsed = parseAddSpec(argv);
    if (!parsed.ok) return say(parsed.error);
    await mcpWriteAndConnect(parsed.spec);
  }

  /**
   * Flip a server's `disabled` flag and apply it live — the box's Enable/Disable.
   *
   * Reads the server's LIVE config rather than the file, because that is what is
   * actually true right now; writes back to whichever file already defines it
   * (`resolveConfigPath`), so this cannot create a second, shadowing entry for a
   * server that already exists in the other config.
   */
  async function mcpSetDisabled(name: string, disabled: boolean) {
    const cur = session.current;
    const mcp = cur?.toolContext.mcp;
    const config = mcp?.configFor(name);
    if (!cur || !mcp || !config) return;
    const path = await resolveConfigPath(cur.cwd, name);
    const scope = path === configPathFor("global", cur.cwd) ? "global" : "project";
    const next = { ...config, disabled };
    try {
      await addServerToConfig(path, { name, scope, config: next });
      await mcp.addServer(next);
      note(`${name}: ${disabled ? "disabled" : "enabled"}.`);
    } catch (e) {
      note(`Couldn't update ${path}: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    }
  }

  // Reconnect one MCP server by name, reporting the outcome in the chat rather than
  // silently. A server that stays down is the thing a user most needs told about.
  async function reconnectMcp(name: string) {
    const mcp = session.current?.toolContext.mcp;
    if (!mcp) return;
    note(`reconnecting ${name}…`);
    const status = await mcp.reconnect(name);
    if (!status) return;
    if (status.state === "connected") {
      note(`${name} connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`);
    } else {
      note(`${name} is ${status.state}${status.error ? ` — ${status.error}` : ""}`);
    }
  }

  /**
   * Sign in to a remote MCP server. Closes the box first, for the same reason Review does:
   * this takes a browser, a consent screen and a minute of the user's attention, and a
   * footer overlay frozen on "signing in…" for that long is a frozen app.
   *
   * The URL is printed BEFORE the browser is launched. Launching silently fails on
   * machines with no default browser or no desktop session at all, and the URL on screen
   * is the difference between "nothing happened" and something the user can paste.
   */
  /**
   * Sign in to a remote MCP server, reporting INTO the `/mcp` box rather than out here.
   *
   * Nothing is written to the transcript, and that is the point: the whole interaction
   * belongs to one screen about one server, and the alternative was a running commentary
   * ending in a 400-character URL pasted across the conversation. The box stays open and
   * shows its own progress; this just does the work and hands back the line to show.
   *
   * Throws rather than reporting failure as a string, so the box can style it as an error
   * and keep the server's own sentence, which is almost always the whole explanation.
   */
  async function mcpSignIn(name: string, handlers: { onUrl: (url: string) => void; signal: AbortSignal }): Promise<string> {
    const mgr = session.current?.toolContext.mcp;
    if (!mgr) throw new Error("no MCP manager in this session");
    const status = await mgr.authenticate(name, handlers);
    if (!status) throw new Error(`${name} is no longer configured`);
    if (status.state === "connected") {
      return `${name} connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`;
    }
    throw new Error(status.error ? `${name} is ${status.state} — ${status.error}` : `${name} is ${status.state}`);
  }

  /** Drop a stored MCP credential. The connection is left running: it keeps working until
   *  its current token is refused, and that 401 is what honestly returns it to needs-auth. */
  async function mcpSignOut(name: string) {
    const mgr = session.current?.toolContext.mcp;
    if (!mgr) return;
    await mgr.signOut(name);
    note(`signed out of ${name}.`);
  }

  /** Review blocked tools from the /mcp box: closes it first, since the approval channel
   *  and the box's own screen cannot share the one footer surface at the same time. */
  async function mcpReviewBlocked(name: string) {
    setMcpOpen(false);
    const mgr = session.current?.toolContext.mcp;
    if (!mgr) return;
    const allowed = await mgr.reviewQuarantine((q, options) => askApproval.current(q, options));
    note(allowed ? `${name}: blocked tools allowed for this project.` : `${name}: tools stay blocked.`);
  }

  // Stop every root's background lane and any running shells from the current
  // session (before a swap).
  async function stopCurrentLanes() {
    const old = session.current?.toolContext;
    if (!old) return;
    old.backgroundShells?.dispose();
    // MCP servers are child processes we own. Left running across a session swap they
    // leak: each new session starts its own pool, and the old one keeps holding ports,
    // locks and file handles with nothing able to reach it.
    await old.mcp?.dispose();
    for (const ch of old.chassisByRoot?.values() ?? (old.chassis ? [old.chassis] : [])) {
      await stopChassis(ch);
    }
  }

  // ── Reveal pacing ───────────────────────────────────────────────────────────
  // The engine fires a turn's tool events in a burst, so rows would otherwise flash
  // up all at once. We queue the transcript actions and release a NEW block (a tool
  // row, a sentence, the answer) on a steady beat, so the turn reads as work being
  // done rather than as output being thrown at the screen. The beat and the reasons
  // for it live in revealPace.ts; every path below goes through it, with no
  // exceptions, because an exception IS a change of tempo and that is the one thing
  // the beat cannot survive.
  //
  // It is a MINIMUM since the last reveal, not an added delay: if the model already
  // spent that long between events, the next reveal is immediate. Silent text
  // accumulation and a tool RESOLVING in place are never paced — only the
  // APPEARANCE of a new block is.
  const revealQ = useRef<Action[]>([]);
  const lastRevealAt = useRef(0);
  const pumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamDone = useRef(false);
  const flush = useRef(false); // Esc → drain the rest with no pacing
  // Whether a "tools" group is currently visible (already revealed and still
  // open). Tracked at this layer — not read from transcript state — because the
  // decision it drives (does the NEXT grouped toolStart need to be held) has to
  // be made before that action is even dispatched.
  const groupOpen = useRef(false);
  // When the row currently at the front of the queue began waiting for its own result,
  // and the timer that gives up on it. See the hold in pump().
  const heldStart = useRef<{ toolId: string; at: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new block appears (paced); a token (silent), a tool resolution (in place), a
  // discovery call folding into an ALREADY-OPEN group, or a sub-agent's nested
  // activity (folds into / resolves its rail in place) is not.
  //
  // Both kinds of tool start are paced AND held: pump() waits for the matching
  // toolEnd so the row arrives complete, then reveals the pair on the beat. (It used
  // to show instantly as a bare header and then patch in place; that was the
  // two-stage reveal the hold mechanism exists to remove.) Holding and pacing are
  // separate questions — one is about the block being whole, the other about when a
  // whole block is allowed on screen — and a standalone row used to answer only the
  // first, which is why a burst of edits landed together however calm the rest of
  // the turn was.
  const isPaced = (a: Action) => {
    if (a.type === "toolStart") return a.group ? !groupOpen.current : true;
    return (
      a.type !== "token" &&
      a.type !== "toolEnd" &&
      a.type !== "toolProgress" &&
      a.type !== "subToolStart" &&
      a.type !== "subToolEnd" &&
      a.type !== "subagentEnd"
    );
  };

  function enqueueReveal(a: Action) {
    revealQ.current.push(a);
    // A result arriving is exactly what the hold below is waiting for, so its deadline is
    // cancelled rather than waited out — otherwise every quick tool would sit out the
    // full grace before its pair could be shown.
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (!pumpTimer.current) pump();
  }

  // Reveal the next block on the beat (a minimum since the last reveal, not an added
  // delay), then stamp the clock and carry on draining. Every paced path in pump()
  // goes through here, so the tempo is decided in exactly one place.
  function schedulePaced(reveal: () => void) {
    const wait = revealWait({ flush: flush.current });
    pumpTimer.current = setTimeout(() => {
      pumpTimer.current = null;
      // A revealed block shifts the transcript, which can move a row out from under the
      // framebuffer's model and strand it on the pinned banner (see requestFullRepaint).
      // Set BEFORE the dispatch, so the very frame that shows the new block redraws the
      // banner too rather than leaving a stray row on it until the next paint.
      requestFullRepaint();
      reveal();
      lastRevealAt.current = Date.now();
      pump();
    }, wait);
  }

  function pump() {
    // Apply immediate actions at once: silent tokens, in-place resolves, and a
    // discovery call folding into a group that's already on screen.
    while (revealQ.current.length > 0 && !isPaced(revealQ.current[0]!)) {
      const a = revealQ.current.shift()!;
      if (a.type === "token") applySilent(a);
      else {
        // An in-place resolve grows a row into its result, shifting everything below it —
        // the same de-sync risk a reveal carries, so heal the banner on the same frame.
        requestFullRepaint();
        dispatch(a);
      }
      // A group stays open once shown; anything that isn't part of it (a
      // standalone tool, narration, a sub-agent) closes it, mirroring exactly
      // what the transcript reducer's own closeToolGroup does on the same actions.
      if (a.type === "toolStart" && a.group) groupOpen.current = true;
      else if (a.type !== "toolEnd") groupOpen.current = false;
    }
    if (revealQ.current.length === 0) {
      if (streamDone.current) {
        streamDone.current = false;
        endTurn();
      }
      return;
    }
    const front = revealQ.current[0]!;

    // Narration waiting in front of a tool call gets the beat to itself. `toolStart`
    // seals the open assistant block as part of its own action, so without this the
    // sentence and the row it introduces reach the terminal in the SAME paint and
    // land as one clump — the pacer's blind spot, since nothing was ever queued for
    // the text. Sealing it first lets the sentence be read before the row appears
    // under it. Only when a block will actually result (see narrationPending): the
    // narration budget is one line per turn, and pausing for a sentence that seals
    // to nothing would be an empty beat, which is a stall rather than a rhythm.
    if (front.type === "toolStart" && narrationPending(stateRef.current)) {
      schedulePaced(() => {
        dispatch({ type: "sealNarration" });
        groupOpen.current = false;
      });
      return;
    }

    // A tool's opening call is HELD — not dispatched, not scheduled, nothing shown —
    // until its result is queued behind it, so the row never appears bare and then
    // sprouts a body a second later. Holding costs nothing that was worth having:
    // the header alone names a call whose result is the entire point of showing it,
    // and the footer's live timer is what says work is happening. There is no
    // time-based fallback (see groupReveal.ts): every later enqueueReveal re-enters
    // pump, which re-checks. Esc sets `flush`, and `streamDone` releases the hold
    // unconditionally — once the stream is over no further event can arrive, so a
    // call whose end never came (an abort mid-flight) must still be shown rather
    // than stranding the queue and the turn with it.
    //
    // Then the whole held burst reveals in ONE paint, on the beat. Painting per
    // action would show the block assembling itself (header, then a running row,
    // then the resolved row): Ink's root is a legacy React root, so every dispatch
    // flushes synchronously and each one is a frame the terminal actually shows.
    if (front.type === "toolStart") {
      const isNewGroup = front.group && !groupOpen.current;
      if (isNewGroup) {
        if (planGroupReveal(groupSettled(revealQ.current.slice(1)), flush.current) === "hold") return;
      } else {
        // A standalone row is held for its own result, but only for so long.
        //
        // Held with no limit, a  row was invisible for the ten
        // minutes the build took: the last thing on screen stayed the tool before it, and
        // an agent working steadily was indistinguishable from one that had hung. It was
        // reported as a hang. It was not one — the command ran, the timeout fired, the
        // shell was backgrounded, all of it correct and none of it visible.
        if (heldStart.current?.toolId !== front.toolId) {
          heldStart.current = { toolId: front.toolId, at: Date.now() };
        }
        const heldForMs = Date.now() - heldStart.current.at;
        const plan = planStandaloneReveal({
          resultQueued: resultQueued(front.toolId, revealQ.current),
          flushing: flush.current,
          streamDone: streamDone.current,
          heldForMs,
        });
        if (plan === "hold") {
          // Re-enter when the deadline passes. Its OWN timer, not the pacing one: the
          // result arriving must be able to cancel this and reveal the pair at once, and
          // clearing the pacing timer instead would drop the beat.
          if (!holdTimer.current) {
            holdTimer.current = setTimeout(() => {
              holdTimer.current = null;
              pump();
            }, Math.max(0, STANDALONE_HOLD_MS - heldForMs));
          }
          return;
        }
      }
      schedulePaced(() => {
        // Measured HERE, not when the beat was scheduled: the queue keeps growing
        // while we wait, and a group's burst can gain members in that window. A span
        // measured early would leave the stragglers behind to open a second group,
        // splitting one burst across two blocks.
        if (isNewGroup) {
          // A group folds into ONE row ("Read 8 files"), so its whole burst is a single
          // block and reveals together by design.
          let take = 0;
          while (take < revealQ.current.length && isGroupMember(revealQ.current[take]!)) take++;
          applyBatch(revealQ.current.splice(0, take));
        } else {
          // This call and its OWN result — never the span between them. The engine emits
          // every toolStart of a batch before running any of it, so when those calls run
          // concurrently the matching end sits behind the other calls' starts. Taking a
          // contiguous span from the front swallowed all of them into this one paint:
          // eight rows appearing at once, however calm the beat before it was. Each of
          // those calls is its own block and waits its own beat; only the pair is atomic,
          // so a row still arrives carrying its result rather than sprouting one later.
          const endIdx = revealQ.current.findIndex((x) => x.type === "toolEnd" && x.toolId === front.toolId);
          if (endIdx === -1) {
            applyBatch(revealQ.current.splice(0, 1));
          } else {
            // The end first: it sits at the higher index, so removing it cannot shift
            // the start out from under the shift() that follows.
            const endAction = revealQ.current.splice(endIdx, 1)[0]!;
            const startAction = revealQ.current.shift()!;
            applyBatch([startAction, endAction]);
          }
        }
        // Resolved either way — the action that closes the block follows next.
        groupOpen.current = false;
      });
      return;
    }

    // Every remaining paced block (a sealed reply, a sub-agent start, notes) reveals
    // on the same beat.
    schedulePaced(() => {
      const a = revealQ.current.shift();
      if (a) {
        dispatch(a);
        if (a.type !== "toolEnd") groupOpen.current = a.type === "toolStart" && !!a.group;
      }
    });
  }

  /**
   * Run one streaming turn against the session. Engine events are QUEUED onto the
   * transcript through the pacer above: text tokens accumulate silently (whole-block
   * reveal), each tool bookends a `toolStart`/`toolEnd`, and the reply seals on
   * completion. busy stays true until every paced reveal has been shown.
   */
  /**
   * Turn typed text into what the model gets and what the chat shows.
   *
   * Shared by the two ways a message reaches a turn — submitted when idle, and steered
   * into one already running — because they must resolve identically. A dropped path is
   * a short handle in the buffer either way, a paste is collapsed either way, and an
   * image only rides along if the model running RIGHT NOW can see one. Two copies of
   * that would drift, and the drift would show up as a queued message behaving unlike
   * the same message typed a second later.
   */
  async function prepareMessage(s: Session, text: string) {
    // Whether an attached image is sent or merely named depends on the running model,
    // and that is a fact we ask the driver for — never a provider name in this file.
    const manifest = manifestForModel(s.modelConfig.model);
    const canSeeImages = manifest.acceptsImages?.(s.modelConfig.model) ?? false;
    // Dropped files are carried in the buffer as short handles. Put the real paths back
    // before anything is resolved against the disk, and hand the same handle back as the
    // label so the chat shows what the user typed rather than a third name for the file.
    const { modelText, displayText, notes, images } = await resolveAttachments(
      expandHandles(text, dropHandles.current),
      s.cwd,
      canSeeImages,
      (abs) => dropHandles.current.labelFor(abs),
    );
    // Restore any collapsed pastes into the model's copy only (the chat keeps chips).
    return { content: expandPastes(modelText), displayText, notes, images };
  }

  /**
   * Hand the running turn whatever was typed at it, at a step boundary.
   *
   * Called by the engine, not by us, and only at the one moment a user message may be
   * appended without malforming the conversation. The queue is drained SYNCHRONOUSLY
   * first and resolved after, so a ↑ that pulls the queue back mid-resolution takes the
   * messages that are still queued rather than racing the ones already on their way.
   *
   * Each message gets its own chat line, queued through the reveal pacer like every
   * other row so it lands in the order it happened instead of jumping ahead of the tool
   * rows around it.
   */
  async function steerRunningTurn(s: Session): Promise<SteeredMessage[]> {
    const { send, rest } = takeSteerable(queueRef.current);
    if (send.length === 0) return [];
    queueRef.current = rest;
    setQueued(rest);
    const out: SteeredMessage[] = [];
    for (const { text } of send) {
      // No history write here: `onSend` records every message the moment it is typed,
      // queued or not, so ↑ walks them in the order they were written rather than the
      // order they happened to go out. Recording again on the way out appended each one
      // a second time.
      const { content, displayText, notes, images } = await prepareMessage(s, text);
      enqueueReveal({ type: "user", text: displayText });
      for (const n of notes) enqueueReveal({ type: "note", text: n });
      out.push({ content, ...(images.length > 0 ? { images } : {}) });
    }
    return out;
  }

  async function streamRespond(s: Session) {
    startTurn();
    // Pick up an edit the model made to MINDWEAVE.md, but only if one actually happened
    // — this is a no-op otherwise. Re-reading unconditionally used to look free and was
    // not: it rewrites the system prompt string, which discards the entire cached prefix
    // (base prompt, tool schemas, project snapshot) at 1.25x rewrite cost.
    await reloadProjectMemory(s).catch(() => {});
    revealQ.current = [];
    lastRevealAt.current = 0;
    streamDone.current = false;
    flush.current = false;
    // A hold belongs to one turn. Left standing, its deadline fires into the next one and
    // pumps a queue that has nothing to do with it.
    heldStart.current = null;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    try {
      await respond(s, {
        // Messages typed while this turn runs reach it here, at each step boundary,
        // rather than waiting for it to end and starting another one.
        steer: () => steerRunningTurn(s),
        onActivity: (line, opts) =>
          enqueueReveal(
            opts?.context ? { type: "context", text: line } : opts?.error ? { type: "error", text: line } : { type: "note", text: line },
          ),
        // An AUTOMATIC compaction, mid-turn. Queued like everything else so it appears
        // in the order it happened, rather than jumping ahead of the rows around it.
        onCompaction: (report) => enqueueReveal({ type: "compaction", report }),
        onEvent: (e) => {
          if (e.type === "text") {
            meter.current = meterDelta(meter.current, e.delta.length);
            enqueueReveal({ type: "token", delta: e.delta });
          } else if (e.type === "reasoning") {
            // Not rendered, but it is generated text the provider bills as output, so
            // leaving it out would make the live figure undershoot on a thinking model.
            meter.current = meterDelta(meter.current, e.delta.length);
          } else if (e.type === "replyReset") {
            enqueueReveal({ type: "resetReply" });
          } else if (e.type === "tool" && e.phase === "start") {
            // The spawn call itself is rendered by its sub-agent block, not a raw row.
            if (e.name === "spawn_subagent") return;
            const d = toolDisplay(e.name, e.args);
            if (e.agent) {
              // A sub-agent's own tool call — fold it into that worker's nested rail.
              enqueueReveal({ type: "subToolStart", agentId: e.agent, toolId: e.id, name: d.name, arg: d.arg, action: d.kind });
            } else {
              enqueueReveal({ type: "toolStart", toolId: e.id, name: d.name, arg: d.arg, meta: d.meta, action: d.kind, group: isGroupable(e.name), ...(d.covers ? { covers: d.covers } : {}) });
            }
          } else if (e.type === "tool" && e.phase === "progress") {
            // A worker's own calls fold into its rail, which has no room for output.
            if (!e.agent) enqueueReveal({ type: "toolProgress", toolId: e.id, text: e.text });
          } else if (e.type === "tool" && e.phase === "end") {
            if (e.name === "spawn_subagent") return;
            if (e.agent) {
              enqueueReveal({ type: "subToolEnd", agentId: e.agent, toolId: e.id, ok: !e.error, summary: e.summary });
            } else {
              enqueueReveal({
                type: "toolEnd",
                toolId: e.id,
                ok: !e.error,
                summary: e.summary,
                detail: e.detail,
                detailKind: e.detailKind,
                quiet: e.quiet,
                action: e.displayKind,
                name: e.displayName,
              });
            }
            // A lift (see approval.ts's liftForbidden) happens INSIDE the call that
            // just ended, with no ToolResult of its own to carry it — drained here,
            // right after the call it happened during, as its own governor block.
            const gov = session.current?.toolContext.governance;
            for (const notice of gov?.notices ?? []) {
              const govId = `governor-${crypto.randomUUID()}`;
              enqueueReveal({ type: "toolStart", toolId: govId, name: "Governor", action: "governor" });
              enqueueReveal({ type: "toolEnd", toolId: govId, ok: true, summary: notice });
            }
            if (gov) gov.notices = [];
          } else if (e.type === "subagent" && e.phase === "start") {
            enqueueReveal({ type: "subagentStart", agentId: e.id, task: e.task, readOnly: e.readOnly });
          } else if (e.type === "subagent" && e.phase === "end") {
            enqueueReveal({ type: "subagentEnd", agentId: e.id, ok: !e.error, summary: e.summary });
          } else if (e.type === "usage") {
            // Keep each call's real usage; fold into the context+cost summary shown
            // once the turn ends. The model id drives cache-aware pricing.
            usageSamples.current.push({
              promptTokens: e.promptTokens,
              completionTokens: e.completionTokens,
              totalTokens: e.totalTokens,
              cacheHitTokens: e.cacheHitTokens,
              cacheMissTokens: e.cacheMissTokens,
              // The written slice, so cache writes are priced at the rate the provider
              // actually charges for them (1.25x base input on Anthropic) instead of
              // the plain input rate. Absent on providers that don't report it.
              ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
            });
            setTaskUsage(summarizeTask(usageSamples.current, s.modelConfig.model));
          }
        },
        signal: abortRef.current?.signal,
        // Persist after every step so a hard crash / PC shutdown mid-turn loses at
        // most the current in-flight step — not the whole turn. (The finally below
        // still saves on clean/aborted exits.)
        persist: () => saveSession(s),
      });
      enqueueReveal({ type: "finishReply" });
    } catch (error) {
      enqueueReveal({ type: "finishReply" });
      // An account-level refusal (key rejected, balance spent, rate limited) is a
      // STATE, not a crash: nothing is broken and the red error block would say the
      // opposite. It becomes the same calm notice the permission prompt uses, with
      // the provider's own sentence quoted inside it. Anything else — a malformed
      // request, a bug of ours — stays loud, which is the point of classifying
      // narrowly. See drivers/providerError.ts.
      // A provider falling over after the retries ran out gets the same calm treatment:
      // it is not our crash, and the useful news is "wait, or switch model".
      const refusal =
        accessRefusal(error, providerOf(s.modelConfig.model).label, otherProviderHasKey(s.modelConfig.model)) ??
        providerOutage(error, providerOf(s.modelConfig.model).label, modelLabel(s.modelConfig.model));
      if (refusal) enqueueReveal({ type: "notice", title: refusal.title, body: refusal.body });
      else enqueueReveal({ type: "error", text: `⚠ ${errText(error)}` });
    } finally {
      await saveSession(s);
      streamDone.current = true;
      if (!pumpTimer.current) pump(); // ensure we drain to endTurn even if idle now
    }
  }

  // When a background shell finishes while Mindweave is idle, kick a turn so the model
  // reports the result (and proposes a fix on failure). respond() drains the
  // completion event; the guard stops overlapping reactions.
  async function reactToBackground() {
    const s = session.current;
    if (!s) return;
    reactingRef.current = true;
    try {
      await streamRespond(s);
    } finally {
      reactingRef.current = false;
    }
  }

  // Resume a chosen past session: swap it in, restart its background lane, and
  // append its transcript to the visible stream. `compactFirst` summarizes the old
  // conversation BEFORE showing it, so continuing doesn't eat the context window.
  async function resumePicked(meta: SessionMeta, compactFirst: boolean) {
    const s = session.current;
    if (!s) return;
    const resumed = await resumeSession(s.cwd, meta.id);
    if (!resumed) {
      say("Couldn't load that session.");
      return;
    }
    await stopCurrentLanes();
    attachApproval(resumed);
    session.current = resumed;

    if (compactFirst) {
      startTurn();
      note("compacting the old conversation so it fits…");
      try {
        await compactNow(resumed, {
          onActivity: (line, opts) => note(line, opts),
          onCompaction: (report) => dispatch({ type: "compaction", report }),
        });
        await saveSession(resumed);
      } catch (error) {
        say(`⚠ ${errText(error)}`);
      } finally {
        endTurn();
      }
    }

    note(`— continuing${compactFirst ? " (compacted)" : ""}: ${sessionTitle(meta)} —`);
    showResumed(resumed.transcript);
  }

  /**
   * Drop the current chat and start a clean session in the same project.
   *
   * `wipeScreen` is the difference between the two ways in. Reached through
   * `/continue`, the old conversation is still worth seeing — you went looking for
   * sessions, so the history above is context for the choice you just made. Reached
   * through `/clear`, you asked for it to be gone, and leaving it on screen while the
   * model can no longer see it is the worst of both: it reads as still being there.
   *
   * What SURVIVES is as deliberate as what goes, and none of it is automatic — a fresh
   * session starts genuinely empty, so anything that outlives the conversation has to
   * be carried across on purpose (see sessionCarry.ts and `createSession`'s
   * `carryRoots`). The project's rules, skills and forbidden paths come back because
   * they are read from the folder. Undo history and the added workspace roots are
   * handed over deliberately: clearing a conversation does not un-edit the files or
   * un-add the folders, and losing either silently leaves the user worse off than
   * before they typed it.
   *
   * Background shells do NOT survive, because they cannot. A shell belongs to its
   * session's tool context, and the new session builds its own — leaving the old ones
   * alive would hold ports and file handles that nothing can reach or stop any more.
   * So they are killed, and `/clear` SAYS how many, because silently stopping someone's
   * dev server is exactly the kind of surprise a one-word command should not spring.
   */
  async function startFresh(wipeScreen = false) {
    const s = session.current;
    if (!s) return;
    // Counted BEFORE the lanes stop — afterwards the manager is disposed and there is
    // nothing left to count.
    const killed = s.toolContext.backgroundShells?.running().length ?? 0;
    // Read BEFORE the lanes stop, and carried into the new session: folders added with
    // /include or /link belong to the workspace, not to the conversation being ended.
    // Without this, starting over silently narrows every tool back to one root.
    const carried = rootsOf(s.toolContext);
    await stopCurrentLanes();
    const fresh = await createSession(s.cwd, carried);
    attachApproval(fresh);
    // The files the old conversation edited are still edited, and its checkpoints are
    // the only record of what they were before.
    carryAcrossFreshSession(s.toolContext, fresh.toolContext);
    session.current = fresh;
    if (wipeScreen) {
      // The chips are keyed per conversation; a stale one would expand into a message
      // the new session never saw.
      pasteStore.current.clear();
      setScrollUp(0);
      // Anything the pacer is still holding belongs to the conversation being cleared.
      // Left in place it would paint into the empty screen a moment later, which looks
      // exactly like the clear having failed.
      revealQ.current = [];
      lastRevealAt.current = 0;
      streamDone.current = false;
      flush.current = false;
      // The status line still reads "Cooked for 1m 23s" from a turn that is no longer
      // on screen or in the model's context.
      setTaskUsage(null);
      setLastMs(null);
      dispatch({ type: "clear" });
    }
    note(
      killed > 0
        ? `— started a fresh session (stopped ${killed} background command${killed === 1 ? "" : "s"}) —`
        : "— started a fresh session —",
    );
  }

  // Apply the resume-mode pick for a chosen session: compact & continue / as-is / fresh.
  async function applyResume(meta: SessionMeta, mode: number) {
    if (mode === 2) return startFresh();
    return resumePicked(meta, mode === 0);
  }

  // Apply a /model pick: switch model (clamping reasoning to a valid level), persist
  // the choice for this project, and confirm.
  async function applyModel(index: number, providerId?: string) {
    const s = session.current;
    // Index into the SAME list the picker rendered — that provider's models in display
    // order, not every model everywhere. Indexing a differently-ordered list here would
    // silently select a different model than the one on screen, and would type-check
    // perfectly.
    const list = !s ? [] : providerId ? orderedModelsOf(providerId) : orderedModelList(s.modelConfig.model);
    const choice = list[index];
    if (!s || !choice) return;
    // A model on another provider is a provider switch, and gets the same key check.
    const target = manifestForModel(choice.id);
    if (target.id !== providerOf(s.modelConfig.model).id) {
      if (missingKeyFor(choice.id)) {
        pendingSwitch.current = { model: choice.id, apiKeyEnv: target.apiKeyEnv, label: target.label };
        note(`${target.label} has no key yet — add one and the switch will finish.`);
        setKeysOpen(true);
        return;
      }
      await switchTo(choice.id, target.label);
      return;
    }
    s.modelConfig = withModel(s.modelConfig, choice.id);
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`model → ${modelLabel(s.modelConfig.model)} · ${thinkLabel(s.modelConfig)}`);
  }

  /**
   * Apply a /provider pick: move to that provider's first model, since a provider is
   * only reachable through one of its models. Staying put when the pick is the
   * provider already in use matters — otherwise re-selecting it would quietly reset a
   * model the user chose deliberately.
   */
  async function applyProvider(index: number) {
    const s = session.current;
    // The display-ordered list, matching what the picker rendered and its cursor.
    const provider = orderedProviderList()[index];
    if (!s || !provider) return;
    if (providerOf(s.modelConfig.model).id === provider.id) {
      note(`already on ${provider.label} · ${modelLabel(s.modelConfig.model)}`);
      return;
    }
    const target = modelsOf(provider)[0];
    if (!target) return;

    // Do NOT move onto — let alone SAVE — a provider we can't run. Persisting first is
    // what turned a wrong pick into a project that reopened straight into the key
    // prompt on every launch, with no way back from inside the app. Ask for the key,
    // and apply the switch only once it exists.
    if (missingKeyFor(target.id)) {
      // Open the manager rather than a prompt of its own, and finish the switch as soon
      // as a key for THIS provider is saved.
      pendingSwitch.current = { model: target.id, apiKeyEnv: manifestForModel(target.id).apiKeyEnv, label: provider.label };
      note(`${provider.label} has no key yet — add one and the switch will finish.`);
      setKeysOpen(true);
      return;
    }
    await switchTo(target.id, provider.label);
  }

  /** Move to a model and persist it. Only ever called once its key is known to exist. */
  async function switchTo(model: string, providerLabel: string) {
    const s = session.current;
    if (!s) return;
    s.modelConfig = withModel(s.modelConfig, model);
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`provider → ${providerLabel} · model → ${modelLabel(s.modelConfig.model)} · ${thinkLabel(s.modelConfig)}`);
    // Where prompts go is worth a sentence at the moment someone moves their work there.
    const notice = manifestForModel(model).notice;
    if (notice) note(notice);
  }

  // Apply a /think pick for the current model: set thinking + effort, persist, confirm.
  async function applyThink(index: number) {
    const s = session.current;
    if (!s) return;
    const level = thinkLevels(s.modelConfig.model)[index];
    if (!level) return;
    s.modelConfig = { ...s.modelConfig, thinking: level.thinking, effort: level.effort };
    await saveModelConfig(s.cwd, s.modelConfig);
    note(`reasoning → ${modelLabel(s.modelConfig.model)} · ${level.label}`);
  }

  // Route a Picker selection/cancel back to whatever opened the overlay. Picking a
  // session opens the second step — the three resume choices.
  /**
   * Move to a shell, from either route into `/screen` — the chooser or a named argument.
   *
   * One function because the two routes must not drift: they save the same preference,
   * announce the same line, and both have to leave the terminal work to the effect that
   * watches `shell`. Two copies is how one of them ends up switching without remembering.
   */
  function applyScreen(next: ScreenMode): void {
    if (next === shell) {
      note(`already ${screenNotice(next)}`);
      return;
    }
    // The terminal is moved by the effect that watches this, not from here: the escapes
    // must not go out in the middle of handling a keypress, with a render still to come.
    setShell(next);
    // Remembered for the project, so the choice is made once rather than at the start of
    // every session. Best-effort and not awaited: the switch has already happened, and a
    // preference that failed to save is not worth holding the UI for.
    void saveScreenMode(session.current?.cwd ?? process.cwd(), next);
    note(screenNotice(next));
  }

  function onOverlaySelect(index: number) {
    const o = overlay;
    if (!o) return;
    if (o.kind === "sessions") {
      setOverlay({ kind: "resumeMode", meta: o.items[index]! });
      return;
    }
    setOverlay(null);
    if (o.kind === "analytics") {
      setAnalyticsEnabled(index === 0);
      note(`Analytics turned ${index === 0 ? "on" : "off"}.`);
    } else if (o.kind === "resumeMode") void applyResume(o.meta, index);
    else if (o.kind === "provider") void applyProvider(index);
    else if (o.kind === "model") void applyModel(index, o.providerId);
    else if (o.kind === "think") void applyThink(index);
    else if (o.kind === "screen") {
      const picked = screenChoices(shell)[index];
      if (picked) applyScreen(picked.mode);
    }
    else if (o.kind === "shells") {
      const sh = o.items[index];
      if (sh && sh.status === "running" && session.current?.toolContext.backgroundShells?.kill(sh.id, "user")) {
        note(`stopped shell #${sh.id} (${clipCmd(sh.command)})`);
      }
    } else if (o.kind === "approval") {
      approvals.current.answer(o.options[index] ?? o.options[0]!);
      showNextApproval.current();
    }
  }
  /** A typed answer, carried back with a marker so the caller can tell it from a choice. */
  function onOverlaySubmitText(text: string) {
    const o = overlay;
    setOverlay(null);
    if (o?.kind === "approval") {
      approvals.current.answer(APPROVAL_TEXT + text);
      showNextApproval.current();
    }
  }
  function onOverlayCancel() {
    const o = overlay;
    setOverlay(null);
    // Esc = declined to answer. NOT "chose option 2" — see APPROVAL_DISMISSED.
    if (o?.kind === "approval") {
      approvals.current.answer(APPROVAL_DISMISSED);
      showNextApproval.current();
    }
  }

  // Hand a free-text directive to the model with an instruction wrapper, as its own
  // turn — used by the manual /rules and /skills commands (the model does the
  // "rewrite it well and save it" work via remember_rule / create_skill).
  async function runDirective(instruction: string, activity: string) {
    const s = session.current;
    if (!s) return;
    note(activity);
    s.transcript.push({ role: "user", content: instruction });
    await streamRespond(s);
  }

  async function handleCommand(raw: string) {
    const s = session.current;
    if (!s) return;
    // WHICH command this is is decided in commandRoute.ts, where it can be tested —
    // the eighteen branches below are the bodies, not the decision. The catalog is the
    // same BASE_COMMANDS list `/help` and the input's autocomplete render from, so the
    // three cannot disagree about what exists.
    const route = routeCommand(raw, {
      builtins: BASE_COMMANDS.map((c) => c.name),
      skills: s.governance.skills ?? [],
    });
    // `route` decides WHICH branch runs; these two are what the branches say back to
    // the user. They come from the same parse, so a message can never name a different
    // command from the one that ran.
    const { name, arg } = parseCommandLine(raw);

    // /help — every command, rendered from the same list the input's autocomplete
    // offers, so the two can never disagree about what exists.
    if (name === "/help") {
      const skills = s.governance.skills ?? [];
      const mcpPrompts = s.toolContext.mcp?.promptCatalog() ?? [];
      say(
        formatHelp([
          { title: "Commands", commands: BASE_COMMANDS },
          {
            title: "Project skills",
            commands: skills.map((k) => ({ name: `/${k.name}`, description: k.description || "project skill" })),
          },
          {
            title: "MCP prompts",
            commands: mcpPrompts.map((p) => ({
              name: promptCommand(p),
              description: p.description || `prompt from ${p.server}`,
            })),
          },
        ]),
      );
      return;
    }

    // /update — take the newer version and come back to this same conversation.
    //
    // The restart is the point. A process cannot replace its own code: driver modules
    // are imported lazily, so a copy that rewrote itself mid-session would be an old
    // process reading new files, which fails later and somewhere else. Ending and
    // reopening is what makes the new version actually the version running, and landing
    // back in this session is what makes that invisible.
    if (name === "/update") {
      if (busy) {
        note("Finish or stop the current turn first — restarting would strand it.", { error: true });
        return;
      }
      const install = currentInstall();
      if (install.kind !== "global") {
        // Never guessed at. Overwriting a working tree or another project's dependency
        // is the one thing this command must not do; see selfUpdate.ts.
        note(`${refusalReason(install)}\n\nTo do it by hand:\n  ${manualCommand(install)}`, { error: true });
        return;
      }
      // Past the once-a-day cache deliberately: someone typing this is asking NOW, and
      // answering from a check made this morning would report "up to date" about a
      // release that has happened since.
      const latest = await checkForUpdate({ readCacheImpl: () => null });
      const current = appVersion();
      if (!latest) {
        note(`Already on the latest${current ? ` (v${current})` : ""}.`);
        return;
      }
      const choice = await askApproval.current(
        `Update from v${current} to v${latest}? Mindweave will restart into this same conversation.`,
        ["Yes, update and restart", "No"],
        manualCommand(install),
        "This will run",
      );
      if (!choice.startsWith("Yes")) {
        note("Left as it is.");
        return;
      }
      note(`Updating to v${latest}…`);
      const result = await runUpdate(install.prefix);
      if (!result.ok) {
        // A failure here is a no-op rather than a half-state: npm either replaced the
        // package or it did not, and the copy running is the copy that always was.
        note(
          `The update did not run, and nothing was changed.\n${result.message}\n\nTo do it by hand:\n  ${manualCommand(install)}`,
          { error: true },
        );
        return;
      }
      // On disk before the successor goes looking for it.
      await saveSession(s);
      // Recorded rather than done here: the terminal can only be handed over once Ink
      // has unmounted, and unmounting is what ends this render. `index.ts` picks it up.
      requestRestart({
        packageRoot: install.packageRoot,
        sessionId: s.id,
        previousVersion: current,
        prefix: install.prefix,
      });
      exit();
      return;
    }

    // /analytics — the anonymous usage ping. Bare opens the on/off switch, the same
    // fixed box every other setting uses; an argument acts directly, same as /model.
    if (name === "/analytics") {
      const verb = arg.trim().toLowerCase();
      if (verb === "on" || verb === "off") {
        setAnalyticsEnabled(verb === "on");
        note(`Analytics turned ${verb}.`);
        return;
      }
      if (verb) {
        return say("/analytics on|off, or bare to open the switch.");
      }
      setOverlay({ kind: "analytics" });
      return;
    }

    // /clear — a fresh conversation without leaving the folder. Until now the only
    // way to start over was to quit and relaunch, or to go through /continue and pick
    // its third option, which is not somewhere anyone looks for "start over".
    if (name === "/clear") {
      await startFresh(true);
      return;
    }

    // /init — have the model write MINDWEAVE.md. The file is read into the cached
    // prefix of every single turn (see memory/session.ts), and nothing in Mindweave
    // ever created it: a new user had to know both that it mattered and what belonged
    // in it. Model work, not a template — what is worth always knowing about a project
    // is a judgement about THAT project.
    if (name === "/init") {
      await runDirective(
        `Write this project's MINDWEAVE.md, at the workspace root. It is read into your ` +
          `context at the start of every turn, so it must be SHORT and consist only of ` +
          `things worth knowing every single time: how to build, test and run this ` +
          `project (exact commands); the shape of the codebase and where things live; ` +
          `conventions a newcomer would otherwise get wrong; and anything surprising. ` +
          `Do not restate what is obvious from reading a file, do not summarize the ` +
          `README, and do not pad it. Look at the project first — read the manifest, the ` +
          `scripts, and enough of the source to be accurate. If MINDWEAVE.md already ` +
          `exists, IMPROVE it in place rather than replacing it, and say what you ` +
          `changed. If one subject deserves a page of its own, put it in its own file and ` +
          `pull it in with an @-import line rather than making the root file long; if a ` +
          `convention is true of one folder only, write a MINDWEAVE.md inside that folder ` +
          `instead, which costs nothing when work is happening elsewhere. ` +
          `changed. Finish by confirming in one line what you wrote and why.`,
        "writing MINDWEAVE.md…",
      );
      return;
    }

    if (name === "/compact") {
      startTurn();
      try {
        // No "compacting…" line and no "Context compacted." afterwards: the report
        // block below says both, with the numbers, and in one settled piece rather
        // than three rows arriving separately around it.
        await compactNow(s, {
          onActivity: (line, opts) => note(line, opts),
          onCompaction: (report) => dispatch({ type: "compaction", report }),
          // `/compact focus on the auth work` — the person compacting usually knows
          // which thread they are about to keep working on. Additive: it ranks detail
          // inside the summary, it never narrows what the summary must cover.
          ...(arg ? { compactFocus: arg } : {}),
        });
        await saveSession(s);
      } catch (error) {
        say(`⚠ ${errText(error)}`);
      } finally {
        endTurn();
      }
      return;
    }

    if (name === "/context") {
      // The old /context printed the startup project blurb, which answers a question
      // nobody asks twice. The one people ask every time a compaction fires is what is
      // filling the window — so that is the default, and the blurb moved to an argument.
      if (arg.trim() === "project") {
        const text = s.projectContext || "No project context was captured for this directory.";
        note("project context (what Mindweave sees at startup):");
        say(text);
        return;
      }
      // Only a measurement taken against the CURRENT model is passed through; a figure
      // carried over from another provider's tool serialisation would be the largest
      // single error in the table, and the table is meant to settle arguments.
      const measured = s.contextOverhead;
      const overhead = measured && measured.model === s.modelConfig.model ? measured.tokens : undefined;
      const budget = contextBudget(s.transcript, overhead);
      note("context breakdown:");
      say(
        `${formatBudget(budget, sharpContextWindow(s.modelConfig.model), autoCompactThreshold(s.modelConfig.model))}

  /context project shows what Mindweave read about this directory at startup.`,
      );
      return;
    }

    // /undo — roll back file changes. Bare undoes the last turn; `list` shows what's
    // available; a number goes back that many turns, newest first.
    if (name === "/undo") {
      const cp = s.toolContext.checkpoints;
      const command = parseUndoArg(arg);
      if (command.kind === "error") {
        say(command.message);
        return;
      }
      if (!cp || !cp.hasUndo()) {
        // A resumed session genuinely has no history to undo, which is NOT the same
        // as nothing having happened — say which.
        say(
          cp?.wasResumed()
            ? "Nothing to undo here — undo history isn't carried across restarts. Changes from the earlier run are still on disk."
            : "Nothing to undo — no file changes have been made yet this session.",
        );
        return;
      }

      if (command.kind === "list") {
        const rows = cp.list().map((c, i) => {
          const bits = [`${c.files} file${c.files === 1 ? "" : "s"}`];
          if (c.skipped > 0) bits.push(`${c.skipped} too large`);
          if (c.ranShell) bits.push("ran shell");
          return `  ${i + 1}. ${c.label} — ${bits.join(", ")} · ${timeAgo(c.at)}`;
        });
        note(`${rows.length} turn${rows.length === 1 ? "" : "s"} you can roll back (newest first):`);
        say(`${rows.join("\n")}\n\n  /undo ${rows.length > 1 ? "2" : "1"} rolls back that many, newest first.`);
        return;
      }

      const results = await cp.undoMany(command.count);
      const rel = (p: string) => relativize(s.toolContext, p);
      const uniq = (xs: string[]) => [...new Set(xs)];
      const restored = uniq(results.flatMap((r) => r.restored));
      const conflicts = uniq(results.flatMap((r) => r.conflicts));
      const failed = uniq(results.flatMap((r) => r.failed));
      const skipped = uniq(results.flatMap((r) => r.skipped));

      if (restored.length + conflicts.length + failed.length + skipped.length === 0) {
        say("Nothing was rolled back.");
        return;
      }

      // One structured tool-shaped block (● Undo … ⎿ branch) instead of a stack of
      // separate note/say text lines — same restored/conflict/failed/skipped facts,
      // rendered the same way an edit's diff or a command's output is.
      if (restored.length > 0) {
        // The files on disk are back to their pre-turn state; drop them from the read
        // ledger so the model must re-read before it can edit them again.
        for (const p of restored) s.toolContext.reads.delete(p);
      }
      const detailLines: string[] = [];
      const summaryBits: string[] = [];
      if (restored.length > 0) {
        const from = results.length === 1 ? `"${results[0]!.label}"` : `${results.length} turns`;
        detailLines.push(`Reverted ${restored.length} file${restored.length === 1 ? "" : "s"} from ${from}:`);
        detailLines.push(...restored.map((p) => `  ↩ ${rel(p)}`));
        summaryBits.push(`${restored.length} restored`);
      }
      if (conflicts.length > 0) {
        detailLines.push(`Left alone — changed since I wrote ${conflicts.length === 1 ? "it" : "them"}:`);
        detailLines.push(...conflicts.map((p) => `  • ${rel(p)}`));
        summaryBits.push(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`);
      }
      if (failed.length > 0) {
        const retry = results.some((r) => r.retryable)
          ? " — /undo again to retry"
          : " — giving up; they're still in their edited state";
        detailLines.push(`Couldn't write ${failed.length === 1 ? "this file" : "these files"}${retry}:`);
        detailLines.push(...failed.map((p) => `  ! ${rel(p)}`));
        summaryBits.push(`${failed.length} failed`);
      }
      if (skipped.length > 0) {
        detailLines.push(`Never checkpointed (too large) — still in their edited state:`);
        detailLines.push(...skipped.map((p) => `  · ${rel(p)}`));
        summaryBits.push(`${skipped.length} skipped`);
      }
      if (results.some((r) => r.ranShell)) {
        detailLines.push("Shell commands also ran — those changes aren't covered by /undo.");
      }
      const undoToolId = `undo-${crypto.randomUUID()}`;
      dispatch({
        type: "toolStart",
        toolId: undoToolId,
        name: "Undo",
        arg: results.length === 1 ? results[0]!.label : `${results.length} turns`,
        action: "checkpoint",
      });
      dispatch({
        type: "toolEnd",
        toolId: undoToolId,
        ok: failed.length === 0,
        summary: summaryBits.join(" · "),
        detail: detailLines.join("\n"),
      });

      // Tell the MODEL too. Without this the transcript still claims the edits are in
      // place, and the next turn reasons about code that is no longer on disk.
      s.transcript.push({ role: "user", content: undoNotice(results, rel) });
      await saveSession(s);
      return;
    }

    // /shells — view background shells; selecting a running one stops it.
    if (name === "/shells") {
      const shells = s.toolContext.backgroundShells?.list() ?? [];
      if (shells.length === 0) {
        say("No background shells running. Long commands move here automatically after they pass their timeout.");
        return;
      }
      setOverlay({ kind: "shells", items: shells });
      return;
    }

    // /mcp add … — write a server to mcp.json and connect it now.
    if (route.kind === "mcp-config") {
      await mcpConfigCommand(route.arg);
      return;
    }

    // /mcp — the minitabs manager: your servers, and "+ Add a server" always at the top,
    // so an empty config is a place to add one rather than a dead end.
    if (name === "/mcp") {
      // Which servers are signed in is read once, here, before the box is shown. Doing it
      // as the box opens rather than on every render keeps a handful of file reads off
      // the render path, and this is the only moment the answer can change unseen.
      const mgr = session.current?.toolContext.mcp;
      setMcpSignedIn(mgr ? await mgr.credentialed().catch(() => new Set<string>()) : new Set<string>());
      setMcpOpen(true);
      return;
    }

    if (name === "/continue") {
      const sessions = (await listSessions(s.cwd)).filter((m) => m.id !== s.id);
      if (sessions.length === 0) {
        say("No other sessions to continue here yet.");
        return;
      }
      setOverlay({ kind: "sessions", items: sessions });
      return;
    }

    // Both pickers refresh discovered providers whose list has gone stale, so a newly
    // served model appears without a restart. Awaited rather than fired off: the
    // picker renders from the list, and opening on a stale one that then changes
    // under the cursor is the exact "two-stage reveal" the UI work removed.
    if (name === "/provider") {
      await refreshModels({ maxAgeMs: DISCOVERY_TTL_MS });
      setOverlay({ kind: "provider" });
      return;
    }
    // The same screen the first run uses, reopened. A key that is wrong — a typo, or one
    // pasted for a different provider — was previously only fixable by finding
    // ~/.mindweave/.env and editing it by hand: eighteen commands and not one of them
    // could replace a key, which is the commonest way a first run dies.
    if (name === "/key") {
      setKeysOpen(true);
      return;
    }

    // Both take the choice inline as well as through the picker. Typing the name and
    // getting the picker anyway — which is what happened before, because the argument
    // was dropped without a word — reads as the app not having heard you.
    if (name === "/model") {
      await refreshModels({ maxAgeMs: DISCOVERY_TTL_MS });
      if (arg) {
        const current = providerOf(s.modelConfig.model).id;
        const here = resolveChoice(arg, orderedModelList(s.modelConfig.model), "model");
        const { providerId, words } = splitModelArg(arg, allProviders(), current, here.kind !== "error");
        // `/model openrouter` alone: that provider's picker.
        if (!words) return setOverlay({ kind: "model", providerId });
        const picked = providerId === current ? here : resolveChoice(words, orderedModelsOf(providerId), "model");
        if (picked.kind === "error") return say(picked.message);
        // Several fit: show exactly those, in the picker, rather than a list to retype from.
        if (picked.kind === "several") return setOverlay({ kind: "model", providerId, filter: words });
        await applyModel(picked.index, providerId);
        return;
      }
      setOverlay({ kind: "model" });
      return;
    }

    if (name === "/screen") {
      // Bare `/screen` now CHOOSES rather than swaps. Swapping was fine while the two
      // shells were equals; they are not, and a toggle gives no room to say so. The two
      // differ in what they take from the terminal — the inline one takes the mouse, so
      // the scrollbar and text selection stop working — and that is worth reading before
      // picking rather than discovering afterwards.
      //
      // Naming a mode still applies it directly: `/screen inline` is someone who already
      // knows which they want, and making them confirm through a list would be the
      // command asking a question it was just given the answer to.
      if (!arg?.trim()) {
        setOverlay({ kind: "screen" });
        return;
      }
      const next = parseScreenArg(arg);
      if (!next) return say("`/screen` takes `fullscreen` or `inline`, or nothing at all to choose.");
      applyScreen(next);
      return;
    }

    if (name === "/think") {
      if (arg) {
        const picked = resolveChoice(arg, thinkLevels(s.modelConfig.model), "reasoning level");
        if (picked.kind !== "match") return say(picked.message);
        await applyThink(picked.index);
        return;
      }
      setOverlay({ kind: "think" });
      return;
    }

    // /include — add one or more folders to the workspace (backend + frontend, …).
    if (name === "/include") {
      if (!arg) {
        const roots = rootsOf(s.toolContext);
        const lines = roots.map((r, i) => `• ${rootLabel(roots, r)}${i === 0 ? "  (primary)" : ""}  →  ${r}`);
        note("workspace roots (add more with /include <path>):");
        say(lines.join("\n"));
        return;
      }
      for (const p of parsePaths(arg)) {
        const abs = isAbsolute(p) ? resolve(p) : resolve(s.cwd, p);
        const result = await addRoot(s.toolContext, abs);
        if (result.error) note(`couldn't add ${p}: ${result.error}`, { error: true });
        else if (result.already) note(`'${result.label}' is already in the workspace.`);
        else note(`included '${result.label}' → ${abs}`);
      }
      await saveSession(s);
      return;
    }

    // /link — discover and pull in the rest of the project (monorepo members or
    // sibling repos) in one shot, so the model works across the whole thing.
    if (name === "/link") {
      note("looking for related project folders…");
      const roots = rootsOf(s.toolContext);
      const related = await discoverRelatedRoots(roots[0]!, roots);
      if (related.length === 0) {
        say("No related folders found (no monorepo config or sibling projects beside this one).");
        return;
      }
      const added: string[] = [];
      for (const r of related) {
        const res = await addRoot(s.toolContext, resolve(r.path));
        if (res.label && !res.already) added.push(`${res.label} (${r.reason})`);
      }
      if (added.length === 0) say("Those folders are already in the workspace.");
      else {
        note(`linked ${added.length} folder${added.length === 1 ? "" : "s"} — the model now works across all of them:`);
        say(added.map((a) => `• ${a}`).join("\n"));
        await saveSession(s);
      }
      return;
    }

    // /exclude — drop an added root (by label or path); the primary stays.
    if (name === "/exclude") {
      if (!arg) {
        say("Usage: /exclude <label or path> — removes an added folder (the primary root stays).");
        return;
      }
      const result = removeRoot(s.toolContext, arg.trim());
      if (result.error) say(result.error);
      else {
        note(`excluded '${result.removed}' from the workspace.`);
        await saveSession(s);
      }
      return;
    }

    // /rules — list standing rules, or (with text) have the model formalize a new one.
    if (name === "/rules") {
      if (!arg) {
        const rules = s.governance.rules;
        if (rules.length === 0) {
          say('No rules yet. Add one with /rules <directive> (e.g. "/rules always use pnpm").');
          return;
        }
        const lines = rules.map((r) => {
          const scope = r.globs && r.globs.length > 0 ? `  [scoped: ${r.globs.join(", ")}]` : "";
          return `• ${r.body}${scope}`;
        });
        note("standing rules for this project:");
        say(lines.join("\n"));
        return;
      }
      await runDirective(
        `The user wants this saved as a standing rule for this project. Rewrite it as a clear, ` +
          `imperative, self-contained rule and save it with remember_rule (add globs only if it ` +
          `clearly applies to specific files). Then confirm in one line. Directive: "${arg}"`,
        "saving a rule…",
      );
      return;
    }

    // /forbidden — list forbidden paths, or (with a path) forbid one outright.
    if (name === "/forbidden") {
      if (!arg) {
        const patterns = s.governance.forbidden.patterns;
        if (patterns.length === 0) {
          say('Nothing is forbidden yet. Protect a path with /forbidden <path> (e.g. "/forbidden src/legacy/**").');
          return;
        }
        note("forbidden paths (I won't touch these without your okay):");
        say(patterns.map((p) => `• ${p}`).join("\n"));
        return;
      }
      const result = await appendForbidden(s.governance.forbidden.root, arg);
      if (!result.pattern) {
        say("That path was empty after normalization — nothing forbidden.");
        return;
      }
      if (result.added) {
        s.governance.forbidden = {
          ...s.governance.forbidden,
          patterns: [...s.governance.forbidden.patterns, result.pattern],
        };
        note(`forbade '${result.pattern}' — I won't touch it without asking.`);
      } else {
        say(`'${result.pattern}' was already forbidden.`);
      }
      return;
    }

    // /forbid-command — list forbidden commands, or (with an argument) forbid one.
    if (name === "/forbid-command") {
      if (!arg) {
        const commands = s.governance.forbidden.commands ?? [];
        if (commands.length === 0) {
          say('No commands are forbidden yet. Block one with /forbid-command <command> (e.g. "/forbid-command tauri dev").');
          return;
        }
        note("forbidden commands (I won't run these, or anything containing them, without your okay):");
        say(commands.map((c) => `• ${c}`).join("\n"));
        return;
      }
      const result = await appendForbiddenCommand(s.governance.forbidden.root, arg);
      if (!result.pattern) {
        say("That command was empty — nothing forbidden.");
        return;
      }
      if (result.added) {
        s.governance.forbidden = {
          ...s.governance.forbidden,
          commands: [...(s.governance.forbidden.commands ?? []), result.pattern],
        };
        note(`forbade the command '${result.pattern}' — I won't run it without asking.`);
      } else {
        say(`'${result.pattern}' was already forbidden.`);
      }
      return;
    }

    // /skills — list the project's skills, or (with text) have the model author one.
    if (name === "/skills") {
      if (arg) {
        await runDirective(
          `The user wants a new reusable skill for this project: "${arg}". Design it and save it ` +
            `with create_skill — a short invocation name, a one-line description, and the procedure ` +
            `as a clear markdown checklist (use $ARGUMENTS/$1 if it should take input). Then confirm.`,
          "creating a skill…",
        );
        return;
      }
      const skills = s.governance.skills;
      if (skills.length === 0) {
        say('No skills yet. Make one with /skills <description> (e.g. "/skills our release flow").');
        return;
      }
      const lines = skills.map((sk) => {
        const hint = sk.argumentHint ? ` ${sk.argumentHint}` : "";
        const desc = sk.description ? ` — ${sk.description}` : "";
        const scope = sk.globs && sk.globs.length > 0 ? `  [scoped: ${sk.globs.join(", ")}]` : "";
        return `/${sk.name}${hint}${desc}${scope}`;
      });
      note("project skills (run with /name or let me pick one):");
      say(lines.join("\n"));
      return;
    }

    // A project skill invoked as /name — load its steps and run them as a turn.
    if (route.kind === "skill") {
      const skill = route.skill;
      const rest = route.arg;
      const body = await loadSkillBody(skill);
      if (!body) {
        say(`Skill ${skill.name} has no readable SKILL.md.`);
        return;
      }
      note(`running skill ${skill.name}…`);
      const text = `Run the "${skill.name}" skill. Follow these steps:\n\n${substituteSkillArgs(body, rest)}`;
      s.transcript.push({ role: "user", content: text });
      await streamRespond(s);
      return;
    }

    // A server prompt invoked as /server:name — render it and run it, exactly like a
    // skill. Checked after skills so a project's own command always wins over a
    // third-party server's.
    if (route.kind === "prompt") {
      const promptRef = { server: route.server, name: route.prompt };
      const prompt = s.toolContext.mcp?.findPrompt(promptRef.server, promptRef.name);
      if (!prompt) {
        say(`No MCP prompt ${name}. Run /mcp to see which servers are connected.`);
        return;
      }
      const rest = route.arg;
      const { values, missing } = mapPromptArguments(prompt, rest ? rest.split(/\s+/) : []);
      if (missing.length > 0) {
        say(`${name} needs ${missing.join(", ")}.\n${promptUsage(prompt)}`);
        return;
      }
      note(`running ${name}…`);
      const rendered = await s.toolContext.mcp!.renderPrompt(promptRef.server, promptRef.name, values);
      if (rendered.error) {
        say(`${name} failed: ${rendered.error}`);
        return;
      }
      s.transcript.push({ role: "user", content: rendered.text });
      await streamRespond(s);
      return;
    }


    say(unknownCommandMessage(name));

  }

  async function handleSubmit(value: string, opts: { arrival?: "interrupting" } = {}) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || busy || !ready) return;

    if (trimmed.startsWith("/")) {
      // Submitting clears the input, which closes the command list; the surface the command
      // opens can only arrive after the work it does first (reading sessions, refreshing
      // models). Between the two the box would have nothing to show and would unmount,
      // taking its frame off the screen and putting it back a moment later. Marking the
      // open here — synchronously, in the same update as the clear — holds the frame so
      // only its CONTENTS change. Bare invocations only: with an argument these commands
      // act directly and open nothing.
      const opens = OVERLAY_COMMANDS.has(trimmed);
      if (opens) setOpening(true);
      try {
        await handleCommand(trimmed);
      } finally {
        if (opens) setOpening(false);
      }
      return;
    }

    const s = session.current;
    if (!s) return;

    // The chat shows the typed line — `@mentions` stay visible, a dragged/dropped
    // file path collapses to just its name — never the file dump. The model gets
    // the full content via resolved <attached_file> blocks, and each attachment
    // leaves one compact activity note (counts only).
    const { content, displayText, notes, images } = await prepareMessage(s, trimmed);
    dispatch({ type: "user", text: displayText });
    for (const n of notes) note(n);
    s.transcript.push({
      role: "user",
      content,
      // Sent straight after an Esc. The model is told the work was cut off on purpose,
      // or a message landing after a half-finished round of tools reads as if it had
      // always been the request and it picks up where it was stopped.
      ...(opts.arrival ? { arrival: opts.arrival } : {}),
      ...(images.length > 0 ? { images } : {}),
    });
    await streamRespond(s);
  }

  // Proactive "a compaction is coming" notice: hidden until context crosses the warn bar
  // (90% of the auto bar), then a single dim line of notice before the summarizing pass
  // rewrites the conversation. Memoized on the size inputs so it costs nothing per
  // keystroke — it only recomputes when the transcript grows, overhead is re-measured, or
  // the model changes.
  const ctxWarn = useMemo(() => {
    const s = session.current;
    if (!s) return null;
    const p = contextPressure(contextUsed(s), s.modelConfig.model);
    return p.warn ? p : null;
  }, [session.current?.transcript.length, session.current?.contextOverhead?.tokens, session.current?.modelConfig.model]);

  // ---- NO HOOKS BELOW THIS LINE ----
  // The screens below return EARLY, so anything hooked after them runs on some renders
  // and not others, and React counts hooks per render: the first render after a gate
  // closes has one more than the last, which is a hard crash that takes the whole app
  // down. It cost a real user their first run — they pasted a key, pressed Continue, and
  // the screen vanished — because the compaction notice above used to be declared down
  // in the chat layout. A gate is a return, not a branch; put new hooks above it.
  // `firstRun.test.ts` fails if one appears below.

  // Key setup screen. Shown on first run, and again if the user switches to a
  // provider they haven't given a key for yet.
  // Asked BEFORE anything else, including the key prompt: agreeing to hand over a key is
  // a smaller decision than agreeing to what the agent may touch, and the second one is
  // the reason the first matters.
  if (trustOpen) {
    return (
      <TrustGate
        rows={rows}
        cwd={startCwd.current}
        breadth={trustBreadth}
        warning={breadthWarning(trustBreadth, startCwd.current)}
        persists={trustPersists(trustBreadth)}
        version={versionLabel()}
        docsUrl={MINDWEAVE_DOCS_URL}
        onTrust={() => {
          rememberTrust(projectDir(startCwd.current), trustBreadth);
          setTrustOpen(false);
        }}
        onQuit={() => exit()}
      />
    );
  }

  // FIRST RUN: nothing can run yet, so offer every provider rather than one. The user
  // adds as many keys as they like and continues when they are ready. See KeySetup.
  if (setupOpen) {
    return (
      <KeySetup
        rows={rows}
        view={setupView(hasApiKey)}
        version={versionLabel()}
        envPath={globalEnvPath()}
        docsUrl={MINDWEAVE_DOCS_URL}
        onSaveKey={(row, key) => {
          saveApiKey(row.envVar, key);
          // Re-read so the list marks it immediately and Continue lights up.
          reloadConfig(session.current?.cwd ?? process.cwd());
          setSetupTick((n) => n + 1);
        }}
        onContinue={() => {
          setSetupOpen(false);
          const s = session.current;
          if (!s) return;
          if (!missingKeyFor(s.modelConfig.model)) {
            note("you're all set. ask me anything.");
            return;
          }
          const fallback = usableFallback(s.modelConfig.model, hasApiKey);
          if (fallback) void switchTo(fallback, providerOf(fallback).label);
          else note("you're all set. ask me anything.");
        }}
      />
    );
  }


  // Record the sent text in history (no consecutive dupes). While busy, queue it
  // (the input stays live); the turn-end effect sends it next. Otherwise handle now.
  function onSend(text: string) {
    // Sending snaps back to the newest: your own message arriving off-screen,
    // above where you are scrolled to, reads as the app having ignored you.
    setScrollUp(0);
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    if (busy) {
      queueRef.current.push(queueMessage(text, { interrupting: interrupting.current }));
      setQueued([...queueRef.current]);
      return;
    }
    void handleSubmit(text);
  }

  // Autocomplete entries: the built-in slash commands, this project's skills, and any
  // prompts the connected MCP servers offer (all read from the live session, so a freshly
  // created skill — or a server that just finished connecting — shows up next render).
  const skills = session.current?.governance.skills ?? [];
  const mcpPrompts = session.current?.toolContext.mcp?.promptCatalog() ?? [];
  const completions = [
    ...BASE_COMMANDS,
    ...skills.map((s) => ({ name: `/${s.name}`, description: s.description || "project skill" })),
    ...mcpPrompts.map((p) => ({ name: promptCommand(p), description: p.description || `prompt from ${p.server}` })),
  ];

  // While an overlay is open it renders in the menu slot below the input and owns the
  // keyboard; the input box itself stays visible but inert. `maxRows` is the App's
  // height-safe row budget, shared with the command menu.
  function buildOverlayView(maxRows: number) {
    // /key sits where the prompt sits, like every other thing that asks something. It
    // used to replace the whole screen for a list of three keys, which is the wrong
    // weight for changing a setting and leaves nothing to come back to.
    if (keysOpen) {
      return (
        <KeyManager
          key={keysTick}
          providers={providerRows()}
          keysOf={(p) => keyRowsFor(p)}
          nextSlot={(p) => nextSlotFor(p)}
          startProvider={
            pendingSwitch.current
              ? providerRows().find((p) => p.apiKeyEnv === pendingSwitch.current!.apiKeyEnv) ?? null
              : null
          }
          width={width}
          maxRows={maxRows}
          reveal={(row) => keysFor(row.apiKeyEnv).find((k) => k.slot === row.slot)?.value ?? ""}
          onActivate={(row) => {
            useApiKey(row.apiKeyEnv, row.slot);
            note(`${row.label} key ${row.slot} ${row.hint} is now the active one.`);
            setKeysTick((n) => n + 1);
          }}
          onSave={(provider, slot, key) => {
            saveApiKey(provider.apiKeyEnv, key, slot);
            setKeysTick((n) => n + 1);
            const held = pendingSwitch.current;
            if (held && held.apiKeyEnv === provider.apiKeyEnv) {
              pendingSwitch.current = null;
              setKeysOpen(false);
              void switchTo(held.model, held.label);
            }
          }}
          onRemove={(row) => {
            removeApiKey(row.apiKeyEnv, row.slot);
            note(`removed ${row.label} key ${row.slot} ${row.hint}.`);
            setKeysTick((n) => n + 1);
          }}
          onClose={() => {
            // Closing without saving abandons any provider switch that was waiting on a
            // key, so it cannot finish later when an unrelated key is added.
            pendingSwitch.current = null;
            setKeysOpen(false);
          }}
        />
      );
    }
    if (mcpOpen) {
      const mcp = session.current?.toolContext.mcp;
      return (
        <McpMinitabs
          servers={mcp?.statuses() ?? []}
          blockedCountFor={(name) => mcp?.blockedCountFor(name) ?? 0}
          configFor={(name) => mcp?.configFor(name)}
          onSubmit={(spec) => void mcpWriteAndConnect(spec)}
          onSetDisabled={(name, disabled) => void mcpSetDisabled(name, disabled)}
          onRemove={(name) => void mcpRemove(name)}
          onReconnect={(name) => void reconnectMcp(name)}
          onReviewBlocked={(name) => void mcpReviewBlocked(name)}
          signedIn={mcpSignedIn}
          onSignIn={mcpSignIn}
          onCopyLink={(url) => copyToClipboard(url)}
          onSignOut={(name) => void mcpSignOut(name)}
          width={width}
          maxRows={maxRows}
          onClose={() => setMcpOpen(false)}
        />
      );
    }
    if (!overlay) return null;
    const cur = session.current;
    if (overlay.kind === "analytics") {
      const enabled = analyticsEnabled();
      const items = [
        { label: "On" + (enabled ? "  ✓" : ""), description: "sends the ping" },
        { label: "Off" + (!enabled ? "  ✓" : ""), description: "sends nothing" },
      ];
      return (
        <Picker
          title="Anonymous usage analytics"
          note={ANALYTICS_EXPLANATION}
          items={items}
          width={width}
          maxRows={maxRows}
          initialIndex={enabled ? 0 : 1}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "sessions") {
      const items = overlay.items.map((m) => ({
        label: sessionTitle(m),
        description: `${timeAgo(m.updatedAt)} · ${m.entryCount} msg${m.entryCount === 1 ? "" : "s"}`,
      }));
      return (
        <Picker title="Continue which session?" items={items} width={width} maxRows={maxRows} rightAlignDescription onSelect={onOverlaySelect} onCancel={onOverlayCancel} />
      );
    }
    if (overlay.kind === "resumeMode") {
      return (
        <Picker
          title={`Continue “${sessionTitle(overlay.meta)}” — how?`}
          items={RESUME_MODES}
          width={width}
          maxRows={maxRows}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "shells") {
      const items = overlay.items.map((sh) => ({
        label: `#${sh.id} ${clipCmd(sh.command)}`,
        description: sh.status === "running" ? `running ${shellElapsed(sh)} — Enter to stop` : sh.status === "killed" ? "killed" : `exited ${sh.exitCode}`,
      }));
      return (
        <Picker title="Background shells" items={items} width={width} maxRows={maxRows} onSelect={onOverlaySelect} onCancel={onOverlayCancel} />
      );
    }
    if (overlay.kind === "provider") {
      const activeModel = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;
      const active = providerOf(activeModel).id;
      // The model actually running, by the name the model list calls it. The row for the
      // provider you are already on otherwise says no more than any other row, leaving the
      // one thing you came to check — what you are on right now — off the screen.
      const activeLabel = modelLabel(activeModel);
      const providers = orderedProviderList();
      const items = providers.map((p) => {
        const n = modelsOf(p).length;
        const models = `${n} model${n === 1 ? "" : "s"}`;
        // Say up front which ones you can actually run — finding out at the next
        // request is the worse place to learn it.
        const key = hasApiKey(p.apiKeyEnv) ? "key set" : `needs ${p.apiKeyEnv}`;
        const here = p.id === active ? ` · on ${activeLabel}` : "";
        return { label: p.label + (p.id === active ? "  ✓" : ""), description: `${models} · ${key}${here}` };
      });
      return (
        <Picker
          title="Choose a provider"
          items={items}
          width={width}
          maxRows={maxRows}
          initialIndex={Math.max(0, providers.findIndex((p) => p.id === active))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "model") {
      const id = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;
      // One provider's models, in display order (default first, rest A→Z): the one in use,
      // unless `/model <provider> …` named another.
      const models = overlay.providerId ? orderedModelsOf(overlay.providerId) : orderedModelList(id);
      const pickerProvider = overlay.providerId ? allProviders().find((p) => p.id === overlay.providerId)?.label ?? "" : providerOf(id).label;
      // The two facts that decide the choice and are nowhere else on the screen: how much
      // it can hold, and whether it can see an image you attach. They lead the description
      // because the row truncates from the RIGHT — put behind the prose they would be the
      // first thing cut on a narrow terminal, which is where they matter most.
      const items = models.map((m) => {
        const window = `${Math.round(sharpContextWindow(m.id) / 1000)}K`;
        const vision = manifestForModel(m.id).acceptsImages?.(m.id) ?? false;
        const facts = `${window}${vision ? " · vision" : ""}`;
        return {
          label: m.label + (m.id === id ? "  ✓" : ""),
          description: m.description ? `${facts} · ${m.description}` : facts,
        };
      });
      return (
        <Picker
          title={`Choose a ${pickerProvider} model`}
          items={items}
          width={width}
          maxRows={maxRows}
          initialIndex={Math.max(0, models.findIndex((m) => m.id === id))}
          initialFilter={overlay.filter}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "think") {
      const model = cur?.modelConfig.model ?? DEFAULT_MODEL_CONFIG.model;
      const levels = thinkLevels(model);
      const curLabel = cur ? thinkLabel(cur.modelConfig) : "";
      const items = levels.map((l) => ({ label: l.label + (l.label === curLabel ? "  ✓" : ""), description: l.description }));
      return (
        <Picker
          title={`Reasoning for ${modelLabel(model)}`}
          items={items}
          width={width}
          maxRows={maxRows}
          initialIndex={Math.max(0, levels.findIndex((l) => l.label === curLabel))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    if (overlay.kind === "screen") {
      const choices = screenChoices(shell);
      return (
        <Picker
          title="Which shell?"
          items={choices.map((c) => ({ label: c.label, description: c.description }))}
          width={width}
          maxRows={maxRows}
          // The shell descriptions explain a real trade-off, so they are shown in full
          // below the list — wrapping down rather than truncating on the row.
          describeSelection
          // Opens on the one in use, so Enter alone changes nothing. A chooser that opens
          // somewhere else turns a glance at the options into an accidental switch.
          initialIndex={Math.max(0, choices.findIndex((c) => c.mode === shell))}
          onSelect={onOverlaySelect}
          onCancel={onOverlayCancel}
        />
      );
    }
    // approval — a plan, a Sentinel action, a forbidden-path lift. It interrupts the user's
    // work and the answer commits them to something, so it reads as a stop; it renders in
    // the same fixed menu box as everything else, the answers always visible.
    return (
      <ApprovalBox
        question={overlay.question}
        options={overlay.options}
        width={width}
        maxRows={maxRows}
        onSelect={onOverlaySelect}
        onCancel={onOverlayCancel}
        {...(overlay.freeText ? { freeText: overlay.freeText } : {})}
        onSubmitText={onOverlaySubmitText}
      />
    );
  }

  // Alt-screen owns every row, so the app decides for itself what is on screen.
  //
  // Two hard constraints, both found by measuring Ink rather than reasoning about it:
  //
  //  1. The frame must be STRICTLY SHORTER than the terminal. At `outputHeight >=
  //     stdout.rows`, Ink abandons its normal erase-and-redraw and writes
  //     `clearTerminal + output` instead (ink.js), which never updates
  //     log-update's `previousLineCount`. The next ordinary frame then erases the
  //     wrong number of lines, so old text stays behind and new text lands on top
  //     of it — the overlapping, half-drawn screen with the header scrolled away.
  //  2. Yoga cannot clip a chat. Children default to `flexShrink: 1` so an
  //     overfull column COMPRESSES (rows silently dropped from the middle), and
  //     with `flexShrink: 0` every layout clips the END of the axis — which is
  //     the newest message.
  //
  // So the transcript renders in FULL inside a clipped viewport, and a negative
  // top margin slides it — the same mechanism a scrollable pane uses anywhere
  // else. `measureElement` reports the rendered height, so the scroll maths runs
  // on what the terminal actually drew rather than a guess about it.
  //
  // An earlier cut estimated each block's height and rendered only the ones that
  // fit. It scrolled a whole block per step, which meant a long block jumped the
  // view past everything inside it, and any drift between the estimate and the
  // real render made content shift around. Measuring removes the estimate, and
  // scrolling by LINES removes the jumping.
  const committed = stateRef.current.committed;
  const tail = stateRef.current.tail;
  const allBlocks: Block[] = [...committed, ...tail];

  // The terminal's height RIGHT NOW, by live syscall — see liveTerminalSize. The SOLE
  // authority for the frame: no min or max against the polled state, which can lag a
  // resize, and a live syscall never can.
  const liveRows = liveTerminalSize(stdout).rows;
  // The FULL height, so the footer sits on the very last row with nothing below it.
  //
  // This was `liveRows - 1` for a real reason that no longer applies. Ink's own renderer
  // switches, at a frame as tall as the terminal, from erasing and redrawing to clearing
  // the whole screen — and that clear desynchronises its line bookkeeping, so the next
  // ordinary frame erases the wrong count and old text is left behind under new. The one
  // row held back kept the frame under that threshold. But the framebuffer replaces that
  // renderer entirely in the full-screen shell: it addresses cells absolutely and diffs
  // its own model, never leaning on Ink's erase-and-redraw, so the threshold is not
  // reached and the row is pure dead space at the bottom edge. Verified by driving a
  // full-height frame and a change through the real framebuffer — the footer lands on the
  // last row and nothing is left behind.
  const frameHeight = Math.max(3, liveRows);
  // The chat's HEIGHT is no longer computed here — Yoga is given the job instead
  // (the viewport below is flexGrow:1 beside a flexShrink:0 footer), and this
  // measurement is now only read for the SCROLL maths.
  //
  // It used to be `frameHeight - BANNER_ROWS - footerHeight`, and that arithmetic
  // could not be right at the moment it mattered most. `footerHeight` is measured
  // from the PREVIOUS render, so on the frame where the input box grows a line —
  // exactly when a message wraps — the chat was still sized against the old,
  // shorter footer. Total content then exceeded the frame by one row and the
  // excess clipped from the bottom, which is where the tip line lives. REPRODUCED
  // with a bare Ink render: at 3 wrapped input lines with a stale footerHeight,
  // the tip vanishes; with the flex layout it survives 1, 3, 6 and 11 lines.
  //
  // Yoga computes both in a single pass, so there is no frame where the two
  // disagree. `chatRows` is measured from the viewport itself; a lag there costs
  // nothing, because it only clamps how far the user may scroll.
  const chatRows = Math.max(1, chatHeight || frameHeight - BANNER_ROWS - footerHeight);
  // How many command-palette rows the footer could safely grow by. Reserves a
  // conservative fixed cost for what's always there (status line, the bordered
  // input box, the tip line) and a floor of MIN_CHAT_ROWS so the chat is never
  // fully eclipsed by an open menu; MENU_CHROME_ROWS is the palette's own
  // border/title/hint. What's left becomes item rows, floored at a usable
  // minimum and capped so a huge terminal doesn't show an ungainly wall.
  const menuBudget = frameHeight - BANNER_ROWS - MIN_CHAT_ROWS - FOOTER_BASE_ROWS - MENU_CHROME_ROWS;
  //
  // The inline shell gets a much smaller window, and the reason is not taste. There is no
  // frame to shrink there: every row the palette adds makes the live region taller than
  // the room below it, so the TERMINAL scrolls to fit — and that scroll is one-way. Twelve
  // rows is twelve rows of the conversation gone up past the top edge, for a list nobody
  // reads twelve of. Three plus the hint is about one line of visible movement, and the
  // list is not shortened by it: `SuggestionMenu` windows around the selection, so the
  // whole catalog is still reachable with the arrows, three at a time.
  const maxMenuItems = shell === "inline"
    ? Math.max(2, Math.min(INLINE_MENU_ROWS, menuBudget))
    : Math.max(3, Math.min(12, menuBudget));
  // Built here, after maxMenuItems, so a picker's contents respect the same row budget as
  // the command menu and can never grow the footer past the screen. EVERY interactive
  // surface — the pickers, the key manager, and the approval prompt — is content-only and
  // renders inside the input's one menu box below the input line. There is no separate
  // "boxed" overlay any more; the box is always the same, only its contents change.
  const overlayView = buildOverlayView(maxMenuItems);
  const runningShells = session.current?.toolContext.backgroundShells?.running() ?? [];
  // Where the transcript sits in the viewport, and how far it can travel. Extracted
  // to `chatAnchor.ts` so the rule is unit-tested rather than eyeballed — see there
  // for why a short transcript now rests ON the input box instead of stranding
  // itself at the top of the screen, and why that cannot disturb a scrolled frame.
  const { marginTop: chatOffset, restsOnFooter, maxScroll, scrolled } = chatLayout(contentHeight, chatRows, scrollUp);
  // Published for the scroll handlers, which run between frames and cannot compute it.
  maxScrollRef.current = maxScroll;
  // The chip that says the view is not at the bottom. `scrolled` and not `scrollUp`:
  // the clamped number is the one that is zero whenever the whole transcript already
  // fits, which is exactly when there is nothing to jump to. See scrollPill.ts.
  const pill = scrollPill({
    scrolled,
    newReplies: countNewReplies(allBlocks, scrollMark.current),
    overlayOpen: overlay !== null,
    width,
  });
  /**
   * The chip's cells in SCREEN coordinates, so a click can be tested against them.
   *
   * The layout reports the chip's row within the LIVE REGION, and a mouse report gives a
   * row on the screen. Those are the same number in the full-screen shell, where the app
   * owns every row and Ink draws from the top — and they are NOT in the inline shell,
   * where the live region is the last `frameHeight` rows of a terminal full of
   * scrollback. Confusing the two is the same mistake that once had the cursor parked in
   * the middle of the conversation; the offset is applied once, here, rather than being
   * rediscovered by whatever reads this.
   *
   * Published during the render, because a pointer handler runs BETWEEN frames and can
   * measure nothing for itself.
   */
  const frameTop = readingInline ? Math.max(0, rows - frameHeight) : 0;
  pillHit.current = pill !== null && pillRow.current !== null ? pillBounds(pill, width, frameTop + pillRow.current) : null;
  // Only the blocks that can still be reached are worth laying out. Yoga lays
  // out every child on every render — including one caused by a keystroke — so
  // an unbounded transcript makes typing slower the longer you have been
  // talking. This is generous enough to scroll through comfortably.
  const rendered = allBlocks.length > SCROLLBACK_BLOCKS ? allBlocks.slice(-SCROLLBACK_BLOCKS) : allBlocks;
  const offset = allBlocks.length - rendered.length;

  // Which of those actually reach Yoga. Everything else becomes a spacer of exactly
  // the height it would have occupied, so `contentHeight` — and therefore `chatOffset`
  // above, and the whole scroll mechanism — is bit-for-bit what it was when every
  // block was laid out in full. See `virtualWindow.ts`.
  if (heightsWidth.current !== width) {
    // Every recorded height was measured at a different width and is now wrong. RESCALED
    // rather than thrown away, and the difference is the whole cost of a resize.
    //
    // Discarding leaves nothing measured, and a block with no height cannot become a
    // spacer — so the very next frame lays out the entire scrollback at once. Measured
    // on this machine, idle: about 1.7ms per block, 253ms for a full window, in one
    // synchronous commit. That is the freeze, and it happened on every resize.
    //
    // Narrower text wraps to more rows and wider to fewer, in roughly that proportion,
    // so the old height times old/new width is close enough to keep the scroll maths
    // sane for the frame it takes to measure the blocks that are actually on screen.
    //
    // Only ROUGHLY, and the gap is why every scaled entry is marked. A paragraph that
    // wrapped to one row at the old width does not become 1.4 rows at a narrower one, it
    // becomes two; the error is worst exactly where the terminal is narrowest, and it
    // does not average out, because each block is rounded on its own. Left as the final
    // answer those estimates size every spacer in the virtual window, and blocks land
    // one or two rows from where they belong — text that will not settle.
    //
    // `scaled` is what stops that being permanent. The entry stays usable, so the window
    // is still virtualized and no resize lays out the whole scrollback at once; but it no
    // longer counts as measured, so the blocks that get RENDERED are laid out again and
    // replace their estimate with a fact. Bounded by what is on screen, not by the
    // length of the session.
    const ratio = heightsWidth.current > 0 ? heightsWidth.current / width : 1;
    for (const entry of blockHeights.current.values()) {
      if (ratio !== 1) entry.height = Math.max(1, Math.round(entry.height * ratio));
      entry.scaled = true;
    }
    heightsWidth.current = width;
    // Remember WHERE the reader was, as a proportion of the scrollable range, before
    // the re-wrap changes what a line means. `scrollUp` is a line count, and a line is
    // not the same distance at a different width, so a scrolled reader is otherwise
    // carried off by a resize they did not intend as navigation. Applied once the new
    // height has actually been measured — see the effect that consumes this.
    reflowFrom.current = { scrolled: scrollUp, maxScroll: Math.max(0, contentHeight - chatRows) };
  }
  // Only a MEASURED prefix can be virtualized: a block whose height is unknown cannot
  // be replaced by a spacer, because there is no honest number to give the spacer.
  // Unmeasured blocks are always the newest ones (the reducer appends, and a changed
  // block is a new object), which are also the ones on screen when pinned to the
  // bottom — so in practice this prefix is everything but the last block or two.
  let known = 0;
  const knownHeights: number[] = [];
  while (known < rendered.length) {
    const block = rendered[known]!;
    const entry = blockHeights.current.get(block.id);
    // The identity check IS the invalidation: a block that changed is a new object, so
    // its recorded height belongs to the version before the change.
    if (entry === undefined || entry.block !== block) break;
    knownHeights.push(entry.height);
    known++;
  }
  const win = virtualWindow(knownHeights, -chatOffset, chatRows);
  if (perfEnabled()) {
    // The single fact that says whether the virtualization is doing anything at all:
    // `drew` should be a small constant while `blocks` grows. If they track each
    // other, heights are not being measured and every block is still being laid out.
    const drew = win.end - win.start + (rendered.length - known);
    perf(
      `frame blocks=${rendered.length} known=${known} drew=${drew} ` +
        `rows=${chatRows} shift=${-chatOffset} content=${contentHeight}`,
    );
  }
  // Rows between the end of the window and the first unmeasured block. Rendering the
  // unmeasured tail is not optional — it is how those blocks get measured at all.
  const padMiddle = win.padBottom;

  // The status line, the queued bar, the input and whatever sits under it. Built once
  // and rendered by BOTH shells: the only thing that differs between them is where it
  // ends up — pinned to the bottom of a frame we own, or simply the last thing printed.
  const footerView = (
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        {/* One blank row between the conversation and the footer, ALWAYS.
            It lives here rather than as a margin on the status line, because the
            status line is not always rendered — a session that has not run a turn
            has nothing to report — and the gap was disappearing with it, leaving the
            last line of a reply touching the input box. A single spacer inside the
            measured footer keeps it unconditional and keeps `footerHeight` honest,
            which a margin (laid outside the box) would not. */}
        <Box flexShrink={0}><Text> </Text></Box>
        {/* Every direct child here gets its own flexShrink:0 too — same reason
            as the banner/chat wrapper above: a footer that's itself allowed to
            compress can eat its own border lines and merge rows together
            (confirmed with a bare Ink render) instead of the clean bottom-clip
            flexShrink:0 actually gives. */}
        {/* Persistent status line: spinner + timer while working,
            "✻ Cooked for 1m 23s · N tokens" once finished. */}
        <Box flexShrink={0}>
          <StatusLine busy={busy} startedAt={turnStart.current} lastMs={lastMs} usage={taskUsage} received={liveTokens} advance={advanceTokens} />
        </Box>

        {/* Messages queued while busy — sent in order when the turn ends. */}
        <Box flexShrink={0}>
          <QueuedBar queued={queued} />
        </Box>

        {/* The input box is always here; an open overlay (a picker) renders in its
            menu slot below it, so choosing something keeps the same frame instead of
            swapping the whole input area out. */}
        <Box flexShrink={0} flexDirection="column">
          {ready ? (
            <PromptInput
              onSubmit={onSend}
              opening={opening}
              disabled={false}
              placeholder={busy ? "type to queue a message…" : "say something…"}
              width={width}
              history={history}
              completions={completions}
              pathComplete={pathComplete.current}
              onLargePaste={registerPaste}
              onDroppedPaths={(text) => dropHandles.current.register(text)}
              registerCaretClick={(place) => {
                caretClick.current = place;
              }}
              registerTextSelect={(select) => {
                textSelect.current = select;
              }}
              maxMenuRows={maxMenuItems}
              menuAbove={shell === "inline"}
              settleKey={committed.length}
              onMenuChange={onMenuChange}
              placeCursor={shell === "inline"}
              onQueuePop={popQueue}
              overlay={overlayView}
            />
          ) : (
            <Box paddingX={1}>
              <Text dimColor>starting…</Text>
            </Box>
          )}
        </Box>

        {/* Below the input: the reference (NEWUI.txt) shows a "[BG] N running:
            $ cmd1 • $ cmd2" line in exactly this spot while anything is
            backgrounded, with the tip explicitly absent until it's done — not
            a separate line above the input, and not shown alongside the tip. */}
        {ctxWarn ? (
          // A compaction is near. This takes the line over the tip and the background bar:
          // it is the one thing here the user needs BEFORE it happens, since the summarizing
          // pass rewrites the conversation. Dim as it approaches, then a plain warning colour
          // with the manual way out once it is about to fire on its own.
          <Box flexShrink={0}>
            {ctxWarn.percentLeft <= 5 ? (
              <Text color="yellow">{"  context low · /compact to summarize now"}</Text>
            ) : (
              <Text dimColor>{`  ${ctxWarn.percentLeft}% until auto-compact`}</Text>
            )}
          </Box>
        ) : !overlayView && runningShells.length > 0 ? (
          <Box flexShrink={0}>
            <BackgroundBar shells={runningShells} />
          </Box>
        ) : (
          <TipLine tip={TIPS[tipIdx % TIPS.length]!} />
        )}
      </Box>
  );
  // The transcript viewport: the scrolled window, its measurements, and the chip.
  //
  // Built once and rendered by BOTH shells — the full-screen frame, and the inline
  // shell's reading view. The two want exactly the same thing there: a clipped box that
  // Yoga sizes against a pinned footer, with the transcript offset inside it. Kept as
  // two copies they would drift apart the first time either was touched, and the drift
  // would show as scrolling behaving differently in one shell than in the other.
  const chatView = (
    <Box ref={chatRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
      {/* A short conversation rests ON the footer instead of floating at the top
          of the screen. This is a flex SPACER rather than a computed margin on
          purpose: Yoga sizes it from the leftover space in the same pass that lays
          the frame out, where a margin would have to be derived from `chatRows`,
          which lags a frame and is unknown entirely on the first render. A render
          probe rejected the margin version — it left a gap on a settled frame and
          pushed the whole transcript past the clip edge on the first one.

          It shrinks to nothing the moment the transcript overflows, so the
          scrolling path below is untouched. */}
      {restsOnFooter ? <Box flexGrow={1} flexShrink={1} /> : null}
      <Box flexDirection="column" flexShrink={0} marginTop={chatOffset}>
        {/* The ref sits on a box with NO margin of its own, so the measured
            height is the content's alone and cannot drift as it scrolls. */}
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {/* Blocks scrolled off the top, as one box of exactly their height. */}
          {win.padTop > 0 ? <Box flexShrink={0} height={win.padTop} /> : null}
          {rendered.slice(win.start, win.end).map((b, i) => {
            const idx = win.start + i;
            return (
              // flexShrink:0 is load-bearing — without it Yoga compresses an
              // overfull column and silently drops rows out of the middle.
              <Box
                key={b.id}
                ref={(node: DOMElement | null) => {
                  if (node && needsMeasure(blockHeights.current.get(b.id), b)) toMeasure.current.set(b, node);
                }}
                flexShrink={0}
                flexDirection="column"
              >
                <BlockView block={b} columns={width} tightTop={isTight(allBlocks, offset + idx)} />
              </Box>
            );
          })}
          {/* Measured blocks between the window and the unmeasured tail. */}
          {padMiddle > 0 ? <Box flexShrink={0} height={padMiddle} /> : null}
          {/* The unmeasured tail. Rendered in full because there is no honest
              spacer height for a block nobody has measured yet — and rendering it
              is what produces the measurement. */}
          {rendered.slice(known).map((b, i) => {
            const idx = known + i;
            return (
              <Box
                key={b.id}
                ref={(node: DOMElement | null) => {
                  if (node && needsMeasure(blockHeights.current.get(b.id), b)) toMeasure.current.set(b, node);
                }}
                flexShrink={0}
                flexDirection="column"
              >
                <BlockView block={b} columns={width} tightTop={isTight(allBlocks, offset + idx)} />
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* The scrolled-back chip, floating on the viewport's last row.
          ABSOLUTE, and that is the whole reason it can exist here: an ordinary row
          would come out of the chat, so the viewport would shrink the moment you
          scrolled and grow back when you returned — the transcript re-laid-out and
          shifted under the reader by the act of looking at it. Out of flow, it costs
          no rows at all, contributes nothing to the height chatRef measures, and the
          viewport's own overflow:hidden clips it. Verified by render probe, not by
          reasoning about Yoga.

          It covers a few columns of one transcript row while it is up, which is the
          right trade: the row underneath is one the reader has already scrolled past,
          and the alternative is a chip that moves the text it is telling you about. */}
      {pill ? (
        <Box
          // Measured so a CLICK can find it. The row is the only part of the chip's
          // position the layout owns — the columns fall out of centring, which
          // `pillBounds` reproduces — and a pointer handler runs between frames, where
          // it could not measure anything for itself.
          ref={(node: DOMElement | null) => {
            pillRow.current = node ? measureElement(node).y : null;
          }}
          position="absolute"
          bottom={0}
          left={0}
          right={0}
          justifyContent="center"
        >
          <Text inverse>{pill}</Text>
        </Box>
      ) : null}
    </Box>
  );


  /**
   * Refilling the rows the reading frame leaves behind — IN THE SAME COMMIT.
   *
   * Closing the reading view shrinks the live region from a near-full-height frame back
   * to a couple of rows, and a terminal cannot un-scroll. Measured on the real renderer,
   * the shrink emits `eraseLine` twenty-four times and then writes two lines: twenty-two
   * rows erased with nothing put back, which is the band of empty screen below the
   * prompt. Ink is right to do this — it is how every live region shrinks — and it is
   * ordinarily invisible because a shrink normally happens when a block DRAINS into
   * <Static>, which prints the same rows permanently on its way past. Nothing drains
   * when a viewport closes, so nothing refills them.
   *
   * So the close reprints, and the reprint has to be part of the SAME frame as the
   * shrink. Driven from an effect it was one render late, and that one render is a real
   * frame the terminal paints: the erased band flashed empty and was then filled — the
   * blink reported on the way back to the bottom. Refs mutated during render are what
   * put both in one commit, the same way `maxScrollRef` above is published to handlers
   * that run between frames.
   *
   * The header is suppressed on this one, because unlike the shell switch this replaces
   * nothing — the original is still in scrollback a screen up, and a second copy in the
   * middle of the conversation reads as the session having restarted.
   */
  /**
   * The startup fill, decided during the RENDER — which is the only moment it can be.
   *
   * `<Static>` prints each item ONCE, in the render that first sees it, and the fill is
   * one of its items. An effect runs after that render has already been committed and
   * written, so a height an effect assigns arrives too late by construction: the item has
   * been printed at whatever the ref held during the render, and Static will never render
   * it again. Set from an effect, the fill was therefore printed as ZERO rows on first
   * mount, every time — verified by rendering the same shape and counting the rows it
   * emitted before the first item.
   *
   * The visible cost was the whole reason the fill exists going unpaid: the first screen
   * sat at the TOP of the terminal, with the prompt part-way up and empty rows below it,
   * because a terminal prints from wherever the cursor happens to be.
   *
   * Only for the FIRST print. Every later remount of `<Static>` — a shell switch, a
   * width-change reprint, leaving the reading view — sets the fill for its own reasons
   * before bumping the key, and those must not be overwritten here.
   */
  /**
   * The startup fill, GROWN whenever a void opens below the footer.
   *
   * The fill is a run of blank rows printed above the first screen so a short
   * conversation lands at the BOTTOM of the terminal rather than floating part-way up —
   * a terminal prints from wherever the cursor is, and prints nothing below. `<Static>`
   * emits each item once, so the fill's height is whatever `rows` held the render it was
   * first printed on, and can never change for that mount.
   *
   * That is the whole bug behind the void. The first render often runs before the real
   * terminal height is known — the size hook re-reads a moment later — so the fill was
   * frozen at a stale, small number: blank rows at the top, the conversation, and then a
   * band of empty screen all the way to the bottom edge that nothing ever filled.
   *
   * `fillBasis` is the height the current fill was sized for. When the terminal turns
   * out to be TALLER than that — the settle after a wrong first read, or the window
   * genuinely dragged bigger — the fill is regrown and `<Static>` remounted, which
   * reprints the recent conversation with the footer back at the edge. Only ever grown,
   * never shrunk: once the conversation is long enough to overflow the screen the footer
   * sits at the bottom on its own, and shrinking the fill then would reprint on every
   * small drag for a void that is not there.
   */
  if (shell === "inline") {
    const grown = growFill(fillState.current, rows);
    fillState.current = { fill: grown.fill, basis: grown.basis };
    startFill.current = grown.fill;
    // A remount reprints the recent conversation with the footer back at the edge —
    // wanted when a void has opened, skipped on the very first sizing (nothing on screen
    // yet). See startupFill.ts.
    if (grown.remount) closeEpoch.current += 1;
  }

  /**
   * Where `<Static>` was allowed to reach when the reading view opened, or null while
   * the view is closed.
   *
   * A SCROLLBACK PRINTER AND A VIEWPORT CANNOT BOTH BE WRITING. Every finished block
   * normally goes to `<Static>`, which prints it into the terminal permanently and
   * scrolls everything up to make room. That is exactly right when the live region below
   * it is two rows of prompt. It is destructive when the live region is a near
   * full-height viewport, because each print scrolls the terminal under a frame that Ink
   * then has to erase and lay down again from its new position — measured on the real
   * renderer, three blocks arriving during an open viewport erased seventy-two rows of a
   * twenty-four row terminal. What that looks like on screen is bands of blank where a
   * block is about to appear, which is the reported glitch, and it only happens while a
   * turn is still running because that is the only time new blocks arrive.
   *
   * The conflict only exists because this shell has BOTH. A scrolling viewport normally
   * holds the whole transcript itself and prints nothing permanently; a shell built on
   * `<Static>` has no viewport for a print to collide with. Running the two together is
   * this shell's own doing, so the rule it needs has to be stated here: while the
   * viewport is open, the printer holds.
   *
   * Nothing is lost by holding. The close already reprints from `reprintFrom`, which is
   * behind everything that arrived while the view was open, so those blocks reach the
   * terminal on the way out — in one frame, with the refill that fills the viewport's
   * rows, rather than a print at a time underneath it.
   */
  if (readingInline && frozenStatic.current === null) frozenStatic.current = committed.length;
  if (wasReadingInline.current && !readingInline) {
    reprintFrom.current = Math.max(0, committed.length - INLINE_REPRINT_BLOCKS);
    startFill.current = 0;
    showHeader.current = false;
    closeEpoch.current += 1;
    frozenStatic.current = null;
  }
  wasReadingInline.current = readingInline;

  // ── the inline shell ──────────────────────────────────────────────────────
  //
  // Finished blocks go to <Static>, which Ink prints ONCE and never renders again:
  // they become the terminal's own scrollback. Only the live tail and the footer are
  // re-rendered, so a frame costs what is happening now rather than what has happened
  // all session — a four-hour conversation renders exactly as fast as a four-minute one.
  //
  // Everything the fullscreen shell exists to do is simply absent here, on purpose.
  // There is no frame height, because we are not claiming the screen; no virtual window,
  // because nothing off screen is being re-laid-out; no scroll offset, because scrolling
  // is the terminal's scrollbar; and no selection layer, because selecting is the
  // terminal's selection. Each of those is faster than what we would write, and behaves
  // the way the rest of the user's terminal already does.
  //
  // The banner rides as a sentinel item rather than sitting above the list, so it prints
  // exactly once and scrolls away with the conversation instead of being reprinted at
  // the top of every frame.
  if (shell === "inline") {
    return (
      <Box flexDirection="column">
        <Static
          // Two counters, because the two remounts happen at different MOMENTS: the
          // shell switch can settle in an effect, the reading-view close has to land in
          // the frame that shrinks the live region.
          key={`${staticEpoch}:${closeEpoch.current}`}
          // `frozenStatic` caps the list while the reading viewport is open — see above.
          // `slice(from, undefined)` is `slice(from)`, so the closed case is unchanged.
          items={
            [
              FILL_ITEM,
              BANNER_ITEM,
              ...committed.slice(reprintFrom.current, frozenStatic.current ?? undefined),
            ] as StaticItem[]
          }
        >
          {(item, index) => {
            if (item === FILL_ITEM) return <Box key="fill" height={startFill.current} />;
            // Kept as an ITEM even when it renders nothing, so the `index - 2` the
            // blocks below count back is the same either way.
            if (item === BANNER_ITEM) return showHeader.current ? <InlineHeader key="banner" /> : null;
            return (
              <BlockView
                key={item.id}
                block={item}
                columns={width}
                tightTop={isTight(allBlocks, reprintFrom.current + index - 2)}
              />
            );
          }}
        </Static>
        {/* ONE wrapper, always — this is what keeps the footer from flickering.
            `footerView` is the input box, its cursor, its menu state, everything a
            reader is looking at while they scroll. It used to sit inside a ternary
            between two ENTIRELY SEPARATE `<Box>` subtrees — one for reading, one for
            the plain tail — and React reconciles children by type AND POSITION, not
            by finding a matching element wherever it moved to. Last child after
            however many tail blocks happened to exist in one branch, second child
            right after `chatView` in the other: two different positions is, to React,
            indistinguishable from two different things being there. So the footer's
            whole subtree was destroyed and a fresh one built in its place on EVERY
            transition — both entering and leaving reading — and destroy-then-create is
            exactly the flicker that was reported from both directions. Reducing this to
            one wrapper element with `footerView` always its second child, and only the
            content ABOVE it swapping, is what makes the transition change nothing about
            the one thing that has to hold still. Pinned by `footerRemount.probe.test.tsx`,
            which mounts a marker in the footer's position and asserts it survives the
            switch — a structural regression like the one above passes every other test
            in the file, since nothing else can see a remount that renders identical
            content on both sides of it. */}
        <Box
          ref={liveRef}
          flexDirection="column"
          flexShrink={0}
          // `frameHeight` and the clip are what makes reading a VIEWPORT rather than a
          // wall of text — see the shared `chatView` above. Applied to the SAME element
          // in both states, not one that only exists in one of them.
          height={readingInline ? frameHeight : undefined}
          overflow={readingInline ? "hidden" : "visible"}
        >
          {readingInline ? (
            // <Static> stays mounted above and prints nothing new: it has already
            // emitted every item it holds, and unmounting it would make the next mount
            // reprint the whole conversation underneath this frame.
            chatView
          ) : (
            tail.map((b, i) => (
              <BlockView key={b.id} block={b} columns={width} tightTop={isTight(allBlocks, committed.length + i)} />
            ))
          )}
          {footerView}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={frameHeight} overflow="hidden">
      {/* flexShrink:0 on the banner and the chat wrapper below (NOT on anything
          inside the chat viewport itself — that's untouched) protects against a
          real, confirmed failure mode: for one frame right when the command
          palette opens/resizes, chatRows is still computed from the PREVIOUS
          footerHeight (measurement lags a render), so the frame's total content
          can transiently exceed frameHeight. Without flexShrink:0 here, Yoga's
          default (shrink to fit) silently compresses the banner or drops the
          header text outright — verified with a bare Ink render. With it, the
          excess instead clips cleanly from the BOTTOM of the frame (the tail of
          the command palette), which is the harmless direction to lose content
          in, and only for the one frame until the real footerHeight lands. */}
      <Box flexShrink={0}>
        <Banner width={width} mode={mode} modelConfig={session.current?.modelConfig} busy={busy} />
      </Box>

      {/* flexGrow:1 + minHeight:1, NOT a computed height: the footer takes what it
          needs and the chat takes the rest, decided in one Yoga pass. This is what
          stops the tip line being clipped on the frame where the input box grows. */}
      {chatView}

      {/* Everything below is what footerHeight (above) measures — one Box, so a
          single measurement covers the status line, the input box, and whatever
          the command palette currently costs, whether that's open or closed. */}
      {footerView}
    </Box>
  );
}

/**
 * The inline shell's header, printed once at the top of the conversation.
 *
 * Deliberately NOT the fullscreen banner. That one is a live status bar — mode, model,
 * whether a turn is running — and <Static> prints a thing once and never touches it
 * again, so all three would be frozen at whatever they happened to be when the session
 * opened. A header that quietly lies about which model is answering is worse than no
 * header. What belongs in scrollback is the part that cannot go stale.
 */
function InlineHeader() {
  return (
    <Box marginBottom={1}>
      <Text bold color="yellow">Mindweave</Text>
      <Text dimColor>{" "}{versionLabel()}</Text>
    </Box>
  );
}

/** A sentinel <Static> item: the one-time header, printed with the transcript so it
 *  scrolls away rather than being redrawn above every frame. */
const BANNER_ITEM = "__banner__" as const;
/** A sentinel for the blank rows that push the first screen of conversation down to the
 *  bottom of the window. In the list rather than above it so it is printed exactly once,
 *  the same as the header. */
const FILL_ITEM = "__fill__" as const;
type StaticItem = typeof BANNER_ITEM | typeof FILL_ITEM | Block;

// The banner's own rows: the title line, the rule under it, and its bottom
// margin. Subtracted from the frame so the chat gets exactly what's left —
// see the layout comment at the render site.
const BANNER_ROWS = 3;
/** Always keep at least this much chat visible, even with the command palette open. */
const MIN_CHAT_ROWS = 3;
/** Conservative fixed footer cost besides the palette: the blank spacer row, the
 *  status line, the bordered input box, and the tip line. */
const FOOTER_BASE_ROWS = 7;
/** The palette's own chrome: title, the "Tab completes" hint, top+bottom border. */
const MENU_CHROME_ROWS = 4;
/** Item rows the command palette shows in the INLINE shell. Small on purpose — see the
 *  note where it is used: there, rows are paid for in terminal scroll. */
const INLINE_MENU_ROWS = 3;

/** Lines PageUp/PageDown move per press. */
const PAGE_LINES = 10;
/** Lines one wheel notch moves. Three is the usual terminal step, and a flick
 *  sends several reports, so it accumulates into a natural glide. */
const WHEEL_LINES = 3;
/** How much of the transcript stays scrollable. Every rendered block is laid out
 *  on every render, so this bounds what typing costs in a long conversation. */
const SCROLLBACK_BLOCKS = 150;
/** Blocks reprinted when the inline shell is entered. Two screens or so: enough to look
 *  back over, few enough that the reprint is not a visible pause. */
/** How long the INLINE shell waits for a drag to settle before re-reading the size.
 *  The full-screen shell does not wait — see useTerminalSize. */
const RESIZE_SETTLE_MS = 150;
/** How often the size is polled, for Windows consoles where the resize event may never
 *  fire at all (nodejs/node#13197). Two integer reads; an unchanged size costs nothing. */
const RESIZE_POLL_MS = 250;

const INLINE_REPRINT_BLOCKS = 40;

/**
 * The loom shuttle that runs beside the name while a turn is working.
 *
 * SMOOTHNESS COMES FROM HALF CELLS, not from a faster timer. Box drawing gives four
 * states for a horizontal run — light `─`, heavy on the left half `╾`, heavy on the
 * right half `╼`, heavy across `━` — so a shuttle can be positioned to half a column.
 * On a six-column track that is twelve stops instead of six, and the difference between
 * gliding and hopping is exactly that. Cycling four glyphs in one cell, which is where
 * this started, reads as a flicker rather than as travel.
 *
 * It ping-pongs rather than looping, because a shuttle on a real loom returns. A wrap
 * back to the left edge would read as a jump every cycle.
 *
 * THE STATE IS LOCAL, and that is the part that matters for cost. Held in App it would
 * re-render the entire transcript fourteen times a second for six cells; here nothing
 * above it re-renders at all, and the framebuffer's per-cell diff means the terminal
 * only ever receives the columns that actually changed.
 *
 * Idle runs no timer at all. The track sits still, which is also the honest signal:
 * motion here means work is happening, so it must not move when none is.
 */
const SHUTTLE_CELLS = 6;
/** How wide the shuttle itself is, in half cells. Two is one full column. */
const SHUTTLE_SPAN = 2;
/** One step per frame. ~14fps of travel, far below the render cap, and slow enough to
 *  read as a deliberate pass rather than a twitch. */
const SHUTTLE_MS = 70;

function Shuttle({ busy }: { busy: boolean }) {
  const stops = SHUTTLE_CELLS * 2 - SHUTTLE_SPAN + 1;
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setStep((n) => (n + 1) % (stops * 2 - 2)), SHUTTLE_MS);
    return () => clearInterval(id);
  }, [busy, stops]);

  if (!busy) return <Text dimColor>{"─".repeat(SHUTTLE_CELLS)}</Text>;

  // Fold the counter back on itself so the shuttle returns instead of wrapping.
  const pos = step < stops ? step : stops * 2 - 2 - step;
  let track = "";
  for (let cell = 0; cell < SHUTTLE_CELLS; cell++) {
    const left = cell * 2 >= pos && cell * 2 < pos + SHUTTLE_SPAN;
    const right = cell * 2 + 1 >= pos && cell * 2 + 1 < pos + SHUTTLE_SPAN;
    track += left && right ? "━" : left ? "╾" : right ? "╼" : "─";
  }
  return <Text color="yellow">{track}</Text>;
}

export function Banner({ width, mode, modelConfig, busy }: { width: number; mode: ModeId; modelConfig?: ModelConfig; busy: boolean }) {
  const m = modeById(mode);
  // The release name, not the raw semver — the version stays available through
  // --help and the update-check note; this bar is read constantly during a working
  // turn and has no room to spare for a number nobody is reading it for.
  const left = "Mindweave 1";
  // Three separate facts, so three separate colours. As one run they read as a single
  // undifferentiated status string and the eye has to parse the pipes to find the part
  // it wants. The mode keeps its own colour because that colour IS the mode's identity
  // (it is the same one the mode uses everywhere else); the model gets the teal of the
  // "reaching outside the machine" family; and the effort level is plain white, the
  // brightest thing in the row, because it is what changes most often.
  const modeText = `${m.name.toUpperCase()} MODE ON`;
  const modelText = modelConfig ? modelLabel(modelConfig.model) : "";
  const effortText = modelConfig ? thinkLabel(modelConfig).toUpperCase() : "";
  const right = modelConfig ? `${modeText} | ${modelText} | ${effortText}` : modeText;
  // The title row gets a 1-col inset (same idea as the box's own paddingX),
  // but the rule spans the FULL width, edge to edge — same as the box's
  // border below it, so the two anchor the screen the same way instead of
  // the header floating in from the sides while the box touches both edges.
  const innerWidth = Math.max(1, width - 2);
  const gap = Math.max(1, innerWidth - left.length - 1 - SHUTTLE_CELLS - right.length);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingX={1}>
        <Text bold color="yellow">{left}</Text>
        <Text>{" "}</Text>
        <Shuttle busy={busy} />
        <Text>{" ".repeat(gap)}</Text>
        <Text dimColor color={m.color}>{modeText}</Text>
        {modelConfig ? (
          <>
            <Text dimColor>{" | "}</Text>
            <Text color={KIND_COLOR.websearch}>{modelText}</Text>
            <Text dimColor>{" | "}</Text>
            <Text>{effortText}</Text>
          </>
        ) : null}
      </Box>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}

/**
 * Terminal size that updates on resize — DEBOUNCED. A drag-resize fires a flood
 * of resize events; re-rendering on each one makes a slow host (legacy cmd.exe)
 * leave stale copies of the live region in the scrollback. Updating only once the
 * resize settles (~150ms) collapses that to a single clean re-layout.
 *
 * Rows matter now in a way they didn't before alt-screen: the outer frame
 * is height-bound to this value (the middle chat region flexGrows to fill
 * whatever the header/footer don't use), so a stale row count leaves dead
 * space at the bottom instead of the frame reaching the terminal's actual edge.
 */
/**
 * The terminal's size RIGHT NOW, by live syscall where the platform offers one.
 *
 * `stdout.columns` / `stdout.rows` are getters that, on Windows, can hand back a value
 * cached at the last `resize` event — and that event frequently never fires there
 * (nodejs/node#13197). So a window dragged taller leaves those properties reporting the
 * old height forever, and everything sized from them, the full-screen frame included,
 * stops short of the real bottom edge with dead space below it.
 *
 * `getWindowSize()` asks the OS for the size on the spot (`uv_tty_get_winsize`), which is
 * not cached and not tied to the event. Preferred when present; the plain getters are the
 * fallback for a stream that has no `getWindowSize` (a pipe, a test double).
 */
export function liveTerminalSize(stream: { columns?: number; rows?: number; getWindowSize?: () => [number, number] } | undefined): {
  columns: number;
  rows: number;
} {
  const win = stream?.getWindowSize?.();
  if (win) return { columns: win[0], rows: win[1] };
  return { columns: stream?.columns ?? 80, rows: stream?.rows ?? 24 };
}

export function useTerminalSize(defer: boolean): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => liveTerminalSize(stdout));
  // Read live so the listeners below never have to be torn down and rebuilt when the
  // shell changes — resubscribing mid-drag would drop the very events being handled.
  const deferRef = useRef(defer);
  deferRef.current = defer;
  useEffect(() => {
    if (!stdout) return;

    // Identical sizes end here, and that matters more than it looks: terminals emit two
    // or more resize events for a single user action as the window settles, and each one
    // that reached state would be a re-layout of the whole frame for no change at all.
    const read = () => setSize((prev) => {
      // A LIVE query, so a Windows window dragged bigger is detected even though the
      // resize event never fired and the cached getters still report the old size.
      const next = liveTerminalSize(stdout);
      return next.columns === prev.columns && next.rows === prev.rows ? prev : next;
    });

    // The 'resize' event is NOT reliable on native Windows consoles — Node has a
    // long-standing open issue (nodejs/node#13197): unlike Unix's SIGWINCH, Windows
    // has no real signal for it, so the event can simply never fire. Relying on it
    // alone means a wrong initial read (see below) can stick forever until the user
    // happens to trigger whatever DOES make it fire. So this polls too — cheap (two
    // integer reads, ~4x/sec) and it's the standard workaround for that exact gap,
    // not a hack: it's what a resize event is supposed to give us, gotten a
    // different way when the event can't be trusted to arrive at all.
    // NOT debounced when the app owns the screen, and the debounce that used to be here
    // unconditionally is what made a drag look broken.
    //
    // A debounce opens a window where the terminal has already resized but this app still
    // believes the old size. Anything that renders during it — the spinner, the clock, a
    // streaming delta — lays a frame out at dimensions the terminal no longer has, and
    // the result is the half-drawn shapes that appear while dragging and tidy themselves
    // up the moment the drag stops. The frame is not settling late; it is being drawn
    // wrong and then drawn again. Handling the event as it arrives keeps the app's idea
    // of the size and the terminal's the same at every instant, which is the only state
    // in which a frame can be right.
    //
    // The INLINE shell still defers, and for a reason that does not apply to the other
    // one. There the transcript is the terminal's own scrollback, printed once; a
    // re-render mid-drag leaves a stale copy of the live region behind it, so a slow drag
    // left a ladder of half-drawn input boxes down the screen. Nothing is printed
    // permanently in the full-screen shell, so nothing can be left behind.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(debounce);
      if (!deferRef.current) {
        read();
        return;
      }
      debounce = setTimeout(read, RESIZE_SETTLE_MS);
    };
    stdout.on("resize", onResize);
    // The poll exists for Windows, where the event cannot be relied on at all. It goes
    // through the same handler, so it inherits whichever policy the shell is using, and
    // the identical-size check above makes a poll that finds nothing free.
    const poll = setInterval(onResize, RESIZE_POLL_MS);

    // The size read at THIS exact instant can be stale too: entering alt-screen
    // (a raw escape code written before Ink even mounts, see altScreen.ts) makes
    // the terminal reconfigure its buffer, and querying dimensions mid-reconfigure
    // can return the wrong ones. One re-read shortly after mount, once that's
    // settled, catches a wrong FIRST render that the poll above would otherwise
    // take up to 250ms to correct.
    const settle = setTimeout(read, 60);

    return () => {
      clearTimeout(debounce);
      clearTimeout(settle);
      clearInterval(poll);
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}


/** Split a /include argument into paths: quoted segments (spaces) or bare tokens. */
function parsePaths(arg: string): string[] {
  const out: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** A short, human title for a session row: its opening prompt, or a fallback. */
function sessionTitle(meta: SessionMeta): string {
  const t = (meta.firstPrompt || meta.lastPrompt || "").trim();
  if (!t) return "(untitled session)";
  return t.length <= 60 ? t : t.slice(0, 59) + "…";
}

/** Coarse relative time for the session picker: "just now", "2 hours ago", … */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The persistent status line above the input — a dot that is ALWAYS present.
 *   - idle: the dot sits dim, after a turn showing "● Worked for 1m 23s · N tokens".
 *   - working: a steady dot beside a live "Working… (12s)" timer that ticks each
 *     second, until the turn finishes.
 * Sits just ABOVE the input box, hugging it (no blank line below), with one blank
 * line above separating it from the conversation, where the
 * receipt belongs to the prompt area, not glued to the last reply.
 */
function StatusLine({
  busy,
  startedAt,
  lastMs,
  usage,
  received,
  advance,
}: {
  busy: boolean;
  startedAt: number | null;
  lastMs: number | null;
  /** The task's measured summary. Non-null as soon as the first call reports, but only
   *  rendered once the turn settles: while busy the line shows the live figure, which
   *  includes the in-flight call this one cannot yet see. */
  usage: TaskUsage | null;
  /** Output tokens received so far this turn, estimated from the streamed characters and
   *  eased toward the real total. Deliberately NOT the turn's billed cost: input does not arrive over
   *  time, so putting it here makes the counter leap and then freeze. The receipt below
   *  carries the cost. Read through a getter, fresh every frame. See dynamo/liveMeter.ts. */
  received: () => number;
  /** Advances the eased counter one frame. Called on the render clock, and separate from
   *  reading the value so the easing lives with the state, not in the view. */
  advance: () => void;
}) {
  // The render clock while busy: it advances the elapsed timer AND steps the eased token
  // counter one frame. 50ms, which is what makes the number read as counting rather than
  // as jumping — at 1Hz it moved once a second in whatever lump had arrived, which is a
  // stutter, not an animation. Nothing else re-renders with it: the tick is this
  // component's own state and the figure is read through a getter, so the cost is one
  // small subtree per frame.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      advance();
      tick((t) => t + 1);
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [busy, advance]);

  let label = null;
  if (busy && startedAt != null) {
    // `< Scampering… < 45s · ↓ 1.8k tokens >` — the reference shape. The angle brackets
    // are what make it read as a live gauge rather than a sentence, and the verb is
    // held for the whole turn (see workingVerb) so the line does not flicker between
    // words while the seconds tick.
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    // OUTPUT tokens for THIS task, estimated from what has streamed back. It is the task's
    // own work: the re-sent conversation (the whole session's context, re-billed each tool
    // round) is NOT counted here, because that is session overhead, not what this task
    // did. Output is
    // also the only thing that grows continuously while a turn runs, so it animates cleanly.
    const got = received();
    label = (
      <Text>
        {" "}
        {workingVerb(startedAt)}…{"  "}
        <Text dimColor>{"< "}{fmtElapsed(secs)}{got > 0 ? ` · ↓ ${formatTokens(got)} tokens` : ""}{" >"}</Text>
      </Text>
    );
  } else if (lastMs != null) {
    // Settled receipt: elapsed time and the turn's real token cost, shown at once,
    // no count-up.
    //
    // OUTPUT tokens for the task, the same quantity the live line counted, so the receipt
    // is where the count was going rather than a different measurement. It is the task's
    // own generation — NOT `billedTokens`, which sums the re-sent conversation across every
    // tool round and so reports the whole session's context re-read N times (a five-step
    // turn over a 58K context read ~230K). That number is session overhead, not the task's
    // work, and showing it made an ordinary turn look like a runaway one. How full the
    // context is (and when compaction fires) is a separate measure — the last prompt's
    // size — not this.
    const meter = usage ? ` · ↓ ${formatTokens(usage.outputTokens)} tokens` : "";
    label = <Text bold> Worked for {fmtElapsed(Math.round(lastMs / 1000))}{meter}</Text>;
  }

  // A fresh session that has never run a turn has nothing to report — no dot,
  // no line at all, rather than a marker floating with nothing beside it.
  if (!busy && label === null) return null;

  const dot = busy ? <Text color="cyan">●</Text> : <Text dimColor>●</Text>;

  // No marginTop: the footer owns the gap above itself now, so that it survives this
  // component rendering nothing at all. Two would read as a hole.
  return (
    <Box marginBottom={0}>
      {dot}
      {label}
    </Box>
  );
}

/** The working line's render clock. See StatusLine's tick. */
const LIVE_TICK_MS = 50;

function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Truncate a command for one-line display. */
function clipCmd(command: string, max = 44): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

function shellElapsed(sh: ShellInfo): string {
  return fmtElapsed(Math.floor((Date.now() - sh.startedAt) / 1000));
}


/**
 * The under-the-chat indicator for background shells: one running shell shows its
 * command + elapsed; several collapse to a count. It self-ticks once a second while
 * anything runs (so the timer moves), and renders nothing when idle.
 */
/** `[BG] 2 running: $ npm run dev (3000) • $ docker compose up` — every running
 *  command, not just the first or a bare count, each with the port it announced.
 *  The port comes from the process's own startup line (see detectPort), so it is
 *  shown only when the server actually said where it is listening. */
function BackgroundBar({ shells }: { shells: ShellInfo[] }) {
  // Tick once a second while anything runs, so the elapsed clock beside each command
  // actually moves — that motion is the whole point: it says the command is still
  // working, not wedged. The interval is torn down the moment nothing is running.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (shells.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [shells.length]);
  if (shells.length === 0) return null;
  const now = Date.now();
  const cmds = shells
    .map((s) => `$ ${clipCmd(s.command)}${s.port ? ` (${s.port})` : ""} ${bgClock(now - s.startedAt)}`)
    .join(" • ");
  return (
    <Box>
      <Text color="yellow">{"[BG] "}</Text>
      <Text dimColor wrap="truncate-end">{`${shells.length} running: ${cmds}`}</Text>
    </Box>
  );
}

/** Elapsed for the background bar: whole seconds under a minute, `1m 20s` past it. */
function bgClock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// One short, useful line rendered inside the input box (see PromptInput's
// `tip` prop) — picked once per session, not rewritten every render. The
// mode/model/thinking readout already lives in the header, so this slot is
// free for the shift-tab hint (nothing else states it anymore) and a few of
// the less-obvious commands.


/**
 * Messages typed while Mindweave is working, waiting to be sent when the turn ends.
 *
 * Bounded on purpose. This sits in the footer, and the footer is not height-limited:
 * past the terminal height Ink stops erasing correctly and the whole frame tears
 * rather than clipping (the same hazard the approval prompt is written around). So
 * only the first few show, and the rest are counted.
 *
 * The last line says how to take them back. Without it the queue is a one-way door
 * you cannot see the handle on — ↑ is not a thing anyone guesses, and the cost of not
 * guessing it is a message you no longer wanted being sent anyway.
 */
function QueuedBar({ queued }: { queued: Queued[] }) {
  if (queued.length === 0) return null;
  const { rows, hidden } = visibleQueue(queued);
  return (
    <Box flexDirection="column">
      {rows.map((q, i) => (
        <Text key={i} dimColor wrap="truncate-end">{"⏎ queued: "}{q.text}</Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>{`  …and ${hidden} more`}</Text>
      ) : null}
      <Text dimColor>{`  ↑ to edit ${queued.length === 1 ? "it" : "them"}`}</Text>
    </Box>
  );
}

/**
 * Whether some OTHER installed provider has a key, so `/provider` is worth
 * suggesting. With a single key configured there is nothing to switch to, and
 * offering the command is just noise on a screen the user is already unhappy with.
 */
function otherProviderHasKey(currentModel: string): boolean {
  const current = manifestForModel(currentModel).id;
  return allProviders().some((p) => p.id !== current && hasApiKey(p.apiKeyEnv));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
