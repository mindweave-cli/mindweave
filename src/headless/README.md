# headless/ — `mindweave -p`

One task, no screen. A thin client of `core/turnRunner.ts`, the same front door the desktop app uses, so the
engine, tools, hooks, usage limits and session store are the interactive ones and are not duplicated here.

| File | Job |
| --- | --- |
| `args.ts` | `argv` to options, or a usage error. Pure. |
| `output.ts` | An event to a line of output, the result object, the exit code. Pure. |
| `run.ts` | The whole flow, with stdin, streams and the signal injected so it runs in a test. |
| `main.ts` | The real process: reads stdin, handles signals, exits. |

`index.ts` routes `-p` here before React and Ink are loaded, so a script never pays for them.

No approval channel is attached on purpose. That is the state a sub-agent runs in, and it already means
"nobody to ask" everywhere: Sentinel refuses, `ask_user` says use your best judgment, writes outside the
workspace are refused. A mode of its own would only repeat that.

Reference for users: `docs/HEADLESS.md`. Tests: `args.test.ts` and `output.test.ts` (pure), `run.test.ts`
(the flow against a scripted provider), `process.test.ts` (a real process).
