<h1 align="center">Mindweave (mwcode)</h1>

<p align="center">
  A fast, model-adaptive, terminal-native AI coding agent.<br>
  You bring your own key. It runs on your machine. Nothing goes anywhere else.
</p>

<p align="center">
  <a href="LICENSE">Apache 2.0</a> &nbsp;•&nbsp;
  <a href="https://x.com/mindweavecli">X</a> &nbsp;•&nbsp;
  <a href="https://mindweavedev.netlify.app/">Website</a>
</p>

---

## What it is

Mindweave is a coding agent that lives in your terminal and works inside your repository:
reading, searching, editing, running commands, and checking its own work.

It runs entirely on your machine. There is no backend, no telemetry and no account. Your
code and your API key never reach a Mindweave server, because there isn't one.

It is built lean on purpose. Most of a coding agent's context budget goes on scaffolding
the model never needed. Mindweave keeps prompts thin and leaves the room for the model to
reason about your code.


## Mindweave 1

Mindweave 1 is out, tagged `mindweave-1`. It is on npm, and the website is up. Install
with the steps below.

What landed in it is in the [changelog](CHANGELOG.md): fourteen model providers, a
rebuilt terminal interface, reworked prompt caching and token accounting, project notes
the agent maintains across sessions, and a long list of things that were quietly wrong.

## Install

Requires **Windows** and **Node.js 20+**. macOS and Linux are not supported yet, and the
reason is written down in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) rather than glossed over.

```bash
npm install -g mindweave
```

Then, in any project:

```bash
cd your-project
mindweave          # or mw, for short
```

To build from source instead — for development, or to run an unreleased change:

```bash
git clone https://github.com/mindweave-cli/Mindweave
cd Mindweave
npm install
npm run build
npm link          # makes the `mindweave` command available globally
```

It asks for an API key on first launch and saves it to `~/.mindweave/.env`, so every
project afterwards just works. `mindweave --help` covers the launch flags; everything
else is configured inside a session.


## What it can do

Short version, one line each. The depth is in the linked pages.

- **14 providers, 52 models, one key** — DeepSeek, Anthropic, OpenAI, Gemini, xAI,
  Mistral, Groq, Cerebras, Qwen, Kimi, GLM, Meta, MiniMax, Tencent. Only the driver you
  use is loaded. Switch with `/provider` and `/model`; remembered per project.
  [PROVIDERS.md](src/drivers/PROVIDERS.md)
- **Real tools** — read and edit files, multi-file edits, ripgrep search, a shell with
  background jobs, and sub-agents. Every edit comes back with the language server's own
  errors for that file. Read-before-edit is enforced, and `/undo` is a real net.
- **Deterministic code intelligence** — a background lane indexes your repo with
  tree-sitter and language servers, costing no tokens, so the agent understands the
  codebase, not just the open file.
- **Session memory** — automatic compaction plus a running state summary that survives
  it, and the agent can read its own earlier sessions in a project.
- **Project notes** — MINDWEAVE.md is loaded every session and maintained by the agent;
  `@./path` imports split it, a per-folder one applies only there, and `~/.mindweave/`
  holds machine-wide notes. `/init` writes the first one.
- **MCP servers** — connect external tool servers with `/mcp add` or in plain words;
  their output is untrusted by default. [docs/MCP.md](docs/MCP.md)
- **Images and web search** — drop a screenshot or write `@shot.png`; ask about a recent
  release and it looks it up, through your own provider.
- **Seeing your app** — it can capture one named window (never the whole screen, and it
  asks first) to tell an app that started from one that works.
- **Per-project governor** — standing rules, reusable skills, and forbidden paths or
  commands the agent must respect.

## Using it

| Command | What it does |
| --- | --- |
| `/help` | Lists every command |
| `/init` | Writes MINDWEAVE.md, the project notes loaded every session |
| `/provider` · `/model` · `/think` | Who answers, which model, how hard it reasons |
| `/clear` · `/continue` | Start fresh, or resume an earlier session |
| `/undo` | Reverts what the last turn changed |
| `/update` | Installs the newest version and reopens on this conversation |
| `/mcp` | Manages connected MCP servers |
| `shift-tab` | Cycles interaction modes |

Type while it works and your message queues; press up to take it back and edit it.

## Read more

| | |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and what each fix actually was |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | What is broken or unfinished, written down rather than carried quietly |
| [PHILOSOPHY.md](PHILOSOPHY.md) | How the project is run and what gets into the core. Short, and the honest version |
| [BOUNDARY.md](BOUNDARY.md) | What belongs in the core versus a driver |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Mechanics, and what is most useful to report |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [docs/MCP.md](docs/MCP.md) | Connecting and trusting MCP servers |

## Contributing

Contributions are welcome, especially **model drivers**: Ollama is a stub waiting for
someone, and a driver is a smaller job than people expect, owning one provider's wire
format and nothing about how the agent behaves.

Small fixes and reproduced bugs with a failing test can go straight to a pull request.
For anything larger, start a Discussion first. AI-assisted contributions are fine; the
one rule is that you understand and have tested what you are submitting.

Bug reports are genuinely the most useful thing you can send. Mindweave is developed by
running it on real projects and fixing what breaks, and nearly everything in the
changelog started as a failure someone watched happen. [What to include, and what is
especially worth reporting.](CONTRIBUTING.md#reporting-a-bug)

Questions are welcome at zallinimann@gmail.com

## License

[Apache License 2.0](LICENSE).
