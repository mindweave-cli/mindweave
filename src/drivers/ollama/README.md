# Ollama driver

Models running on this machine through [Ollama](https://ollama.com): no key, no account,
nothing leaves the machine, nothing is billed.

- **Connected while it runs.** There is no key, so discovery (`catalog.ts`) sets
  `MINDWEAVE_OLLAMA_RUNNING` while the server answers with at least one usable model, and
  clears it otherwise. Everything that asks "can this provider run?" reads that one fact,
  exactly as it reads a key.
- **Discovered, never cached.** The list is whatever is pulled (`GET /api/tags`), with each
  model's facts from `POST /api/show`. Only models that take tools are listed. Asking a local
  server costs milliseconds, so the registry asks every time (`local: true`).
- **Ollama's own `/api/chat`, not its OpenAI-compatible endpoint.** Measured on Ollama 0.35,
  that endpoint ignores both things an agent needs: the context window (the model loads with
  4,096 tokens and a longer prompt is cut to fit, silently) and turning thinking off.
- **A window on every request.** 32K (`options.num_ctx`), or the model's own if it was trained
  on less. It costs memory (a 0.6B model at 32K took 4.3 GB of GPU memory), so
  `MINDWEAVE_OLLAMA_CONTEXT` sets another size.
- **Ids are namespaced** (`ollama:qwen3:8b`), so a local model is never mistaken for a cloud one.
- **Where the server is:** `OLLAMA_HOST`, read the way Ollama reads it; `MINDWEAVE_OLLAMA_URL`
  overrides it.
