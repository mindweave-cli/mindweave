/**
 * commandParse.ts — read a shell command into the commands it contains (pure).
 *
 * The command guard used to be regular expressions over the raw text, which cannot tell
 * `cat .env` from `echo ".env"`, misses the second command in `a; b`, and has no idea
 * what a command names as its arguments. This reads the text the way a shell would, far
 * enough to answer three questions: which commands run, what words each was given, and
 * whether it writes a file.
 *
 * It is NOT a shell. It does not expand variables, run substitutions or follow
 * redirections into anything clever; whatever it cannot read with certainty it says so
 * (`unreadable`), and every caller treats that as "ask", never as "allow". That one rule
 * is what lets this stay small: a construct it does not model is not a hole, it is a
 * question for the person.
 *
 * Three dialects, because Windows runs PowerShell or cmd and everything else runs a
 * POSIX shell: they differ in what is an escape (backslash in POSIX, backtick in
 * PowerShell, a caret in cmd) and a backslash in a Windows path is not an escape at all.
 */

export type Dialect = "posix" | "powershell" | "cmd";

/** One simple command: its words, the files it writes, and whether anything in it is expanded. */
export interface SimpleCommand {
  /** The words, quotes removed. words[0] is the program or cmdlet. */
  words: string[];
  /** Targets of `>` and `>>` that are not the null device. */
  writes: string[];
  /** Targets of `<`. */
  reads: string[];
  /** A `$` outside single quotes (a variable or an expression): the text is not what runs. */
  expands: boolean;
}

export interface ParsedCommand {
  commands: SimpleCommand[];
  /** Why the text cannot be read with certainty, or null. Callers ask the user when set. */
  unreadable: string | null;
}

const NULL_TARGETS = new Set(["/dev/null", "$null", "nul", "NUL", "Nul"]);

/** Split `command` into simple commands. Never throws. */
export function parseCommand(command: string, dialect: Dialect = process.platform === "win32" ? "powershell" : "posix"): ParsedCommand {
  const commands: SimpleCommand[] = [];
  let unreadable: string | null = null;
  const fail = (why: string) => {
    unreadable ??= why;
  };

  let words: string[] = [];
  let writes: string[] = [];
  let reads: string[] = [];
  let expands = false;
  let cur = "";
  let inWord = false;
  /** A redirect operator waiting for its target word. */
  let pending: ">" | "<" | null = null;

  const endWord = () => {
    if (!inWord) return;
    inWord = false;
    const word = cur;
    cur = "";
    if (pending) {
      if (pending === ">" && !NULL_TARGETS.has(word)) writes.push(word);
      if (pending === "<") reads.push(word);
      pending = null;
    } else words.push(word);
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (words.length > 0 || writes.length > 0 || reads.length > 0) commands.push({ words, writes, reads, expands });
    words = [];
    writes = [];
    reads = [];
    expands = false;
  };

  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i]!;
    const next = command[i + 1];

    // ── quotes ──
    if (c === "'") {
      inWord = true;
      let end = command.indexOf("'", i + 1);
      // In PowerShell a doubled quote inside single quotes is one literal quote: 'it''s'.
      while (dialect === "powershell" && end >= 0 && command[end + 1] === "'") {
        cur += command.slice(i + 1, end) + "'";
        i = end + 1;
        end = command.indexOf("'", i + 1);
      }
      if (end < 0) {
        fail("an unclosed quote");
        cur += command.slice(i + 1);
        break;
      }
      cur += command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < n && command[j] !== '"'; j++) {
        const d = command[j]!;
        if (d === "$") {
          expands = true;
          if (command[j + 1] === "(") fail("a command substitution inside quotes");
        }
        if (d === "`" && dialect !== "cmd") fail("a backtick inside quotes");
        // An escaped character inside double quotes.
        if ((dialect === "posix" && d === "\\" && j + 1 < n) || (dialect === "powershell" && d === "`" && j + 1 < n)) {
          cur += command[j + 1];
          j++;
          continue;
        }
        cur += d;
      }
      if (j >= n) fail("an unclosed quote");
      i = j;
      continue;
    }

    // ── escapes ──
    if (dialect === "posix" && c === "\\") {
      if (next === "\n") {
        i++;
        continue; // a line continuation
      }
      inWord = true;
      if (next !== undefined) cur += next;
      i++;
      continue;
    }
    if (dialect === "powershell" && c === "`") {
      fail("a backtick");
      inWord = true;
      continue;
    }
    if (dialect === "cmd" && c === "^") {
      fail("a caret escape");
      inWord = true;
      continue;
    }

    // ── separators ──
    if (c === "\n" || c === "\r" || c === ";") {
      endCommand();
      continue;
    }
    if (c === "&") {
      if (next === "&") i++;
      else if (next === ">") fail("a combined redirect");
      else if (words.length === 0 && !inWord) fail("the call operator");
      endCommand();
      continue;
    }
    if (c === "|") {
      if (next === "|" || next === "&") i++;
      endCommand();
      continue;
    }

    // ── redirects ──
    if (c === ">" || c === "<") {
      // A file-descriptor duplicate (2>&1, >&2) writes to no file.
      if (c === ">" && next === "&") {
        i++;
        while (command[i + 1] !== undefined && /[0-9-]/.test(command[i + 1]!)) i++;
        // The number before it was read as a word; it is not an argument.
        if (inWord && /^[0-9]$/.test(cur)) {
          cur = "";
          inWord = false;
        }
        continue;
      }
      if (c === "<" && (next === "<" || next === "(")) {
        fail(next === "<" ? "a here-document" : "a process substitution");
        endCommand();
        continue;
      }
      // `2>` and `1>`: the digit is the stream, not a word.
      if (inWord && /^[0-9]$/.test(cur)) {
        cur = "";
        inWord = false;
      } else endWord();
      if (c === ">" && next === ">") i++;
      if (c === ">" && next === "(") fail("a process substitution");
      pending = c;
      continue;
    }

    // ── whitespace ──
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }

    // ── things this reader does not model ──
    if (c === "$") {
      if (next === "(") fail("a command substitution");
      expands = true;
    }
    if (c === "`" && dialect === "posix") fail("a command substitution");
    if (c === "{" || c === "}") {
      // A script block, a brace expansion or a group. `{}` alone is find's placeholder.
      if (!(c === "{" && next === "}") && !(c === "}" && command[i - 1] === "{")) fail("a block or brace expansion");
    }
    if (c === "(" || c === ")") fail("a group or expression");
    if (c === "@" && (next === "'" || next === '"') && !inWord) fail("a here-string");
    if (c === "%" && dialect !== "cmd" && !inWord && next === "{") fail("a script block");

    inWord = true;
    cur += c;
  }
  endCommand();

  // What a command may start with that changes what runs.
  for (const cmd of commands) {
    const first = cmd.words[0];
    if (first === undefined) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) fail("an environment variable set before the command");
    if (first.startsWith("$")) fail("a variable used as the command");
    if (/^(eval|exec|source|\.|iex|invoke-expression|invoke-command|icm|start-process|saps|start|call)$/i.test(first)) {
      fail(`${first}, which runs other text as code`);
    }
    if (cmd.words.some((w) => /^-e(nc(odedcommand)?)?$/i.test(w) || /^-command$/i.test(w) || /^-c$/.test(w) && /^(bash|sh|zsh|dash)$/.test(first))) {
      fail("a program told to run a string as code");
    }
  }
  return { commands, unreadable };
}

/** The program or cmdlet a command runs, lower-cased, without a directory or a .exe. */
export function verbOf(cmd: SimpleCommand): string {
  const first = cmd.words[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}
