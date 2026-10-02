/**
 * The user's profile: machine-wide facts about the PERSON, not the project.
 * Kept in `~/.mindweave/profile.json` beside the rest of the machine-wide state, so the
 * app and the CLI read the same one.
 *
 * What to call them, how much they want explained, and how long replies should be. Each
 * set value becomes one line in the system prompt; an unset one says nothing, so the
 * model's own default stands. Read synchronously and cached, because the system prompt is
 * built every turn and this is a tiny file that changes about once ever; a save in this
 * process updates the cache, and another process picks it up on its next start.
 */
import { stateRoot } from "./store.js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Level = "beginner" | "intermediate" | "expert";
export type Style = "concise" | "balanced" | "detailed";

export interface Profile {
  /** What the user wants to be called. Empty means nothing is said about it. */
  name: string;
  /** How much they want explained. Empty: not set. */
  level: Level | "";
  /** How long replies should be. Empty: not set. */
  style: Style | "";
}

const LEVELS: readonly Level[] = ["beginner", "intermediate", "expert"];
const STYLES: readonly Style[] = ["concise", "balanced", "detailed"];

/** Written as instructions the model can act on, not as labels it has to interpret. */
const LEVEL_TEXT: Record<Level, string> = {
  beginner:
    "The user is new to programming. Explain what you are doing and why in plain words, " +
    "define a technical term the first time you use it, and when they need to act, give exact " +
    "steps: which file, which command, where to click.",
  intermediate:
    "The user is a working developer. Skip the basics, but explain any decision or trade-off " +
    "that isn't obvious from the code.",
  expert:
    "The user is an experienced engineer. Do not explain standard concepts, tools or syntax. " +
    "Be terse and technical, and raise only the trade-offs, risks and edge cases they would want to know.",
};
const STYLE_TEXT: Record<Style, string> = {
  concise:
    "Keep replies short: lead with the answer or the result, no preamble, and no step-by-step " +
    "recap of what you did. A few sentences unless the task truly needs more.",
  balanced:
    "Keep replies moderate: the answer or result first, then only the details that matter to it, " +
    "without an exhaustive walkthrough.",
  detailed:
    "Give thorough replies: explain your reasoning, what you changed and why, the alternatives " +
    "you considered, and anything the user should check.",
};

const pick = <T extends string>(allowed: readonly T[], raw: unknown): T | "" =>
  allowed.includes(raw as T) ? (raw as T) : "";

const MAX_NAME = 60;

export function profilePath(stateDir = stateRoot()): string {
  return join(stateDir, "profile.json");
}

/** Trim, collapse whitespace, strip control characters and clip: it goes into the prompt. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

let cached: Profile | undefined;

export function readProfile(path = profilePath()): Profile {
  if (cached && path === profilePath()) return cached;
  let profile: Profile = { name: "", level: "", style: "" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Profile>;
    profile = { name: cleanName(parsed.name), level: pick(LEVELS, parsed.level), style: pick(STYLES, parsed.style) };
  } catch {
    /* no profile yet */
  }
  if (path === profilePath()) cached = profile;
  return profile;
}

/** Save the profile and return what was actually stored (the cleaned form). */
export function saveProfile(next: Partial<Profile>, path = profilePath()): Profile {
  const current = readProfile(path);
  const profile: Profile = {
    name: cleanName(next.name ?? current.name),
    level: next.level === undefined ? current.level : pick(LEVELS, next.level),
    style: next.style === undefined ? current.style : pick(STYLES, next.style),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2), "utf8");
  if (path === profilePath()) cached = profile;
  return profile;
}

/** The lines the system prompt carries, or nothing when nothing is set. */
export function profilePrompt(profile: Profile): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`The user's name is ${profile.name}. Use it where it's natural, not in every reply.`);
  if (profile.level) lines.push(LEVEL_TEXT[profile.level]);
  if (profile.style) lines.push(STYLE_TEXT[profile.style]);
  if (!lines.length) return "";
  // Said to win outright: the base prompt has its own length and explanation guidance,
  // and a preference the user set on purpose has to beat a default nobody chose.
  return (
    "The user set these preferences themselves. Where they differ from the default guidance " +
    "above on length or how much to explain, follow these instead:\n" +
    lines.map((l) => `- ${l}`).join("\n")
  );
}
