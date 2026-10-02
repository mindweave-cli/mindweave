# DeepSeek driver (reference)

The reference driver — copy this shape when building a new one.

**Models:** `deepseek-flash` (V4.1 Flash: fast, cheap, reads images, the default) and
`deepseek-v4-pro` (stronger, for harder work). Both are OpenAI-compatible and support a
thinking / non-thinking toggle with a `reasoning_effort` budget (`low`, `high`, `max`).
The earlier Flash id `deepseek-v4-flash` is still accepted by DeepSeek and by Mindweave, so
settings and sessions saved under it keep working; it is never offered.

**API shape:** OpenAI-compatible `chat/completions` with native function-calling
(`tools[]` → `tool_calls`) and SSE streaming. Prompt caching is automatic — it only
needs a byte-stable prefix, which `ModelRequest` already guarantees.

**Key:** `DEEPSEEK_API_KEY` (env var, or in your config `.env`).

## Notes

- Thinking mode with tool calls works without sending `reasoning_content` back on later
  requests. DeepSeek's documentation says it is mandatory and that omitting it is a 400;
  a live check (2026-10-02, three tool rounds on each of Flash, Pro and the old id) got
  200 every time. Mindweave therefore does not store or replay it. If DeepSeek starts
  enforcing it, the symptom is a 400 on the second step of a thinking-mode turn.
- Prompt caching is automatic and needs only a byte-stable prefix.
