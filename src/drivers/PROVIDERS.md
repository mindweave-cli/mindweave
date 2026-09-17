# Choosing your model

Mindweave is **bring-your-own-key (BYOK)**: you pick a model, you use your own API key
for it, and everything runs on your machine. Nothing is sent to a Mindweave server.

Each provider has a **driver** that tunes Mindweave to run its models at their best —
how that provider expresses reasoning effort, how it reports cached tokens, the repairs
its models need. Only the driver for the model you are using is ever loaded, so the
lineup below costs nothing until you pick from it.

## Available now

15 providers, 53 models, plus OpenRouter's catalogue. `/provider` moves between them and
`/model` lists what the one you are on offers, so there is nothing here you need to memorise.

| Provider | Models | Key |
| --- | --- | --- |
| **DeepSeek** | 1 | `DEEPSEEK_API_KEY` |
| **Anthropic** | 6 | `ANTHROPIC_API_KEY` |
| **OpenAI** | 4 | `OPENAI_API_KEY` |
| **Gemini** | 7 | `GEMINI_API_KEY` |
| **Qwen** | 4 | `DASHSCOPE_API_KEY` |
| **Kimi** | 4 | `MOONSHOT_API_KEY` |
| **GLM** | 6 | `ZAI_API_KEY` |
| **xAI** | 3 | `XAI_API_KEY` |
| **Mistral** | 4 | `MISTRAL_API_KEY` |
| **Groq** | 2 | `GROQ_API_KEY` |
| **Cerebras** | 2 | `CEREBRAS_API_KEY` |
| **MiniMax** | 3 | `MINIMAX_API_KEY` |
| **Meta** | 4 | `MODEL_API_KEY` |
| **Tencent** | 2 | `TOKENHUB_API_KEY` |
| **OpenRouter** | its live catalogue | `OPENROUTER_API_KEY` |

DeepSeek is the default, and DeepSeek V4.1 Flash is what a fresh project opens with.

Three things worth knowing before you choose. **Meta's Muse Spark** is offered in two
tiers, and the cheaper one is cheaper because Meta may train on your prompts and
completions — Mindweave never picks that one for you. **DeepSeek V4.1 Flash** reads
images natively, so the default model can see a screenshot you hand it; Mindweave tells
the model plainly when a picture it was handed cannot be seen rather than pretending
otherwise. **Tencent's Hy** is reached through TokenHub's international endpoint; the
mainland console serves the same weights under different model ids, so an account there
sets `MINDWEAVE_TENCENT_URL` and picks the id its own console lists.

**OpenRouter** is one key for models from nearly every vendor. Mindweave lists every model
in its catalogue that can run an agent turn (text out, tool calls) and reads each one's
price, context window, image support and reasoning levels from the catalogue itself, so
nothing about them is guessed. The catalogue is kept for six hours between fetches. Type
to filter the `/model` list, or name a model in words: `/model openrouter deepseek flash`.
Free models are listed and marked, but they are rate-limited hard enough that an agent
task can run out of requests part way through. By default OpenRouter may send your prompts
to hosts that store or train on them. Set `MINDWEAVE_OPENROUTER_DATA=deny` to use only
hosts that do not; a few models then have fewer hosts, or none.

## Picking a model

- `/provider` — choose which company answers.
- `/model` — choose which of its models.
- `/think` — choose how hard it reasons. The levels offered are the ones that model
  actually has, not a fixed ladder pasted across every provider.

Your choice is remembered per project. Switching mid-conversation is safe: the reasoning
level is clamped to what the new model accepts, and anything in the conversation that
belonged to the previous provider is left behind rather than replayed to the new one.

## Setting your key

Mindweave asks for a key the first time it needs one and writes it to
`~/.mindweave/.env`, which applies to every project. You can also put one in a project's
own `.env`, or export it in your shell — the shell wins, then the project file, then the
global one.

```
DEEPSEEK_API_KEY=your-key-here
```

You only need a key for the provider you actually use. See `.env.example` for the full
list. Keys stay on your machine and are never uploaded anywhere.

## Adding a provider

Drivers are the intended contribution. A provider is a manifest (what it offers, what it
costs, what it can do) plus a wire layer, and most providers need only the manifest
because they speak the OpenAI-compatible shape the shared transport already handles.
`src/drivers/deepseek/` is the reference to copy. `src/drivers/ollama/` is an unclaimed
stub for local models if you want it.
