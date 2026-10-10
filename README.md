<h1 align="center">Mindweave</h1>

<p align="center">
  A coding agent for your terminal.<br>
  You bring your own key. It runs on your machine. Nothing goes anywhere else.
</p>

<p align="center">
  <a href="LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="https://mindweavedev.netlify.app/">Website</a> &nbsp;•&nbsp;
  <a href="https://github.com/mindweave-cli/mwcode">Desktop app</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X</a>
</p>

---

Mindweave works inside your repository: it reads, searches, edits, runs commands and
checks its own work. There is no backend and no account. Your code and your key only
ever go to the model provider you picked.

Prompts are kept thin on purpose, so the context goes on your code rather than on
scaffolding.

Prefer a window to a terminal? [mwcode](https://github.com/mindweave-cli/mwcode) is the
desktop app, built on the same engine, for Windows, macOS and Linux.

## Install

Needs **Node.js 24+**. The npm package is tested on **Windows** and **Linux**. It has not
been run on a real Mac yet, so on macOS the desktop app is the safe choice
([details](KNOWN-ISSUES.md)).

```bash
npm install -g mindweave
cd your-project
mindweave          # or mw
```

It asks for an API key on first launch and keeps it in `~/.mindweave/.env`.

From source:

```bash
git clone https://github.com/mindweave-cli/mindweave
cd mindweave
npm install
npm run build
npm link
```

## What it does

- **16 providers, 63 models** — DeepSeek, Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Cerebras,
  Qwen, Kimi, GLM, Meta, MiniMax, Tencent, OpenRouter, and local models through Ollama
  with no key at all. [PROVIDERS.md](src/drivers/PROVIDERS.md)
- **Real tools** — file reads and edits, search, a shell with background jobs,
  sub-agents, web search, and a tool that tests your app by using it.
- **Code intelligence** — tree-sitter and language servers index the repo in the
  background, at no token cost, and every edit comes back with that file's errors.
- **Goals that run on their own** — `/marathon` takes a goal and keeps going until it is
  verified done, blocked, or out of budget.
- **Memory** — project notes in MINDWEAVE.md, compaction that keeps what matters, and
  earlier sessions it can look back at.
- **Safety nets** — `/undo`, `/rewind`, approval modes, per-project rules for paths
  and commands it must not touch, and a project's own servers and hooks never run unasked.
- **MCP servers** — connect external tools with `/mcp`. [docs/MCP.md](docs/MCP.md)

`/help` lists every command. `shift+tab` switches modes. Type while it works and your
message queues.

## Your own rules and hooks

Both live in your state folder (`~/.mindweave`, or `projects/<name>` inside it for one
project), never in the repository, so a project you clone cannot add them.

**`command-rules.md`** sets what Sentinel asks about, one line per rule, matched on the start
of the command:

```
allow npm test
prompt git push
forbid rm -rf :: use the trash folder
```

`forbid` refuses the command in every mode and tells the agent your reason. `prompt` always
asks. `allow` stops the question for that command, but never for one that writes a file or
that Mindweave cannot read with certainty.

**`hooks.json`** runs your own commands at set moments. Each gets one JSON object on its
input, and exit code 2 stops the action and tells the agent why:

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "run_command|edit", "command": "node check.js" } ],
  "Stop": [ { "command": "npm test --silent" } ]
} }
```

The moments are `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`.
A hook is stopped after 60 seconds unless it sets `timeoutMs`.

## More

[CHANGELOG](CHANGELOG.md) · [Known issues](KNOWN-ISSUES.md) ·
[Philosophy](PHILOSOPHY.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Contributions are welcome, model drivers especially. Bug reports are the most useful
thing you can send ([what to include](CONTRIBUTING.md#reporting-a-bug)). Questions:
zallinimann@gmail.com

## License

[Apache License 2.0](LICENSE)
