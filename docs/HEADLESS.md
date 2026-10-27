# Running Mindweave from a script

`mindweave -p "task"` does one task and exits. There is no screen: the answer goes to stdout, so it
works in a shell script, a pipeline or a CI job.

```bash
mindweave -p "fix the failing test in src/auth"
git diff | mindweave -p "review this change"
mindweave -p "list the TODOs" --output-format json | jq -r .result
```

It is the same agent as the interactive one. It uses the project's saved provider and model, its tools, your
hooks and command rules, your usage limits, and it saves the run as a normal session. A run in Lightning mode
(the default) does the work directly.

## Input

- The task is the words after `-p`. Quotes are optional.
- Anything piped in is added as context after the task. If there is no typed task, the piped text is the task.
- Piped input over 2 MB is refused rather than cut. Write it to a file and name the file in the task.
- A file path or `@file` mention *typed* in the task attaches the file, as it does interactively. The same text
  inside piped input does not: piped text is data, not the request.

## Options

| Option | Meaning |
| --- | --- |
| `--output-format text\|json\|stream-json` | `text` (default) prints only the answer. See below. |
| `--mode lightning\|architect\|sentinel` | Default: the project's default mode, else Lightning. |
| `--model <id>` | Use this model for the run. Not saved. Fails if its key is missing. |
| `--continue`, `-c` | Carry on the latest session in this folder. |
| `--resume <id>` | Carry on a specific session (the id is in the result). |
| `-q`, `--quiet` | No progress lines on stderr. Failures are still printed. |

A mistyped option is an error (exit 2), never ignored. Put `--` before a task that starts with a dash.

## Nobody can answer

A run has no one to ask, so anything that would ask is refused, the same way it is for a sub-agent:

- **Lightning** works directly. Writes outside the project, and anything on your protected-path list, are refused.
- **Architect** is read-only. The model plans and cannot change anything.
- **Sentinel** asks before every action that changes something, so in a script every such action is refused and
  the model is told nobody is there to approve it. It is close to read-only. The refused actions are listed in
  `permission_denials` in the result.
- Questions to you (`ask_user`) are answered with "use your best judgment". The model is also told, in its system
  prompt, that the run is unattended: it should pick the most reasonable option, say which it chose, finish the
  work and end with a full report, not with "want me to...?". It stops early only for a decision that only you
  can make, and says what it needs.
- A project's own MCP servers do not start unless you already approved them.
- It will not run in your home folder or a drive root. Run it from inside a project.

## Output

**text.** stdout is the final answer and nothing else. Progress, one line per tool call, goes to stderr:

```
› Read src/auth/login.ts
› Edit src/auth/login.ts
  ✗ old_string not found
```

**json.** One line on stdout when the run ends:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "Fixed the failing test: ...",
  "session_id": "6f0c...",
  "model": "deepseek-v4-pro",
  "mode": "lightning",
  "duration_ms": 41230,
  "tool_calls": 9,
  "usage": { "billed_tokens": 18420, "input_cached": 61200, "input_fresh": 9100, "output": 9320 },
  "total_cost_usd": 0.0231,
  "cost_estimated": true,
  "permission_denials": [],
  "errors": []
}
```

`subtype` is `success`, `error`, `paused` or `interrupted`. A paused or interrupted run adds `stop_reason`.
`total_cost_usd` is an estimate from list prices, not an invoice. `usage` and the cost cover this run only,
also when it continues an earlier session.

**stream-json.** One JSON object per line as things happen, nothing on stderr. The first line is
`{"type":"init", ...}` with the session, model and mode. The last is the same `result` object json prints. In
between: `text` (a piece of the reply), `reply_reset` (drop the text since the last reset), `tool_start`,
`tool_end`, `subagent_start`, `subagent_end`, `compaction`, `activity`, `notice` and `error`. Ignore types you do
not know.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | The run failed: the provider refused or was out of credit, or the model errored. The reason is in `errors`. |
| 2 | Bad usage: no task, an unknown option or model, nothing to continue, an unsafe folder. |
| 3 | No API key for any provider. |
| 4 | Stopped before it was done: a usage limit, the step budget, the same step failing repeatedly, a reply cut off at the model's limit, or a provider refusal. Carry on with `--continue`. |
| 130, 143 | Stopped by SIGINT or SIGTERM. The turn is stopped, the session is saved and background commands are ended. A second signal exits at once. |

## Providers and keys

The project's saved model is used, as in the interactive app. If its provider has no key, a provider that does
is used instead and a line on stderr says so. With `--model` there is no such swap: a missing key is exit 3.

In CI, set the provider's key as a secret and expose it as the provider's usual variable, for example
`DEEPSEEK_API_KEY`. Mindweave never sends it anywhere except that provider.

## Not in this version

A cost ceiling flag (usage limits are honoured), a JSON-schema output, slash commands inside the task, and a mode
that does not save the session. Each can be added later without changing what is above.
