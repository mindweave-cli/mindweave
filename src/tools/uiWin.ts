/**
 * uiWin.ts — the Windows half of `ui`: read a window's controls and act on them.
 *
 * Built on UI Automation, the accessibility layer screen readers use. Every action here
 * goes through a control PATTERN (Invoke, Toggle, SelectionItem, ExpandCollapse, Value,
 * Scroll), which the app carries out itself. Nothing is sent through the real mouse or
 * keyboard, so the user's cursor and typing are never touched and the window can sit
 * behind others while the agent works on it.
 *
 * Like screenshotWin.ts this runs through PowerShell against .NET, which ship with the
 * OS, and the script is a string because `tsc` copies no assets into `dist/`.
 *
 * Controls are identified between calls by their UIA RuntimeId. It is stable for as
 * long as the control exists, so a number the model got from `look` still means the
 * same button a call later, and a control that has since gone away is reported as gone
 * instead of pressing whatever took its place.
 *
 * The scope is every top-level window of the target's PROCESS, not just the one window:
 * a dialog, a dropdown's popup or a context menu is its own top-level window, and an
 * agent that pressed "Save as" and could not see the dialog it opened would be stuck.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HIDDEN_MARK, DESK_CS, windowArgs } from "./hiddenDesktop.js";

const PS_TIMEOUT_MS = 30_000;

const SCRIPT = String.raw`
param([string]$Mode = "list", [string]$Handle = "", [string]$Target = "", [string]$Action = "", [string]$Text = "", [int]$Settle = 0, [string]$Desktop = "")
$ErrorActionPreference = "Stop"
$refs = @(
  [Reflection.Assembly]::LoadWithPartialName("UIAutomationClient").Location,
  [Reflection.Assembly]::LoadWithPartialName("UIAutomationTypes").Location,
  [Reflection.Assembly]::LoadWithPartialName("WindowsBase").Location
)

Add-Type -ReferencedAssemblies $refs -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class MwUi {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    // A classic Win32 button (WinForms included) refuses UIA's Invoke on the hidden desktop
    // with "not valid due to the current state", measured, while its own click message
    // works there. Posted, not sent: a click that opens a modal dialog would otherwise
    // block this script until the dialog closed.
    static bool PostClick(AutomationElement e) {
        try {
            var h = new IntPtr(e.Current.NativeWindowHandle);
            if (h == IntPtr.Zero || e.Current.ClassName.IndexOf("button", StringComparison.OrdinalIgnoreCase) < 0) return false;
            return PostMessage(h, 0x00F5 /* BM_CLICK */, IntPtr.Zero, IntPtr.Zero);
        } catch { return false; }
    }
    public static void Dpi() { SetProcessDPIAware(); }

    // The process's window that is on top: an open dialog, else the window itself. This is
    // the one to photograph, since a dialog is its own window and a picture of the window
    // under it would not show it.
    static IntPtr Top(uint pid, IntPtr fallback) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr w, IntPtr l) {
            uint p; GetWindowThreadProcessId(w, out p);
            if (p != pid || !IsWindowVisible(w) || IsIconic(w)) return true;
            if (GetWindowText(w, new StringBuilder(2), 2) == 0 && w != fallback) return true;
            found = w;
            return false;
        }, IntPtr.Zero);
        return found == IntPtr.Zero ? fallback : found;
    }

    const int MAX_ELEMENTS = 400;
    const int MAX_TEXTS = 60;

    static string Clean(string s, int max) {
        if (s == null) return "";
        var t = s.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ").Trim();
        return t.Length > max ? t.Substring(0, max - 1) + "…" : t;
    }

    static string Rid(AutomationElement e) {
        try { var r = e.GetRuntimeId(); return r == null ? "" : string.Join(".", r); } catch { return ""; }
    }

    // Every top-level window of the process that owns h, front to back. The desktop's
    // children come in z-order, so the first one is what is on top: an open dialog.
    static List<AutomationElement> Windows(IntPtr h, int pid) {
        var list = new List<AutomationElement>();
        var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
        foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, cond)) {
            try {
                var wh = new IntPtr(w.Current.NativeWindowHandle);
                if (wh != IntPtr.Zero && !IsWindowVisible(wh)) continue;
                list.Add(w);
            } catch { }
        }
        if (list.Count == 0) list.Add(AutomationElement.FromHandle(h));
        return list;
    }

    static string Kind(ControlType t) {
        if (t == null) return "control";
        var n = t.ProgrammaticName ?? "";
        n = n.StartsWith("ControlType.") ? n.Substring(12) : n;
        return n.Length == 0 ? "control" : n.ToLowerInvariant();
    }

    static readonly HashSet<string> ClickableKinds = new HashSet<string> {
        "button", "splitbutton", "menuitem", "tabitem", "listitem", "treeitem", "hyperlink",
        "checkbox", "radiobutton", "combobox", "dataitem", "headeritem"
    };

    // What can be done with this control, from the patterns it offers. Empty means it is
    // only something to read, and it is left out of the list.
    static string Actions(AutomationElement e, string kind) {
        var a = new List<string>();
        object p;
        bool invoke = e.TryGetCurrentPattern(InvokePattern.Pattern, out p);
        bool toggle = e.TryGetCurrentPattern(TogglePattern.Pattern, out p);
        bool select = e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p);
        bool expand = e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p);
        if (invoke || toggle || select || expand || ClickableKinds.Contains(kind)) a.Add("click");
        if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
            try { if (!((ValuePattern)p).Current.IsReadOnly) a.Add("type"); } catch { }
        }
        if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) {
            try {
                var s = ((ScrollPattern)p).Current;
                if (s.VerticallyScrollable || s.HorizontallyScrollable) a.Add("scroll");
            } catch { }
        }
        return string.Join(",", a);
    }

    // The state worth saying: checked, selected, expanded, disabled, the current value.
    static string State(AutomationElement e) {
        var s = new List<string>();
        object p;
        try {
            if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) {
                var st = ((TogglePattern)p).Current.ToggleState;
                s.Add(st == ToggleState.On ? "checked" : st == ToggleState.Off ? "unchecked" : "mixed");
            }
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p) && ((SelectionItemPattern)p).Current.IsSelected) s.Add("selected");
            if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
                var st = ((ExpandCollapsePattern)p).Current.ExpandCollapseState;
                if (st == ExpandCollapseState.Expanded) s.Add("expanded");
                else if (st == ExpandCollapseState.Collapsed) s.Add("collapsed");
            }
        } catch { }
        try { if (!e.Current.IsEnabled) s.Add("disabled"); } catch { }
        try { if (e.Current.IsPassword) s.Add("password"); } catch { }
        return string.Join(",", s);
    }

    static string Value(AutomationElement e) {
        object p;
        try {
            if (e.Current.IsPassword) return "";
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return Clean(((ValuePattern)p).Current.Value, 80);
        } catch { }
        return "";
    }

    // The window's own furniture: title-bar buttons and scrollbar arrows. Every window has
    // them, none of them is the app, and listing Close next to the app's buttons only
    // invites pressing it. Scrolling has its own action.
    static HashSet<string> Chrome(AutomationElement w) {
        var ids = new HashSet<string>();
        var bars = new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TitleBar),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ScrollBar));
        try {
            foreach (AutomationElement bar in w.FindAll(TreeScope.Descendants, bars)) {
                ids.Add(Rid(bar));
                foreach (AutomationElement c in bar.FindAll(TreeScope.Descendants, Condition.TrueCondition)) ids.Add(Rid(c));
            }
        } catch { }
        return ids;
    }

    // Chromium (Electron, Tauri's WebView2, browsers) builds a page's accessibility tree
    // only once something asks for it, so the very first read of a web view finds it
    // empty. Asking is what wakes it, but the process that asked keeps seeing the empty
    // tree it was first handed; a NEW reader sees the page. So this only reports that
    // the view was asleep, and the caller reads again from a fresh process.
    static bool WebAsleep(AutomationElement w) {
        try {
            var host = w.FindFirst(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ClassNameProperty, "Chrome_RenderWidgetHostHWND"));
            return host != null && host.FindAll(TreeScope.Descendants, Condition.TrueCondition).Count <= 1;
        } catch { return false; }
    }

    // The same two, run on the hidden desktop when the window lives there (MwDesk).
    public static string ListOn(string desk, IntPtr h) { return MwDesk.On(desk, () => List(h)); }
    public static string ActOn(string desk, IntPtr h, string rid, string action, string text) {
        return MwDesk.On(desk, () => Act(h, rid, action, text));
    }

    // One line per window, then one per control. Tabs separate fields; nothing inside a
    // field can contain one (Clean).
    public static string List(IntPtr h) {
        if (!IsWindow(h)) return "ERR the window is gone";
        uint pid; GetWindowThreadProcessId(h, out pid);
        var sb = new StringBuilder();
        var top = Top(pid, h);
        var topTitle = new StringBuilder(200);
        GetWindowText(top, topTitle, 200);
        sb.Append("TOP\t" + top.ToInt64() + "\t" + Clean(topTitle.ToString(), 80) + "\n");
        int count = 0, more = 0, wi = 0, texts = 0;
        var cond = new PropertyCondition(AutomationElement.IsControlElementProperty, true);
        foreach (var w in Windows(h, (int)pid)) {
            string title = "";
            try { title = Clean(w.Current.Name, 80); } catch { }
            sb.Append("WIN\t" + w.Current.NativeWindowHandle + "\t" + title + "\n");
            if (WebAsleep(w)) sb.Append("ASLEEP\n");
            AutomationElementCollection all;
            try { all = w.FindAll(TreeScope.Descendants, cond); } catch { wi++; continue; }
            var skip = Chrome(w);
            // Chromium exposes a page twice (through its render window and through the
            // app's own view tree), with different ids but the same place on screen.
            var placed = new HashSet<string>();
            string lastClickable = null;
            var windowRect = System.Windows.Rect.Empty;
            try { windowRect = w.Current.BoundingRectangle; } catch { }
            foreach (AutomationElement e in all) {
                try {
                    var rid = Rid(e);
                    if (skip.Contains(rid)) continue;
                    var kind = Kind(e.Current.ControlType);
                    // An unnamed piece inside a control already listed (the icon inside a
                    // button) is part of that control, not a second one.
                    if (lastClickable != null && rid.StartsWith(lastClickable + ".") &&
                        (e.Current.Name.Length == 0 || kind == "image" || kind == "text")) continue;
                    var acts = Actions(e, kind);
                    if (acts.Length == 0) {
                        // Words on screen that are not controls (a status line, a heading, an
                        // error message): what a model that cannot see the picture reads the
                        // result of an action from.
                        if (kind == "text" && texts < MAX_TEXTS) {
                            var words = Clean(e.Current.Name, 120);
                            if (words.Length > 0) { texts++; sb.Append("TX\t" + wi + "\t" + words + "\n"); }
                        }
                        continue;
                    }
                    var r = e.Current.BoundingRectangle;
                    // Scrolled out of the window is still THERE (the rest of a long list, which
                    // a web view reports as off-screen with no position) and can still be
                    // pressed; anything else with no size is collapsed away and not there.
                    bool outOfView = false;
                    if (r.IsEmpty || r.Width < 1 || r.Height < 1) {
                        if (!e.Current.IsOffscreen) continue;
                        outOfView = true;
                    } else if (!windowRect.IsEmpty && !r.IntersectsWith(windowRect)) {
                        outOfView = true;
                    }
                    // Remembered even when it is a duplicate, so the duplicate's own icon is
                    // recognised as part of it too.
                    if (acts.Contains("click")) lastClickable = rid;
                    if (!placed.Add(kind + "|" + e.Current.Name + "|" + (outOfView ? "off" : r.ToString()))) continue;
                    if (count >= MAX_ELEMENTS) { more++; continue; }
                    count++;
                    var state = State(e);
                    if (outOfView) state = state.Length > 0 ? state + ",out of view" : "out of view";
                    sb.Append("EL\t" + Rid(e) + "\t" + wi + "\t" + kind + "\t" + Clean(e.Current.Name, 80) + "\t" +
                              Value(e) + "\t" + acts + "\t" + state + "\n");
                } catch { }
            }
            wi++;
        }
        if (more > 0) sb.Append("MORE\t" + more + "\n");
        return sb.ToString();
    }

    static AutomationElement Find(IntPtr h, string rid) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        var cond = new PropertyCondition(AutomationElement.IsControlElementProperty, true);
        foreach (var w in Windows(h, (int)pid)) {
            AutomationElementCollection all;
            try { all = w.FindAll(TreeScope.Descendants, cond); } catch { continue; }
            foreach (AutomationElement e in all) if (Rid(e) == rid) return e;
        }
        return null;
    }

    // Carry out one action through the control's own pattern. Returns "OK <what was done>"
    // or "ERR <why not>", in words the model can act on.
    public static string Act(IntPtr h, string rid, string action, string text) {
        if (!IsWindow(h)) return "ERR the window is gone";
        var e = Find(h, rid);
        if (e == null) return "ERR GONE";
        object p = null;
        try {
            if (!e.Current.IsEnabled) return "ERR it is disabled";
            if (action == "click") {
                // Bring it into view first where it can say how, so a list item further down
                // is pressed where the user would see it.
                if (e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { try { ((ScrollItemPattern)p).ScrollIntoView(); } catch { } }
                if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) {
                    try { ((InvokePattern)p).Invoke(); }
                    catch (InvalidOperationException) { if (!PostClick(e)) throw; }
                    return "OK pressed";
                }
                if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "OK toggled"; }
                if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "OK selected"; }
                if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
                    var ec = (ExpandCollapsePattern)p;
                    if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) { ec.Collapse(); return "OK collapsed"; }
                    ec.Expand(); return "OK expanded";
                }
                return "ERR it offers no way to be pressed without the real mouse";
            }
            if (action == "type") {
                if (e.Current.IsPassword) return "ERR it is a password field; ask the user to type it";
                if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return "ERR it does not take text";
                var vp = (ValuePattern)p;
                if (vp.Current.IsReadOnly) return "ERR it is read-only";
                vp.SetValue(text);
                return "OK typed";
            }
            if (action.StartsWith("scroll")) {
                // The control itself if it scrolls, otherwise the nearest ancestor that does.
                var cur = e;
                var walker = TreeWalker.ControlViewWalker;
                while (cur != null && !cur.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) cur = walker.GetParent(cur);
                if (cur == null) {
                    // A web page's own scrolling is not exposed, but each item can bring
                    // itself into view, which is what scrolling to it is for.
                    if (e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) {
                        ((ScrollItemPattern)p).ScrollIntoView();
                        return "OK brought into view";
                    }
                    return "ERR nothing around it scrolls";
                }
                var sp = (ScrollPattern)p;
                var big = ScrollAmount.LargeIncrement; var back = ScrollAmount.LargeDecrement; var none = ScrollAmount.NoAmount;
                if (action == "scroll-down") sp.Scroll(none, big);
                else if (action == "scroll-up") sp.Scroll(none, back);
                else if (action == "scroll-right") sp.Scroll(big, none);
                else if (action == "scroll-left") sp.Scroll(back, none);
                else return "ERR unknown direction";
                return "OK scrolled";
            }
            return "ERR unknown action";
        } catch (Exception ex) {
            return "ERR " + Clean(ex.Message, 200);
        }
    }
}
${DESK_CS}
"@

[MwUi]::Dpi() | Out-Null
$h = [IntPtr][Int64]$Handle
$out = ""
if ($Mode -eq "act") {
    $t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Text.Substring(1)))
    $r = [MwUi]::ActOn($Desktop, $h, $Target, $Action, $t)
    $out = "ACT" + [char]9 + $r + [char]10
    if ($Settle -gt 0) { Start-Sleep -Milliseconds $Settle }
}
$out += [MwUi]::ListOn($Desktop, $h)
# Raw UTF-8 bytes, bypassing PowerShell's own output encoding, which garbles anything
# outside the ANSI code page (a title in another script, or a plain ellipsis).
$bytes = [System.Text.Encoding]::UTF8.GetBytes($out)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
exit 0
`;

/** One window of the process being worked on, front to back. */
export interface UiWindow {
  handle: string;
  title: string;
}

/** One control the agent can act on. */
export interface UiControl {
  /** UIA RuntimeId: what identifies it across calls. Never shown to the model. */
  id: string;
  /** Index into `windows`: which of the process's windows it is in. */
  window: number;
  kind: string;
  name: string;
  value: string;
  actions: string[];
  state: string[];
}

export interface UiSnapshot {
  /** The process's window on top (an open dialog, else the window itself): the one to
   *  photograph. */
  top?: UiWindow;
  windows: UiWindow[];
  controls: UiControl[];
  /** Text on screen that is not a control, in reading order, capped. */
  texts: { window: number; text: string }[];
  /** A web view in the window had not built its accessibility tree yet (see WebAsleep). */
  asleep?: boolean;
  /** Controls past the cap, left out of the list. */
  more: number;
  /** When an action ran first: what it did, or why it could not. */
  acted?: { ok: boolean; text: string };
  /** Set when the list could not be read at all (the window closed). */
  error?: string;
}

let scriptPath: string | null = null;

async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const dir = await mkdtemp(join(tmpdir(), "mindweave-ui-"));
  const path = join(dir, "ui.ps1");
  await writeFile(path, SCRIPT, "utf8");
  scriptPath = path;
  return path;
}

async function runScript(args: string[], signal?: AbortSignal): Promise<string> {
  const script = await ensureScript();
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`reading the window took longer than ${PS_TIMEOUT_MS / 1000}s`));
    }, PS_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("stopped"));
      else if (code === 0) resolve(out);
      else reject(new Error(err.split(/\r?\n/).find((l) => l.trim())?.trim() || `PowerShell exited ${code}`));
    });
  });
}

/** Parse the script's output. Pure, so it is tested without a desktop. */
export function parseSnapshot(stdout: string): UiSnapshot {
  const snap: UiSnapshot = { windows: [], controls: [], texts: [], more: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    const f = line.split("\t");
    if (f[0] === "ACT" && f[1] !== undefined) {
      const body = f.slice(1).join("\t");
      snap.acted = body.startsWith("OK")
        ? { ok: true, text: body.replace(/^OK\s*/, "") }
        : { ok: false, text: body.replace(/^ERR\s*/, "") };
    } else if (f[0] === "TOP" && f.length >= 3) {
      snap.top = { handle: f[1]!, title: f[2]! };
    } else if (f[0] === "WIN" && f.length >= 3) {
      snap.windows.push({ handle: f[1]!, title: f[2]! });
    } else if (f[0] === "EL" && f.length >= 8) {
      snap.controls.push({
        id: f[1]!,
        window: Number(f[2]) || 0,
        kind: f[3]!,
        name: f[4]!,
        value: f[5]!,
        actions: f[6]!.split(",").filter(Boolean),
        state: f[7]!.split(",").filter(Boolean),
      });
    } else if (f[0] === "TX" && f.length >= 3) {
      snap.texts.push({ window: Number(f[1]) || 0, text: f.slice(2).join(" ") });
    } else if (f[0] === "ASLEEP") {
      snap.asleep = true;
    } else if (f[0] === "MORE") {
      snap.more = Number(f[1]) || 0;
    } else if (f[0]?.startsWith("ERR")) {
      snap.error = line.replace(/^ERR\s*/, "");
    }
  }
  return snap;
}

/** The script's arguments for a window, and its snapshot's handles marked the same way
 *  when it lives on the hidden desktop, so a picture of it is taken there too. */
function listArgs(handle: string): string[] {
  const t = windowArgs(handle);
  return ["-Handle", t.handle, ...t.desktop];
}
function marked(snap: UiSnapshot, handle: string): UiSnapshot {
  if (!handle.startsWith(HIDDEN_MARK)) return snap;
  const mark = (w: UiWindow): UiWindow => ({ ...w, handle: HIDDEN_MARK + w.handle });
  return { ...snap, top: snap.top && mark(snap.top), windows: snap.windows.map(mark) };
}

/** Read the controls of `handle`'s process windows. */
export async function readControls(handle: string, signal?: AbortSignal): Promise<UiSnapshot> {
  return await awake(marked(parseSnapshot(await runScript(["-Mode", "list", ...listArgs(handle)], signal)), handle), handle, signal);
}

/** How many fresh reads a sleeping web view gets before its list is taken as it is. */
const WAKE_RETRIES = 2;

/**
 * A web view that was asleep has been woken by that very read, but only a new reader sees
 * the page (see WebAsleep in the script), so read again from a fresh process. The action
 * a snapshot carries is kept: it already happened and must not be repeated.
 */
async function awake(snap: UiSnapshot, handle: string, signal?: AbortSignal): Promise<UiSnapshot> {
  for (let i = 0; i < WAKE_RETRIES && snap.asleep && !snap.error; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const again = marked(parseSnapshot(await runScript(["-Mode", "list", ...listArgs(handle)], signal)), handle);
    snap = { ...again, acted: snap.acted };
  }
  return snap;
}

/** Act on one control, let the app settle, then read the controls again. */
export async function actOn(
  handle: string,
  controlId: string,
  action: "click" | "type" | `scroll-${"up" | "down" | "left" | "right"}`,
  text: string,
  settleMs: number,
  signal?: AbortSignal,
): Promise<UiSnapshot> {
  // Prefixed so the argument is never empty: an empty string does not survive the trip
  // through PowerShell's -File argument parsing.
  const b64 = "x" + Buffer.from(text, "utf8").toString("base64");
  const snap = marked(
    parseSnapshot(
      await runScript(
        ["-Mode", "act", ...listArgs(handle), "-Target", controlId, "-Action", action, "-Text", b64, "-Settle", String(settleMs)],
        signal,
      ),
    ),
    handle,
  );
  return await awake(snap, handle, signal);
}
