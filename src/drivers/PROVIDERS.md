# Choosing your model

Mindweave is **bring-your-own-key (BYOK)**: you pick a model, you use your own API key
for it, and everything runs on your machine. Nothing is sent to a Mindweave server.

Each provider has a **driver** that tunes Mindweave to run its models at their best —
how that provider expresses reasoning effort, how it reports cached tokens, the repairs
its models need. Only the driver for the model you are using is ever loaded, so the
lineup below costs nothing until you pick from it.

## Available now

19 providers, 68 models, plus OpenRouter's catalogue, whatever you run in Ollama, LM Studio or llama.cpp, and any server you point the custom endpoint at. `/provider` moves between them and
`/model` lists what the one you are on offers, so there is nothing here you need to memorise.

| Provider | Models | Key |
| --- | --- | --- |
| **DeepSeek** | 2 | `DEEPSEEK_API_KEY` |
| **Anthropic** | 8 | `ANTHROPIC_API_KEY` |
| **OpenAI** | 8 | `OPENAI_API_KEY` |
| **Gemini** | 8 | `GEMINI_API_KEY` |
| **Qwen** | 5 | `DASHSCOPE_API_KEY` |
| **Kimi** | 6 | `MOONSHOT_API_KEY` |
| **GLM** | 7 | `ZAI_API_KEY` |
| **xAI** | 4 | `XAI_API_KEY` |
| **Mistral** | 5 | `MISTRAL_API_KEY` |
| **Groq** | 2 | `GROQ_API_KEY` |
| **Cerebras** | 2 | `CEREBRAS_API_KEY` |
| **MiniMax** | 2 | `MINIMAX_API_KEY` |
| **Meta** | 5 | `MODEL_API_KEY` |
| **Tencent** | 2 | `TOKENHUB_API_KEY` |
| **OpenRouter** | its live catalogue | `OPENROUTER_API_KEY` |
| **Ollama** | whatever you have pulled | none: it only has to be running (`OLLAMA_HOST`) |
| **LM Studio** | whatever you have downloaded | none: it only has to be running (`MINDWEAVE_LMSTUDIO_URL`) |
| **llama.cpp** | the model the server runs | none: it only has to be running (`MINDWEAVE_LLAMACPP_URL`) |
| **Custom endpoint** | whatever the server lists, or the ids you type | the server's own, if it wants one (`MINDWEAVE_CUSTOM_URL`) |

DeepSeek is the default, and DeepSeek V4.1 Flash is what a fresh project opens with.

Three things worth knowing before you choose. **Meta's Muse Spark** is offered in two
tiers, and the cheaper one is cheaper because Meta may train on your prompts and
completions — Mindweave never picks that one for you. **DeepSeek V4.1 Flash** reads
images natively, so the default model can see a screenshot you hand it; Mindweave tells
the model plainly when a picture it was handed cannot be seen rather than pretending
otherwise. **Grok** reads JPG and PNG only; a GIF or WebP is held back rather than
sent, and the agent tells you which formats work. **Tencent's Hy** is reached through TokenHub's international endpoint; the
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

**Ollama** runs models on your own machine: no key, no account, nothing leaves it, nothing
is billed. Install it from ollama.com, pull a model that takes tools (`ollama pull qwen3:8b`),
and it appears in `/provider` and `/model` while Ollama runs. Only models that can call tools
are listed, since an agent turn needs them. Each request asks for a 32K window (or the
model's own, if smaller), because Ollama otherwise loads a model with a few thousand tokens
and silently cuts the rest of the prompt. That window costs memory (several GB of the
model's cache), so `MINDWEAVE_OLLAMA_CONTEXT` sets a smaller one for a smaller machine. A server elsewhere: set `OLLAMA_HOST`, as for
Ollama itself.

**LM Studio** and **llama.cpp** run models on your own machine the same way: no key, no account, nothing leaves it,
nothing is billed, and they appear in `/provider` and `/model` while the server runs. LM Studio listens on port 1234; a
`llama-server` on 8080 (or the port it was started with). A server on another machine: set
`MINDWEAVE_LMSTUDIO_URL` or `MINDWEAVE_LLAMACPP_URL`, or fill in the address in the app, or in the terminal with `/endpoint lmstudio` or `/endpoint llamacpp`, which opens a box with that one field. Both serve the OpenAI wire, so a model
must take tools for an agent turn, and its context has to be large enough to hold the agent's instructions: load it with at
least 32K tokens (LM Studio's default is often 4,096, and the entry warns when a model is loaded with less). llama.cpp needs its
chat template on (`--jinja`, the default in current builds) for tool calls.

**Custom endpoint** is for everything else that speaks the OpenAI chat wire: a hosting service (Together, Fireworks,
DeepInfra, Hugging Face), a company's own gateway, a vLLM or LiteLLM on your network. Give it the address as far as
`/chat/completions` is served (`https://api.together.xyz/v1`), the key if the server wants one, and Mindweave lists what the
server's `/models` returns. A server with no model list is used with the ids you type in. In the terminal, `/endpoint custom` opens a box with the address, key, model ids and window, one row each: Enter on a row changes it, saving a field empty clears it, and the last rows check the server again or remove everything. Mindweave cannot know that server's
price, so cost is not tracked, and your prompts go wherever you point it.

**Endpoints and coding plans.** Every provider that speaks the OpenAI wire through the shared layer can be pointed at another
address (`MINDWEAVE_<PROVIDER>_URL`, or the Endpoint row in the app). Some sell a flat-fee coding plan on a different address, and
that plan's key works only there: GLM's Coding Plan, Alibaba's Coding Plan for Qwen, and Kimi Code. Those are offered as presets.
Kimi Code also adds its own model ids, `kimi-for-coding` and its HighSpeed tier, to `/model` while its address is set.

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
`src/drivers/deepseek/` is the reference to copy.
