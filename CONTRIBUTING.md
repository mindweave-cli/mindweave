# Contributing to Mindweave

First off, thank you for considering contributing to Mindweave!

Mindweave is built to be a fast, modular, terminal-native workspace for AI agents. Our core philosophy is to keep the orchestration engine vendor-neutral, while allowing specialized driver modules to deliver peak performance for every model provider.

Whether you're fixing a typo, adding a feature, or optimizing model performance under heavy context loads, your help makes this tool better for everyone.

---

## Project Goals & Architecture

* Terminal-First Experience: Blazing fast execution with zero unnecessary UI bloat.
* Modular Provider Drivers: Clean isolation between the core agent orchestrator and individual LLM API implementations (/drivers).
* Empirical Optimization: Tailoring prompt formats, tool-calling loops, and context caching per provider rather than using generic wrappers.

> **Read [BOUNDARY.md](BOUNDARY.md) before writing code.** It is one page and it
> answers the question every change in this repo has to answer first: does this
> belong in the shared core, or in one provider's driver? Getting that wrong is how
> a multi-provider agent slowly turns into a single-provider agent with extra steps.

---

## Call for Model Specialists & Domain Engineers

Are you working extensively with a specific model backend (e.g., DeepSeek, Qwen, Claude, OpenAI, Ollama, Grok, MiniMax, OpenRouter or any other open weight model)? Have you benchmarked context windows, fine-tuned prompt drivers, or solved tool-execution edge cases in production?

We are actively inviting engineers to step up as Driver Leads for specific model providers:

### What does a Driver Lead do?
* Direct Ownership: Get listed under CODEOWNERS for your designated provider directory (/drivers/<provider>).
* Architectural Influence: Shape how Mindweave handles prompt formatting, system instructions, token caching, and rate limiting for that specific model.
* Direct Feedback Loop: Help ensure your favorite API or local model delivers the absolute best user experience in a terminal environment.

If you have hands-on experience optimizing for a specific backend, open an issue or drop a comment in Discussions to claim or improve a driver!

### Who owns what right now

| Provider | Driver Lead | Status |
| --- | --- | --- |
| DeepSeek | [Niman](https://github.com/nimanni) (maintainer) | Reference driver, kept by the maintainer |
| Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Cerebras, Qwen, Kimi, GLM, Meta, MiniMax | Unclaimed | **Shipped and working. Open to a lead** |
| Ollama / local models | Unclaimed | **Not built.** A stub waiting for someone |
| OpenRouter, anything else | Unclaimed | Open |

**Thirteen providers ship today and every one except DeepSeek is free to claim.** DeepSeek is the reference driver and the maintainer keeps it, because a multi-provider architecture needs one driver that is definitively correct to measure the others against. The rest already exist and work; none has a dedicated lead, so any of them is available to anyone who wants to own it properly. Ollama is the one that is genuinely unwritten.

To claim one, open an issue saying which provider and what you have actually run it against. Prior benchmarking or production experience with the backend matters far more than TypeScript polish; the wire code is the easy part.

### What a new driver actually involves

Less than people expect. A driver owns one provider's wire format, request shape, cache breakpoints, model list, prices, context window, and any parsing repairs that provider specifically needs. It does **not** own how the agent behaves. The system prompt is byte-identical whichever provider is selected, and that is not negotiable, because the moment a driver starts teaching the model how to work, every provider added afterwards makes the product worse instead of better.

Start with [`src/drivers/README.md`](src/drivers/README.md) for the contract and the manifest/driver split, and read [BOUNDARY.md](BOUNDARY.md) before you write anything. `registry.test.ts` enforces the boundary and is the test your driver has to keep passing.

---

## How to Contribute

### 1. Reporting Bugs
Before opening an issue, check the existing issues to avoid duplicates. When filing a bug report, please include:
* Your operating system and terminal environment.
* The model provider/driver you were using.
* Clear steps to reproduce the issue (along with sanitized logs, if applicable).

### 2. Proposing Features or Architectural Changes
* For minor tweaks or bug fixes: Feel free to submit a Pull Request directly.
* For major feature additions or core orchestrator changes: Please start a thread in GitHub Discussions first so we can align on the approach.

A word on scope, so nobody wastes an afternoon: **the core is deliberately close to finished.** The default answer to "should this be added" is no. What gets merged readily is a new driver, a reproduced bug with a failing test, or a demonstrated correctness gap. What does not is a feature nobody hit a wall without. A smaller core that does its job well beats a larger one that does more, and every line in the shared engine is paid for by every provider forever.

That is the short version. The full statement of how this project is run, why the core bar is high while the driver bar is low, and exactly what evidence will change our mind about the architecture, is in [PHILOSOPHY.md](PHILOSOPHY.md). Read it before proposing anything core-shaped. It is worth knowing up front that we are looking to **replace rather than accumulate**: a proposal that adds a tool and removes nothing has to justify a permanent cost paid by every user on every turn.

### What we are working on next

**Point releases, driven by use.** 3.0 is out, and the work since has been point
releases rather than a march toward a milestone: an audit of every tool against its own
implementation, a pass on how much the agent talks and how often it re-reads what it
already has, and the defects that turned up behind both. They are in the
[changelog](CHANGELOG.md), and they came out of running the agent on an actual project
rather than from reading code.

The method is deliberately unglamorous. Take something already shipped with passing tests,
read it fresh on the assumption it is wrong, and go looking for the failure shapes this
project has been bitten by before, which are written down in [BOUNDARY.md](BOUNDARY.md).
Every pass so far has found real defects in code with hundreds of green tests.
Reproductions from your own machine are worth more here than anything else, because most
of what turns up only appears when the thing is genuinely run.

### Open problems, if you want one

These are real, currently unowned, and roughly ordered by how much they would help. Say so
in Discussions before starting so work does not collide.

* **Make macOS or Linux work.** Windows is the supported platform today. The suite was
  run on both in CI and it HANGS rather than failing: the test step passed fifteen
  minutes with no end, against three minutes for the same suite on Windows. So this is
  not a matter of confirming it works, there is a real defect to find, and the hang
  points at process handling that has only ever been exercised on Windows (process
  groups, signals, and how a spawned child is killed). Those CI jobs were removed until
  someone owns this, and they should come back in the same change that fixes it. Either
  platform is worth taking on its own.
* **Reduce what the OCaml grammar costs.** Loading it can exhaust V8 when the machine is
  already under memory pressure, which showed up for a long time as an unexplained
  intermittent test failure. Runs now get heap headroom and the grammar-heavy files run
  in their own sequential phase, so the suite is stable, but the cost itself is untouched
  and the containment is the kind that quietly stops working.
* **Cover the ripgrep search path.** `rg` is the primary engine when installed, and the
  development machine does not have it, so only the pure-Node fallback is exercised
  behaviourally. Both engines must agree, including about what they refuse to search and
  about which `.gitignore` rules they honour.
* **Reduce exploration round trips.** The agent tends to look things up one at a time
  rather than requesting everything it needs at once, and each round is a full model call.
  Repeated reads are now caught and refused, so a round costs less, but the shape is
  unchanged. Partly model behaviour, partly prompt work.
  `scripts/narration.mjs` measures it against a real session, so a change here can be
  shown to have worked rather than argued about.
* **A model driver.** Ollama is a stub and nothing else is written for local models. Twelve shipped providers have no dedicated lead either. See the table above.

Known MCP gaps, deliberately not being worked on right now:

* **OAuth for remote servers.** Servers needing authorization report `needs-auth` and stop
  there. The largest remaining MCP piece and the hardest to verify, since it needs a real
  identity provider to test against.
* **Multi-round tool requests and elicitation.** A server that needs extra input mid-call
  cannot ask for it yet.
* **Resources in the prompt box.** Resources are reachable by the agent but there is no way
  to attach one yourself with `@`.

### Especially useful right now

**MCP has been tested against one real published server and a set of fixtures written for
the purpose.** Tools have been exercised against a real `npx`-launched server end to end;
resources and prompts have not, because nothing reachable exposes them. Real servers will
find edges these did not: unusual protocol revisions, odd schemas, servers that behave
badly on shutdown. A bug report from a real server is worth more than a feature right now,
and one from a server that actually serves resources or prompts is worth more still.

**Anything the agent says that is not true.** A prompt, a menu, or a tool description that
claims something the code does not do cannot crash and does not fail tests, so it survives
until a person notices. A large share of v1.9.1 was exactly this, including a tool that
recommended a credential format that could never have worked.

### 3. Pull Request (PR) Process
1. Fork the repository and create your branch from main:
   git checkout -b feature/your-feature-name
2. Write clean, documented code adhering to the existing codebase structure.
3. Test your changes locally to ensure no regressions: `npm test` and `npm run build` must both be clean.
4. Submit your PR against the main branch with a clear description of the changes made and why.

**If you are fixing a bug, add a test that fails without your fix.** Then check that it does: revert the fix, watch the test go red, and put it back. A test that passes either way is worse than no test, because it makes the next person believe the case is covered. Several guards in this repo exist specifically because a bug could not fail loudly, and those are the ones worth getting right.

---

## Reporting a bug

**Please open an issue.** Mindweave is developed by running it on real projects and
fixing what breaks, so a reproduction from someone else's setup is genuinely the most
useful thing you can send. Nearly everything in the changelog started as a failure
someone watched happen.

Useful to include: your OS and terminal, which model you were on, and the steps that led
to it. If the agent did something odd rather than crashed, the transcript around it helps
more than a description.

Especially worth reporting:

* **Anything MCP**, particularly a server that serves resources or prompts.
* **A tool the agent was offered but could not call**, or one it insisted did not exist.
* **A prompt or menu that says something untrue.** Those cannot crash and do not fail
  tests, so they survive until a person notices. Several changelog entries are exactly
  this.

---


## AI-Assisted Contributions

AI-generated and AI-assisted code is welcome, we don't gatekeep how you write.

The one rule: **you must fully understand what you're submitting.** Know the problem you're fixing or the feature you're adding, understand why your change works, and be aware of what it affects. Test it before you open the PR. A contribution the author can't explain won't be merged, whether a human or a model wrote it.

---

## Development Rules & Integrity

* Respect License Limits: All contributions are licensed under the Apache License 2.0. Ensure any code you submit is your own or properly compatible.
* No Proprietary Leaks: Share empirical findings, behavioral optimizations, and performance improvements never proprietary code or sensitive internal data.
* Anonymity Supported: If contributing on behalf of personal research or under a secondary handle, your contributions will be reviewed purely on code quality and technical merit.

---

## Community & Questions

Got questions or want to discuss agent orchestration before writing code?
* Drop into our GitHub Discussions.
* Check out active GitHub Issues marked good first issue or help wanted.

Thank you for helping us build an open, high-performance terminal workspace for everyone!
