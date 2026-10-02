/**
 * uiPage.ts — the page route of `ui`: drive web content over the DevTools protocol.
 *
 * Where uiWin.ts asks the operating system's accessibility layer, this works inside the
 * page itself, which buys what accessibility cannot: real keys (Enter to submit, Tab,
 * Escape to close a dialog), hover, the page's own errors, and a truthful answer to
 * "could a person actually click this" — a click lands at the control's centre as a real
 * input event, after checking what is really at that spot. A button hidden under a
 * transparent overlay is reported as covered, which is exactly the bug a person would hit.
 *
 * All input goes to the page through the protocol. The user's mouse and keyboard are
 * never involved, and a headless page has no window at all.
 *
 * Controls are tagged inside the page (a WeakMap from element to number, kept on
 * `window.__mwui`), so the number behind a control survives re-renders that keep the
 * element and turns into "gone" when the element is replaced or the page navigates.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { CdpConnection, listTargets, pageTargets, type CdpTarget } from "./cdp.js";
import type { UiSnapshot } from "./uiWin.js";

/** What reading a page adds to the shared snapshot shape. */
export interface PageInfo {
  url: string;
  title: string;
  scrollY: number;
  scrollMax: number;
  width: number;
  height: number;
}

export interface PageSnapshot extends UiSnapshot {
  page?: PageInfo;
  /** Page errors (uncaught exceptions, console.error, failed loads) since the last step. */
  errors?: string[];
  /** console.warn lines since the last step (deduplicated, a few at most). */
  warnings?: string[];
  /** The viewport the session forced, when it did: the picture is that size, not the window's. */
  emulated?: { width: number; height: number; mobile: boolean };
  /** alert / confirm / prompt dialogs the step raised, and what was done with them. */
  dialogs?: string[];
  /** The step opened another page, which is now the one in use. */
  switchedTo?: string;
}

// ── the script that runs inside the page ────────────────────────────────────

/**
 * Reads the page: every control a person could use, its name and state, and the text
 * around them. Returns plain data. Kept as one string so it is sent whole each time and
 * never depends on anything the page defined.
 */
const READ_SCRIPT = String.raw`(() => {
  const S = window.__mwui || (window.__mwui = { ids: new WeakMap(), els: new Map(), next: 1 });
  const idOf = (el) => { let id = S.ids.get(el); if (!id) { id = S.next++; S.ids.set(el, id); } S.els.set(id, new WeakRef(el)); return id; };
  const txt = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const ROLE = { button: "button", link: "hyperlink", tab: "tabitem", menuitem: "menuitem", menuitemcheckbox: "menuitem",
    menuitemradio: "menuitem", checkbox: "checkbox", switch: "checkbox", radio: "radiobutton", option: "listitem",
    treeitem: "treeitem", combobox: "combobox", textbox: "edit", searchbox: "edit", slider: "slider", spinbutton: "edit" };
  const styleOf = (el) => { try { return getComputedStyle(el); } catch { return null; } };
  function kindOf(el) {
    const role = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (role && ROLE[role]) return ROLE[role];
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return "hyperlink";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "edit";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image", "file", "color"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radiobutton";
      if (t === "range") return "slider";
      return "edit";
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "edit";
    if (tag === "LABEL") return null; // its input is listed instead
    // Anything the page made clickable itself (a div with a click handler shows a pointer):
    // listed once, at the outermost element with the pointer, not at every child inheriting it.
    const st = styleOf(el);
    if (st && st.cursor === "pointer") {
      const ps = el.parentElement && styleOf(el.parentElement);
      if (!ps || ps.cursor !== "pointer") return "clickable";
    }
    if (el.hasAttribute("onclick")) return "clickable";
    return null;
  }
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return r;
  };
  function nameOf(el, kind) {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = txt(by.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || "").join(" ")); if (t) return t; }
    const al = txt(el.getAttribute("aria-label")); if (al) return al;
    if (el.labels && el.labels.length) { const t = txt([...el.labels].map((l) => l.innerText).join(" ")); if (t) return t; }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) { const v = txt(el.value); if (v) return v; }
    if (el.tagName === "INPUT" && el.type === "image") { const a = txt(el.alt); if (a) return a; }
    if (kind !== "edit" && kind !== "combobox") {
      const inner = txt(el.innerText); if (inner) return inner;
      const img = el.querySelector("img[alt]"); if (img && txt(img.alt)) return txt(img.alt);
      const st = el.querySelector("svg title"); if (st && txt(st.textContent)) return txt(st.textContent);
    }
    const title = txt(el.getAttribute("title")); if (title) return title;
    const ph = txt(el.getAttribute("placeholder") || el.getAttribute("data-placeholder")); if (ph) return ph;
    return "";
  }
  function valueOf(el, kind) {
    if (el.tagName === "INPUT" && el.type === "password") return "";
    if (el.tagName === "SELECT") return txt(el.selectedOptions[0] ? el.selectedOptions[0].text : "");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "color"].includes(el.type)) return "";
      return txt(el.value);
    }
    if (kind === "edit" && el.isContentEditable) return txt(el.innerText);
    return "";
  }
  function stateOf(el) {
    const s = [];
    const a = (n) => el.getAttribute(n);
    if (el.type === "checkbox" || el.type === "radio") s.push(el.checked ? "checked" : "unchecked");
    else if (a("aria-checked") === "true") s.push("checked");
    else if (a("aria-checked") === "false") s.push("unchecked");
    if (a("aria-selected") === "true") s.push("selected");
    if (a("aria-pressed") === "true") s.push("pressed");
    if (a("aria-expanded") === "true") s.push("expanded");
    else if (a("aria-expanded") === "false") s.push("collapsed");
    if (a("aria-current") && a("aria-current") !== "false") s.push("current");
    if (el.disabled || a("aria-disabled") === "true") s.push("disabled");
    if (el.tagName === "INPUT" && el.type === "password") s.push("password");
    if (el.required || a("aria-required") === "true") s.push("required");
    if (a("aria-invalid") === "true" || (el.validity && el.willValidate && !el.validity.valid && el.value)) s.push("invalid");
    return s;
  }
  const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

  const controls = [];
  const listed = new Set();
  let walked = 0, more = 0;
  const MAX = 400;
  function consider(el) {
    const kind = kindOf(el);
    if (!kind) return;
    let r = shown(el);
    let viaLabel = false;
    // A styled checkbox is often an invisible input behind its visible label.
    if (!r && (el.type === "checkbox" || el.type === "radio") && el.labels && el.labels[0]) { r = shown(el.labels[0]); viaLabel = true; }
    if (!r) return;
    if (controls.length >= MAX) { more++; return; }
    listed.add(el);
    const state = stateOf(el);
    if (!inView(r)) state.push("out of view");
    // Something else is on top of it at its centre: a person could not press it (a dialog's backdrop, an overlay).
    if (!viaLabel && inView(r)) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const root = el.getRootNode();
      const hit = root.elementFromPoint ? root.elementFromPoint(cx, cy) : document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) state.push("covered");
    }
    const actions = kind === "edit" || kind === "combobox" && el.tagName === "SELECT" ? ["type"] : ["click"];
    if (kind === "combobox" && el.tagName !== "SELECT") actions.push("type");
    controls.push({ id: String(idOf(el)), window: 0, kind, name: clip(nameOf(el, kind), 80), value: clip(valueOf(el, kind), 80), actions, state });
  }
  function walk(root) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let el = tw.nextNode(); el; el = tw.nextNode()) {
      if (++walked > 12000) return;
      consider(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  if (document.body) walk(document.body);

  // The words on the page that are not controls, one line per block, in reading order.
  const texts = [];
  const blockCache = new Map();
  const blockOf = (el) => {
    let e = el;
    while (e && e !== document.body) {
      if (blockCache.has(e)) return blockCache.get(e);
      const st = styleOf(e);
      if (st && st.display !== "inline" && st.display !== "contents") { blockCache.set(e, e); return e; }
      e = e.parentElement;
    }
    return document.body;
  };
  const insideControl = (el) => { for (let e = el, i = 0; e && i < 12; e = e.parentElement, i++) if (listed.has(e)) return true; return false; };
  let cur = null, buf = "", total = 0;
  const flush = () => { const t = txt(buf); if (t && texts.length < 80) { texts.push({ window: 0, text: clip(t, 200) }); total += t.length; } buf = ""; };
  if (document.body) {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n && texts.length < 80 && total < 6000; n = tw.nextNode()) {
      const t = n.data;
      if (!t || !t.trim()) continue;
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || insideControl(p) || !shown(p)) continue;
      const b = blockOf(p);
      if (b !== cur) { flush(); cur = b; }
      buf += " " + t;
    }
    flush();
  }
  // What "scrolled" means here: the page itself, or, in an app whose content scrolls
  // inside a panel (a chat, a feed), the biggest such panel.
  let se = document.scrollingElement || document.documentElement;
  if (se.scrollHeight - innerHeight < 2) {
    let best = null, area = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollHeight - el.clientHeight < 2) continue;
      const oy = (styleOf(el) || {}).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const a = el.clientWidth * el.clientHeight;
      if (a > area) { area = a; best = el; }
    }
    if (best) se = best;
  }
  const scrollMax = se === document.scrollingElement || se === document.documentElement ? se.scrollHeight - innerHeight : se.scrollHeight - se.clientHeight;
  return {
    controls, texts, more,
    page: { url: location.href, title: document.title, scrollY: Math.round(se.scrollTop), scrollMax: Math.max(0, Math.round(scrollMax)), width: innerWidth, height: innerHeight },
  };
})()`;

/** Find a tagged control again, or report it gone. Shared by every action below. */
const RESOLVE = String.raw`const S = window.__mwui; const ref = S && S.els.get(ID); const el = ref && ref.deref();
  if (!el || !el.isConnected) return { error: "GONE" };
  const describe = (e) => { if (!e || !e.tagName) return "something else"; let d = "<" + e.tagName.toLowerCase();
    if (e.id) d += ' id="' + e.id + '"'; const c = typeof e.className === "string" ? e.className.trim().split(/\s+/).slice(0, 2).join(" ") : "";
    if (c) d += ' class="' + c + '"'; d += ">"; const t = (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40); return t ? d + ' "' + t + '"' : d; };`;

/** Where to click: the control's centre, after bringing it into view, if a click there
 *  would really reach it. */
const CLICK_POINT = (id: string) => String.raw`(() => { const ID = ${id}; ${RESOLVE}
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return { error: "it is disabled" };
  if (el.tagName === "SELECT") return { error: "it is a dropdown: use type with the option to pick" };
  let t = el;
  const box = (e) => { const r = e.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 ? r : null; };
  if (!box(t) && el.labels && el.labels[0] && box(el.labels[0])) t = el.labels[0];
  t.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = box(t);
  if (!r) return { error: "it has no size on the page" };
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const root = t.getRootNode();
  const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);
  if (hit && hit !== t && !t.contains(hit) && !(t === el.labels?.[0] && hit === el)) {
    return { error: "it is covered by " + describe(hit) + " at that spot, so a click there would land on that instead" };
  }
  return { x, y };
})()`;

/** Focus a text box and select what is in it, so typing replaces it. A dropdown picks
 *  the option instead. */
const TYPE_PREP = (id: string, text: string) => String.raw`(() => { const ID = ${id}; const TEXT = ${JSON.stringify(text)}; ${RESOLVE}
  if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return { error: "it is disabled or read-only" };
  if (el.tagName === "INPUT" && el.type === "password") return { error: "PASSWORD" };
  if (el.tagName === "SELECT") {
    const want = TEXT.trim().toLowerCase();
    const opts = [...el.options];
    const opt = opts.find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
      || opts.find((o) => o.text.trim().toLowerCase().includes(want));
    if (!opt) return { error: "it has no option " + JSON.stringify(TEXT) + ". Its options: " + opts.slice(0, 20).map((o) => JSON.stringify(o.text.trim())).join(", ") };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { done: "picked " + JSON.stringify(opt.text.trim()) };
  }
  if (el.type === "checkbox" || el.type === "radio") return { error: "it is a " + el.type + ": use click" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (typeof el.select === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.select();
  else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  if (document.activeElement !== el && !el.contains(document.activeElement)) return { error: "it would not take focus" };
  return { focused: true };
})()`;

/** After typing: did the text arrive? Some inputs (date pickers, custom widgets) ignore
 *  typed text, and those get the value set directly with the events a person's typing
 *  would have fired. */
const TYPE_CHECK = (id: string, text: string) => String.raw`(() => { const ID = ${id}; const TEXT = ${JSON.stringify(text)}; ${RESOLVE}
  const now = el.isContentEditable ? el.innerText : el.value;
  if (now === TEXT || !(el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return { value: now };
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, TEXT);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { value: el.value, set: true };
})()`;

/** The centre of a control (brought into view), or of the viewport when none is named. */
const POINT = (id: string | null) => String.raw`(() => {
  ${id === null ? "return { x: innerWidth / 2, y: innerHeight / 2 };" : `const ID = ${id}; ${RESOLVE}
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: "it has no size on the page" };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`}
})()`;

/** A control's box on the page (document coordinates, padded a little so its edge shows),
 *  after bringing it into view. */
const BOX = (id: string) => String.raw`(() => { const ID = ${id}; ${RESOLVE}
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: "it has no size on the page" };
  const pad = 8, x = Math.max(0, r.left + scrollX - pad), y = Math.max(0, r.top + scrollY - pad);
  return { x, y, w: Math.min(r.width + 2 * pad, 4000), h: Math.min(r.height + 2 * pad, 4000) };
})()`;

/** The facts a person judges a control by, read off the page: size, colours, type, and the
 *  things that are usually the bug (too small, cut off, hard to read). */
const INSPECT = (id: string) => String.raw`(() => { const ID = ${id}; ${RESOLVE}
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
  const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const hex = (c) => { const v = rgb(c); return v ? "#" + [v.r, v.g, v.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("") + (v.a < 1 ? " @" + Math.round(v.a * 100) + "%" : "") : c; };
  const lum = (v) => { const f = (n) => { n /= 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); }; return 0.2126 * f(v.r) + 0.7152 * f(v.g) + 0.0722 * f(v.b); };
  let bg = null;
  for (let e = el; e && !bg; e = e.parentElement) { const v = rgb(getComputedStyle(e).backgroundColor); if (v && v.a > 0.95) bg = v; }
  if (!bg) bg = { r: 255, g: 255, b: 255, a: 1 };
  const fg = rgb(st.color);
  let contrast = null;
  if (fg) { const a = lum(fg), b = lum(bg); contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  const lines = [];
  lines.push("box: " + Math.round(r.width) + "x" + Math.round(r.height) + " at " + Math.round(r.left) + "," + Math.round(r.top) + " (viewport " + innerWidth + "x" + innerHeight + ")");
  lines.push("text: " + st.fontSize + " " + st.fontFamily.split(",")[0].replace(/["']/g, "") + " weight " + st.fontWeight + ", colour " + hex(st.color) + " on " + hex("rgb(" + bg.r + "," + bg.g + "," + bg.b + ")") + (contrast ? " (contrast " + contrast.toFixed(1) + ":1)" : ""));
  lines.push("surface: background " + hex(st.backgroundColor) + ", border " + st.borderTopWidth + " " + st.borderTopStyle + " " + hex(st.borderTopColor) + ", radius " + st.borderTopLeftRadius + ", padding " + st.padding + ", margin " + st.margin);
  lines.push("behaviour: display " + st.display + ", opacity " + st.opacity + ", cursor " + st.cursor + (el.disabled ? ", disabled" : "") + (document.activeElement === el ? ", focused" : ""));
  const issues = [];
  const clickable = el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT" || el.getAttribute("role") === "button" || st.cursor === "pointer";
  if (clickable && (r.width < 24 || r.height < 24)) issues.push("small press target (" + Math.round(r.width) + "x" + Math.round(r.height) + "; 24x24 is the least that is comfortable)");
  if ((st.overflow !== "visible" || st.textOverflow === "ellipsis") && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) issues.push("its content is cut off (" + el.scrollWidth + "x" + el.scrollHeight + " of content in " + el.clientWidth + "x" + el.clientHeight + ")");
  if (contrast && contrast < 4.5 && (el.innerText || "").trim() && parseFloat(st.fontSize) < 24) issues.push("low contrast for text this size (" + contrast.toFixed(1) + ":1; 4.5:1 is the usual bar)");
  if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) issues.push("it is outside the visible area");
  if (r.right > innerWidth + 1) issues.push("it runs past the right edge of the viewport by " + Math.round(r.right - innerWidth) + "px");
  if (st.visibility === "hidden" || Number(st.opacity) < 0.05) issues.push("it is invisible (visibility/opacity)");
  lines.push(issues.length ? "worth a look: " + issues.join("; ") : "nothing obviously wrong with it");
  return { lines };
})()`;

/** Draw each listed control's number over it, in a layer that takes no clicks, so the picture
 *  and the list speak the same numbers. Removed again right after the picture is taken. */
const ANNOTATE = (pairs: { n: number; id: string }[]) => String.raw`(() => {
  const S = window.__mwui; const old = document.getElementById("__mwui_overlay"); if (old) old.remove();
  const layer = document.createElement("div"); layer.id = "__mwui_overlay";
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
  let drawn = 0;
  for (const p of ${JSON.stringify(pairs)}) {
    const ref = S && S.els.get(Number(p.id)); const el = ref && ref.deref(); if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;box-sizing:border-box;border:1.5px solid #ff2d95;left:" + (r.left + scrollX) + "px;top:" + (r.top + scrollY) + "px;width:" + r.width + "px;height:" + r.height + "px";
    const tag = document.createElement("div");
    tag.textContent = String(p.n);
    tag.style.cssText = "position:absolute;left:-1.5px;top:-14px;min-width:14px;padding:0 3px;height:14px;line-height:14px;font:700 10px/14px monospace;color:#fff;background:#ff2d95;text-align:center;border-radius:2px";
    box.appendChild(tag); layer.appendChild(box); drawn++;
  }
  document.documentElement.appendChild(layer);
  return drawn;
})()`;

const FOCUS = (id: string) => String.raw`(() => { const ID = ${id}; ${RESOLVE} el.focus(); return { ok: true }; })()`;

// ── keys ─────────────────────────────────────────────────────────────────────

export interface KeyPress {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
}

const NAMED_KEYS: Record<string, [string, number, string?]> = {
  enter: ["Enter", 13, "\r"],
  return: ["Enter", 13, "\r"],
  tab: ["Tab", 9],
  escape: ["Escape", 27],
  esc: ["Escape", 27],
  backspace: ["Backspace", 8],
  delete: ["Delete", 46],
  space: [" ", 32, " "],
  arrowup: ["ArrowUp", 38],
  up: ["ArrowUp", 38],
  arrowdown: ["ArrowDown", 40],
  down: ["ArrowDown", 40],
  arrowleft: ["ArrowLeft", 37],
  left: ["ArrowLeft", 37],
  arrowright: ["ArrowRight", 39],
  right: ["ArrowRight", 39],
  home: ["Home", 36],
  end: ["End", 35],
  pageup: ["PageUp", 33],
  pagedown: ["PageDown", 34],
};

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };

/** Turn "Enter", "Ctrl+A", "Shift+Tab" into what the protocol needs, or null. Pure. */
export function parseKey(combo: string): KeyPress | null {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  const last = parts[parts.length - 1]!;
  const named = NAMED_KEYS[last.toLowerCase()];
  const shift = (modifiers & 8) !== 0;
  const plain = (modifiers & 7) === 0; // no Ctrl/Alt/Meta: the key types its character
  if (named) {
    const [key, keyCode, text] = named;
    return { key, code: key === " " ? "Space" : key, keyCode, text: plain ? text : undefined, modifiers };
  }
  const f = /^f([1-9]|1[0-2])$/i.exec(last);
  if (f) return { key: `F${f[1]}`, code: `F${f[1]}`, keyCode: 111 + Number(f[1]), modifiers };
  if (last.length === 1) {
    const ch = last;
    const up = ch.toUpperCase();
    const letter = /[a-z]/i.test(ch);
    const digit = /[0-9]/.test(ch);
    const key = letter ? (shift ? up : ch.toLowerCase()) : ch;
    return {
      key,
      code: letter ? `Key${up}` : digit ? `Digit${ch}` : "",
      keyCode: letter || digit ? up.charCodeAt(0) : 0,
      text: plain ? key : undefined,
      modifiers,
    };
  }
  return null;
}

// ── the session ─────────────────────────────────────────────────────────────

/** One streamed frame: a JPEG, base64, and when it was drawn (epoch ms). */
export interface CastFrame {
  data: string;
  ts: number;
  width: number;
  height: number;
}

export type PageAction = "click" | "type" | "hover" | `scroll-${"up" | "down" | "left" | "right"}`;

const MAX_ERRORS = 12;
const MAX_WARNINGS = 6;

/** What the page has to be doing nothing for, before a step counts as finished. */
const QUIET_MS = 150;

/** Resolves once the page has gone quiet: nothing in the document changed for QUIET_MS and
 *  no animation or transition that has an end is still running (a spinner that never ends
 *  does not count, or nothing would ever settle). Gives up at `max`, so a page that keeps
 *  moving is still looked at. Runs inside the page. */
const QUIET_SCRIPT = (quiet: number, max: number) => String.raw`new Promise((resolve) => {
  const start = Date.now(); let last = start;
  const mo = new MutationObserver(() => { last = Date.now(); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const moving = () => { try { return document.getAnimations().some((a) => { if (a.playState !== "running") return false;
    const t = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming(); return !t || t.endTime !== Infinity; }); } catch { return false; } };
  const tick = () => { const now = Date.now();
    if (now - start >= ${max} || (now - last >= ${quiet} && !moving())) { mo.disconnect(); resolve(true); } else setTimeout(tick, 25); };
  setTimeout(tick, 25);
})`;

/** One page being driven: its connection, and what it has reported since the last step. */
export class PageSession {
  private errors: string[] = [];
  private warnings: string[] = [];
  private dialogs: string[] = [];
  /** Requests the page has started and not finished: a step is not over while data is on its way. */
  private inflight = new Set<string>();
  /** The viewport this session forced (a phone, a narrow window), if it did. */
  emulated: { width: number; height: number; mobile: boolean } | null = null;
  /** Where screencast frames go while the page is being streamed (see startCast). */
  private castTo: ((frame: CastFrame) => void) | null = null;
  private casting = false;
  private constructor(
    public conn: CdpConnection,
    public port: number,
    public target: CdpTarget,
    /** Set when this session started the browser, so closing it stops the browser too. */
    private owned?: { close(): Promise<void> },
  ) {
    conn.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number } | undefined;
      const what = (d?.exception?.description ?? d?.text ?? "an error").split("\n")[0];
      this.error(`${what}${d?.url ? ` (${shortUrl(d.url)}:${(d.lineNumber ?? 0) + 1})` : ""}`);
    });
    conn.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error" && p.type !== "assert" && p.type !== "warning") return;
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const line = args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" ").split("\n")[0]!;
      if (p.type === "warning") this.warn(`console.warn: ${line}`);
      else this.error(`console.error: ${line}`);
    });
    conn.on("Network.requestWillBeSent", (p) => {
      this.inflight.add(String(p.requestId));
    });
    for (const done of ["Network.loadingFinished", "Network.loadingFailed"]) {
      conn.on(done, (p) => {
        this.inflight.delete(String(p.requestId));
      });
    }
    conn.on("Log.entryAdded", (p) => {
      const e = p.entry as { level?: string; text?: string; url?: string } | undefined;
      if (e?.level !== "error") return;
      // The browser asks every site for a favicon on its own; a missing one is not the
      // page's error and sends the model chasing a file nothing asked for.
      if (e.url && /\/favicon\.ico(\?|$)/i.test(e.url)) return;
      this.error(`${e.text ?? "error"}${e.url ? ` (${shortUrl(e.url)})` : ""}`);
    });
    // A dialog stops the page until it is answered, so it is answered at once: accepted,
    // as the person who pressed the button meant, and reported so the model knows it
    // happened and what it said.
    // Each frame must be acknowledged before the browser sends the next, which is also
    // what keeps a slow receiver from being buried: frames it has not taken are skipped.
    conn.on("Page.screencastFrame", (p) => {
      void conn.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      const m = (p.metadata ?? {}) as { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
      this.castTo?.({
        data: String(p.data ?? ""),
        ts: typeof m.timestamp === "number" ? Math.round(m.timestamp * 1000) : Date.now(),
        width: Math.round(m.deviceWidth ?? 0),
        height: Math.round(m.deviceHeight ?? 0),
      });
    });
    conn.on("Page.javascriptDialogOpening", (p) => {
      this.dialogs.push(`${String(p.type ?? "alert")} dialog: "${String(p.message ?? "").slice(0, 200)}" (accepted)`);
      void conn.send("Page.handleJavaScriptDialog", { accept: true, promptText: "" }).catch(() => {});
    });
  }

  /** Attach to a page behind a local debugging port. `pick` narrows by title or address. */
  static async attach(port: number, pick?: string, owned?: { close(): Promise<void> }): Promise<{ session: PageSession; others: CdpTarget[] }> {
    const pages = pageTargets(await listTargets(port));
    if (pages.length === 0) throw new Error(`port ${port} has no page to drive`);
    const needle = pick?.toLowerCase();
    const target = (needle && pages.find((p) => p.title.toLowerCase().includes(needle) || p.url.toLowerCase().includes(needle))) || pages[0]!;
    const conn = await CdpConnection.open(target.webSocketDebuggerUrl!);
    const session = new PageSession(conn, port, target, owned);
    await Promise.all([
      conn.send("Runtime.enable"),
      conn.send("Log.enable"),
      conn.send("Page.enable"),
      conn.send("Network.enable"),
    ]);
    return { session, others: pages.filter((p) => p !== target) };
  }

  get closed(): boolean {
    return this.conn.closed;
  }

  /**
   * Stream the page as it changes. The browser sends a frame only when something on it
   * moved, so a still page costs nothing, and a moving one arrives as video.
   */
  async startCast(to: (frame: CastFrame) => void): Promise<void> {
    this.castTo = to;
    if (this.casting || this.conn.closed) return;
    this.casting = true;
    try {
      await this.conn.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
    } catch {
      this.casting = false; // a page that cannot stream still works; it just is not shown live
    }
  }

  async stopCast(): Promise<void> {
    if (!this.casting) return;
    this.casting = false;
    await this.conn.send("Page.stopScreencast").catch(() => {});
  }

  private error(line: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push(line.slice(0, 300));
  }

  private warn(line: string): void {
    const l = line.slice(0, 300);
    if (this.warnings.length < MAX_WARNINGS && !this.warnings.includes(l)) this.warnings.push(l);
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const res = await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const ex = res.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    if (ex) throw new Error((ex.exception?.description ?? ex.text ?? "the page script failed").split("\n")[0]);
    return (res.result as { value?: T } | undefined)?.value as T;
  }

  /** Wait until the page has finished loading, riding out a navigation in progress. */
  private async settle(ms: number): Promise<void> {
    if (ms > 0) {
      // `ms` is the most to wait, not a fixed pause: a click on a page that answers at once
      // is over in a fraction of it. A moment for the handler to run, then until the requests
      // it started are back, then until the page has stopped changing.
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, Math.min(ms, 60)));
      while (this.inflight.size > 0 && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
      const left = Math.max(ms - (Date.now() - t0), QUIET_MS + 50);
      try {
        await this.evaluate(QUIET_SCRIPT(QUIET_MS, left));
      } catch {
        // A navigation replaced the document under the wait; the load check below takes over.
        await new Promise((r) => setTimeout(r, Math.min(left, 300)));
      }
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate<string>("document.readyState")) === "complete") return;
      } catch {
        // The old document is gone and the new one is not ready to answer yet.
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Read the page: controls, text, where it is scrolled, and what it reported. */
  async read(): Promise<PageSnapshot> {
    let raw: { controls: UiSnapshot["controls"]; texts: UiSnapshot["texts"]; more: number; page: PageInfo } | undefined;
    for (let i = 0; i < 3 && !raw; i++) {
      try {
        raw = await this.evaluate(READ_SCRIPT);
      } catch (e) {
        if (i === 2) throw e;
        await this.settle(300); // navigating mid-read; wait for the new page
      }
    }
    const snap: PageSnapshot = {
      windows: [{ handle: this.target.id, title: raw!.page.title || shortUrl(raw!.page.url) }],
      controls: raw!.controls,
      texts: raw!.texts,
      more: raw!.more,
      page: raw!.page,
    };
    if (this.errors.length) snap.errors = this.errors.splice(0);
    if (this.warnings.length) snap.warnings = this.warnings.splice(0);
    if (this.emulated) snap.emulated = { ...this.emulated };
    if (this.dialogs.length) snap.dialogs = this.dialogs.splice(0);
    return snap;
  }

  /** Go to an address, waiting for it to load. */
  async navigate(url: string): Promise<void> {
    const res = await this.conn.send("Page.navigate", { url });
    if (typeof res.errorText === "string" && res.errorText) throw new Error(`could not open ${url}: ${res.errorText}`);
    await this.settle(200);
  }

  async back(settleMs: number): Promise<string> {
    const had = await this.evaluate<number>("history.length");
    if (had <= 1) return "ERR there is no page to go back to";
    await this.evaluate("history.back()");
    await this.settle(settleMs);
    return "OK went back";
  }

  /** Carry out one action on a control. Returns "OK …" or "ERR …" like the window route. */
  async act(controlId: string, action: PageAction, text: string, settleMs: number): Promise<string> {
    const id = /^\d+$/.test(controlId) ? controlId : "0";
    try {
      if (action === "click") {
        const at = await this.evaluate<{ x?: number; y?: number; error?: string }>(CLICK_POINT(id));
        if (at.error) return `ERR ${at.error}`;
        await this.mouse(at.x!, at.y!, true);
        await this.settle(settleMs);
        return "OK pressed";
      }
      if (action === "hover") {
        const at = await this.evaluate<{ x?: number; y?: number; error?: string }>(POINT(id));
        if (at.error) return `ERR ${at.error}`;
        await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
        await this.settle(settleMs);
        return "OK hovering";
      }
      if (action === "type") {
        const prep = await this.evaluate<{ focused?: boolean; done?: string; error?: string }>(TYPE_PREP(id, text));
        if (prep.error === "PASSWORD") return "ERR it is a password field; ask the user to type it";
        if (prep.error) return `ERR ${prep.error}`;
        if (prep.done) {
          await this.settle(settleMs);
          return `OK ${prep.done}`;
        }
        if (text) await this.conn.send("Input.insertText", { text });
        else await this.key(parseKey("Delete")!);
        await this.evaluate(TYPE_CHECK(id, text));
        await this.settle(settleMs);
        return "OK typed";
      }
      // scroll: a real wheel over the control (or the middle of the page), which scrolls
      // whatever would scroll under a person's pointer there.
      const at = await this.evaluate<{ x?: number; y?: number; error?: string }>(POINT(controlId === "" ? null : id));
      if (at.error) return `ERR ${at.error}`;
      const before = await this.scrollState(at.x!, at.y!);
      const h = await this.evaluate<number>("innerHeight");
      const step = Math.round(h * 0.8);
      const dir = action.slice("scroll-".length);
      await this.conn.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: at.x,
        y: at.y,
        deltaX: dir === "left" ? -step : dir === "right" ? step : 0,
        deltaY: dir === "up" ? -step : dir === "down" ? step : 0,
      });
      await this.settle(Math.max(settleMs, 300));
      const after = await this.scrollState(at.x!, at.y!);
      return after === before ? "ERR nothing moved: it is already at that end, or nothing there scrolls" : "OK scrolled";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `ERR ${msg}`;
    }
  }

  /** Press a key (or combination), in the named control or wherever focus is. */
  async pressKey(combo: string, controlId: string | null, settleMs: number): Promise<string> {
    const k = parseKey(combo);
    if (!k) return `ERR "${combo}" is not a key this knows. Use names like Enter, Tab, Escape, ArrowDown, or a combination like Ctrl+A`;
    if (controlId !== null) {
      const f = await this.evaluate<{ error?: string }>(FOCUS(/^\d+$/.test(controlId) ? controlId : "0"));
      if (f.error) return `ERR ${f.error === "GONE" ? "GONE" : f.error}`;
    }
    await this.key(k);
    await this.settle(settleMs);
    return "OK pressed";
  }

  private async key(k: KeyPress): Promise<void> {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.conn.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  private async mouse(x: number, y: number, click: boolean): Promise<void> {
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    if (!click) return;
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Where everything that could scroll under (x, y) is scrolled to, as one string to
   *  compare: the element there and each of its ancestors, then the page. An app whose
   *  content scrolls inside a panel (a chat, a sidebar) never moves the page itself. */
  private async scrollState(x: number, y: number): Promise<string> {
    try {
      return await this.evaluate<string>(
        `(() => { const out = []; let e = document.elementFromPoint(${x}, ${y}); ` +
          `for (; e; e = e.parentElement) out.push(e.scrollTop + "," + e.scrollLeft); ` +
          `const se = document.scrollingElement || document.documentElement; out.push(se.scrollTop + "," + se.scrollLeft); return out.join("|"); })()`,
      );
    } catch {
      return "";
    }
  }

  /** Wait until some text is on the page (or, with `gone`, is no longer), up to `timeoutMs`.
   *  Returns "OK …" once it is, or "ERR …" saying what was there instead. */
  async waitFor(opts: { text?: string; gone?: string; ms: number }): Promise<string> {
    const want = (opts.text ?? "").trim().toLowerCase();
    const leave = (opts.gone ?? "").trim().toLowerCase();
    const deadline = Date.now() + opts.ms;
    const has = (needle: string) =>
      this.evaluate<boolean>(
        `(() => { const n = ${JSON.stringify(needle)}; const all = (document.body ? document.body.innerText : "").toLowerCase(); if (all.includes(n)) return true;` +
          ` for (const el of document.querySelectorAll("input,textarea,select,[aria-label],[title]")) { const v = ((el.value || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).toLowerCase(); if (v.includes(n)) return true; } return false; })()`,
      ).catch(() => false);
    const started = Date.now();
    for (;;) {
      const okWant = !want || (await has(want));
      const okGone = !leave || !(await has(leave));
      if (okWant && okGone) return `OK ${want ? `"${opts.text}" is on the page` : `"${opts.gone}" is gone`} (after ${Date.now() - started}ms)`;
      if (Date.now() >= deadline) {
        return `ERR after ${Math.round(opts.ms / 1000)}s ${want && !okWant ? `"${opts.text}" never appeared` : `"${opts.gone}" never went away`}`;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Force the viewport to a size (a phone, a narrow window), or give it back with 0x0. */
  async resize(width: number, height: number, mobile: boolean): Promise<string> {
    if (width <= 0 || height <= 0) {
      await this.conn.send("Emulation.clearDeviceMetricsOverride");
      this.emulated = null;
      await this.settle(250);
      return "OK viewport back to the window's own size";
    }
    await this.conn.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
    await this.conn.send("Emulation.setTouchEmulationEnabled", { enabled: mobile }).catch(() => {});
    this.emulated = { width, height, mobile };
    await this.settle(300);
    return `OK viewport is now ${width}x${height}${mobile ? " (phone-style, with touch)" : ""}`;
  }

  /** What a control looks like and is: its box, its computed style, and what is wrong with
   *  it a person would notice (too small to press, text cut off, low contrast). */
  async inspect(controlId: string): Promise<string> {
    const id = /^\d+$/.test(controlId) ? controlId : "0";
    const r = await this.evaluate<{ error?: string; lines?: string[] }>(INSPECT(id));
    if (r.error) return `ERR ${r.error}`;
    return `OK ${(r.lines ?? []).join("\n")}`;
  }

  /** A picture of what the page shows now: the viewport, the whole page, or one control. */
  async screenshot(path: string, opts: { controlId?: string; full?: boolean; annotate?: { n: number; id: string }[] } = {}): Promise<{ width: number; height: number }> {
    const params: Record<string, unknown> = { format: "png" };
    if (opts.annotate?.length) await this.evaluate(ANNOTATE(opts.annotate)).catch(() => {});
    if (opts.controlId) {
      const id = /^\d+$/.test(opts.controlId) ? opts.controlId : "0";
      const box = await this.evaluate<{ error?: string; x?: number; y?: number; w?: number; h?: number }>(BOX(id));
      if (box.error) throw new Error(box.error === "GONE" ? "that control is gone: the page changed since the last look" : box.error);
      params.clip = { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (opts.full) {
      const size = await this.evaluate<{ w: number; h: number }>(
        `({ w: Math.max(document.documentElement.scrollWidth, innerWidth), h: Math.max(document.documentElement.scrollHeight, innerHeight) })`,
      );
      params.clip = { x: 0, y: 0, width: size.w, height: Math.min(size.h, 8000), scale: 1 };
      params.captureBeyondViewport = true;
    }
    let res: Record<string, unknown>;
    try {
      res = await this.conn.send("Page.captureScreenshot", params, 20_000);
    } finally {
      if (opts.annotate?.length) await this.evaluate('document.getElementById("__mwui_overlay")?.remove()').catch(() => {});
    }
    const data = Buffer.from(String(res.data ?? ""), "base64");
    await writeFile(path, data);
    // The picture's bytes, so the caller can tell when nothing changed.
    this.lastShot = createHash("sha1").update(data).digest("hex");
    // PNG header: width and height at bytes 16 and 20.
    return data.length > 24 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : { width: 0, height: 0 };
  }

  /** A fingerprint of the last picture taken. */
  lastShot = "";

  /** Pages behind the same port that were not there before (a link opened a new tab). */
  async newPages(known: Set<string>): Promise<CdpTarget[]> {
    try {
      return pageTargets(await listTargets(this.port)).filter((t) => !known.has(t.id));
    } catch {
      return [];
    }
  }

  async pageIds(): Promise<Set<string>> {
    try {
      return new Set(pageTargets(await listTargets(this.port)).map((t) => t.id));
    } catch {
      return new Set();
    }
  }

  /** Move to another page behind the same port (a tab the last step opened). */
  async switchTo(target: CdpTarget): Promise<PageSession> {
    const owned = this.owned;
    this.owned = undefined; // the browser stays up: it now belongs to the new session
    this.conn.close();
    const conn = await CdpConnection.open(target.webSocketDebuggerUrl!);
    const next = new PageSession(conn, this.port, target, owned);
    await Promise.all([conn.send("Runtime.enable"), conn.send("Log.enable"), conn.send("Page.enable"), conn.send("Network.enable")]);
    return next;
  }

  /** Stop driving this page; a browser this session started is stopped too. */
  async close(): Promise<void> {
    this.conn.close();
    await this.owned?.close();
  }
}

/** An address short enough for an error line: host and path, no query. Pure. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return u.pathname.split("/").slice(-2).join("/");
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

/** Is this address on this machine (a dev server, a local file)? Pure. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "file:" || u.protocol === "about:" || u.protocol === "data:") return true;
    return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}
