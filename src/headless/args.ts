/**
 * args.ts — what `mindweave -p ...` was asked to do (pure).
 *
 * Unlike the interactive launch, which ignores an argument it does not know so that a stray
 * word can never stop it from opening, a script wants the opposite: a typo in a flag must
 * fail loudly with exit 2, because a run that quietly ignored `--mdoe architect` would go on
 * to edit files in the mode the caller meant to forbid.
 *
 * The prompt is every word that is not a flag or a flag's value, joined by spaces, so
 * `mindweave -p fix the login` and `mindweave -p "fix the login"` mean the same thing.
 */
import { MODES, type ModeId } from "../cli/modes.js";
import { safeSessionId } from "../cli/startupArgs.js";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
  /** The task as typed on the command line; null when it comes from stdin alone. */
  prompt: string | null;
  format: OutputFormat;
  /** No progress lines on stderr. */
  quiet: boolean;
  /** Overrides the project's default mode for this run. */
  mode?: ModeId;
  /** Overrides the saved model for this run. Never written to the project's settings. */
  model?: string;
  /** Carry on the latest session of this folder. */
  continueLast: boolean;
  /** Carry on this session. */
  resumeId?: string;
}

export type ParsedHeadless = { ok: true; options: HeadlessOptions } | { ok: false; error: string };

const FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];

/** Flags that take a value, so the next word is theirs and not part of the prompt. */
const VALUE_FLAGS = new Set(["--output-format", "--mode", "--model", "--resume"]);

export function parseHeadlessArgs(argv: readonly string[]): ParsedHeadless {
  const words: string[] = [];
  const opts: HeadlessOptions = { prompt: null, format: "text", quiet: false, continueLast: false };
  let onlyWords = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (onlyWords || !arg.startsWith("-") || arg === "-") {
      words.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyWords = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") continue;
    if (arg === "-q" || arg === "--quiet") {
      opts.quiet = true;
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      opts.continueLast = true;
      continue;
    }

    // --flag=value or --flag value
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.has(name)) return { ok: false, error: `Unknown option: ${arg}` };
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value === "") return { ok: false, error: `${name} needs a value.` };

    if (name === "--output-format") {
      if (!FORMATS.includes(value as OutputFormat)) return { ok: false, error: `--output-format must be one of: ${FORMATS.join(", ")}.` };
      opts.format = value as OutputFormat;
    } else if (name === "--mode") {
      const ids = MODES.filter((m) => m.enabled).map((m) => m.id);
      if (!ids.includes(value as ModeId)) return { ok: false, error: `--mode must be one of: ${ids.join(", ")}.` };
      opts.mode = value as ModeId;
    } else if (name === "--model") {
      opts.model = value;
    } else {
      const id = safeSessionId(value);
      if (id === undefined) return { ok: false, error: `--resume needs a session id, got '${value}'.` };
      opts.resumeId = id;
    }
  }

  if (opts.continueLast && opts.resumeId !== undefined) return { ok: false, error: "Use --continue or --resume <id>, not both." };
  if (words.length > 0) opts.prompt = words.join(" ");
  return { ok: true, options: opts };
}
