# To do

What is to be built, by capability. What is built is in each module's `MODEL.md`; direction that is
not yet work is in its `DESIGN.next.md`. Delete an item when it is done or dropped. As of
2026-10-01.

## Decisions for Dan

- [ ] `ModelAnswered`: whether a response that ends the turn is an observation of its own, beside
      `ModelResponded`, or stays the turn's ending (`TurnEnded { Answered }`), as it is now.
      (`AskModel` and `TellModel { step }` are built; `AskModel` follows `TurnStarted`.)

## Build

### The host (ACP)

The session's interface with the user. A real ACP session's log
(`~/.labkit/logs/acp-44517-ec9d22b3-8c0d-465a-83c7-9c227e0aec77.jsonl`, labkit-agent, local Qwen)
is the set of capabilities a first working host needs: choose a model and a thinking level, send
the first input, stream thinking, the model calls a tool, the user is asked for permission, the
tool runs, the model answers, and `/export` writes the session to Markdown without going to the
model.

- [ ] Configuration comes from the host, and is assembled before a request is made; a change
      applies between turn N and turn N + 1. A new session is configuring until it is ready to
      start turn zero: a UI with no default model, thinking level or output limit has nothing to
      launch, and its submit is not enabled until it has (the same machines can run in the UI).
      In the log: the providers on offer are a model catalog (models.dev) filtered by which
      credentials are set, plus a local server; the user changes the model, thinking and output
      limit with ACP's `session/set_config_option`. Here: the opening is the configuration, a
      change is `ModelChangeArrived` from `User { via: acp }`, taken between turns (M1–M3); the
      log's configuration versions are our host's numbering (labkit-agent), ours to change, as
      `Seq` is the session's.
- [ ] Tool permission. In the log: `write_file` (kind `edit`) waits for the user; the options are
      allow once, allow for the session, reject once; allow for the session is a grant for that
      tool, for all arguments, until the session closes or permissions are reset. Build the policy
      gate (agent-policy) into the loop against that flow, with which tools only read and which
      change things as a property of the tool.
- [ ] Accounting for ACP. Built: a provider-neutral `usage` on each response; `contextGauge` (used,
      size, cost) and `requestsIn` (a turn's model requests) read from the facts (`accounting.ts`);
      prices in `frontier.json`; `maxTurnRequests` as an example host policy. To do in the host: send
      `usage_update` after `session/new` or `session/load`, after a prompt, and when the numbers
      change; answer a vetoed request with `max_turn_requests`, a cut-short response with
      `max_tokens`; refuse the next prompt with an error at a session-level turn limit (ACP has no
      stop reason for it). Open: after a compaction `used` is the last response's until the next one
      reports (an estimate would come from the next-request size estimate); a summarizer's own
      requests are not counted in `cost`. `PromptResponse.usage` is a draft; not built.
- [ ] Attachments. Built: input carries files by reference (`InputArrived.attachments`); a tool's
      output that arrives as bytes is kept in the blob store and recorded by reference (`Received`
      body `Stored`); bytes in the blob store (`Blobs`: in memory by default, or a folder); each
      adapter sends images and PDFs as its provider takes them, in a user message or a tool result,
      a text file as its text, and anything a model is not known to take as a pointer, logged;
      counting a request's input before it is sent (`anthropic-count.ts`, `openai-count.ts`; xAI has
      no endpoint). Live: all three read an attached image and PDF, and an image a tool returned;
      the counts before sending matched what the responses reported. Left: the host's intake of ACP
      prompt content as typed parts (labkit-agent's `app-acp`); the client half (sending, drawing,
      resolving `blob://`), labkit-web's.
- [ ] Slash commands the host handles itself (`/export`), which are not input to the model.

### Compaction

The proof of concept is shown. Before a session is run up to a compaction as a daily driver, it has
to be pleasant to live with; this list is expected to grow.

Built: the window marker, naming what decided it (agent-machine S4); compaction for the provider
being asked, summaries per provider kept in memory or as files, policies asked between turns, and
the view that sends each provider its own summaries (agent-context A5–A8); a provider's own
compaction as a summary, for OpenAI and xAI (`openai-compaction.ts`, `xai-compaction.ts`,
`provider-compaction.ts`), sent the session's system prompt and tools; a digest of a span made
with no model, its attachments as pointers and one line for each tool call (`digest.ts`).

- [ ] The loop asks the compaction policy itself; today whoever runs the session asks it between
      turns.
- [ ] An estimate of the next request's size (estimated context usage), for a policy that
      compacts automatically at X% of the current model's context window. It is the sum of:
      - the conversation so far: the input and output tokens the last response reported (exact,
        for what that request carried and what came back), plus an estimate for the facts
        recorded since;
      - what the user has typed in the composer;
      - files and other context attached to it;
      - the tools, and the tool calls and results the next turn may bring;
      - room for writing a compaction summary.
      Open: how much room to keep for the next turn's tool results, and for the summary (a
      share, or the summarizer model's most output tokens).
- [ ] Refuse a request to compact that would not fit the summarizer's context window.
- [ ] Anthropic's own compaction (the compaction block, beta `compact-2026-09-04`).
- [ ] A summarizer that asks a model to write a text summary with our own prompt.

### Providers

- [ ] The Chat Completions adapter against the local server (Rapid-MLX, vLLM-compatible, at
      `http://localhost:8000/v1`; OpenAPI docs at `/docs`). Built: the reasoning effort is sent as
      `reasoning_effort` (Qwen3.5-9B takes `none` to `xhigh` and refuses `max`). To do: streaming;
      `reasoning_content` sent back; tool calls; the other settings.
- [ ] Configuration for local and unknown models, which `frontier.json` does not list: their
      efforts, context window and input kinds. The local server says some of it itself:
      `GET /v1/models` gives `context_window`, `capabilities`, and under `models`
      `supported_reasoning_levels` and `default_reasoning_level`. Until then such a model is sent
      the effort asked, and a server that does not take it refuses the request.
- [ ] OTLP, for a collector: OpenTelemetry's `@opentelemetry/exporter-trace-otlp-http` (a new
      dependency, one more span processor beside the file), or Effect's `OtlpTracer` (no new
      package, but it replaces the NodeSdk tracer, so not beside the file exporter).

## Later: worth doing, not core

- [ ] Caching, tuned with compaction. Built: the `cache` setting (off, 5m, 1h); Anthropic reads
      nearly every request from the cache with it (FizzBuzz, 20 turns: 27,556 of 29,032 input
      tokens). To do: why OpenAI reported 0 cached tokens in every FizzBuzz run, requests over 1,024
      tokens included; and compaction that knows the provider's cache: from the time since the
      provider's last summary (`writtenAt`) and its cache's lifetime, whether the next request can
      still read the cache, and so whether keeping its beginning unchanged saves anything.
- [ ] Forks as sessions, and the turn pointer (`session/turn`; turn zero of a root points at
      itself). A fact is addressed by its session and its position.
- [ ] `prompt_cache_key` (OpenAI, xAI) for cache-aware work.
- [ ] Changes to the system prompt or tools after the session opens, as facts of their own
      (Anthropic takes tool changes mid-conversation as `tool_addition` and `tool_removal` blocks;
      Codex records settings changes as `thread_settings_applied`).
- [ ] Returning to the first provider after a fallback by itself; today it is the user's to switch.
- [ ] OpenAI `async: true` on a tool: the model goes on past a call before its output is returned.
- [ ] OpenAI mid-turn steering (GPT-6, over a WebSocket to the Responses API): new input during a
      response. The core delivers input at a step's boundary; this would deliver it sooner.
- [ ] OpenAI `end_turn` on a completed response. Codex follows a response with another request when
      it is `false` (`codex-rs/core/src/session/turn.rs`); the responses the public API returned to
      this harness carry no such field. It would map to `Unfinished`.
- [ ] A response that reads as unfinished with no mark from the provider (oh-my-pi's "unexpected
      stop": nothing visible, or text a small model judges to have stopped partway).

## Try

- [ ] FizzBuzz runs written out as trajectories, as sample data for the UI.

## Trajectories

Run both sweeps after a change to a core machine, and read the counts of observations not expected.
On 2026-09-30: Codex none in 168 files; Claude Code 4 in 787.

- [ ] Claude Code: the 4 are each an error Claude Code reported after a response the core had
      already taken as the step's outcome: three after a refusal, one after an answer.
- [ ] Codex: three responses in files from 2026-08 are split in two by a `token_count` that arrived
      mid-response, and the first half is recorded as `Unfinished`.
- [ ] Codex: 8 turns still running when Codex completes them; 10 completions while another turn
      runs. Neither diverges.
- [ ] Codex compactions copy the user's messages word for word; match them back to positions so
      `kept` means the same for both tools.
- [ ] The request that writes a compaction's summary has no place: Claude Code does not record it,
      and the Codex importer counts and drops it.
- [ ] Claude Code starts tools while a response streams; the importer gives such results after the
      message and does not record the early start (`ToolCallArrived`).
- [ ] Not mapped yet: subagents and messages between agents (for moderated debates and peer review
      later), images, `fork-context-ref`, `model_refusal_no_fallback`, developer messages (system
      prompts).

## Parked by Dan

- A session's record: its format, and opening a session from it. Deferred until something needs
  it, so that the format does not dictate the design. Everything that can be built and tested
  without it comes first.
- Google (no Effect package).
- Jev, later, as a tool.
- Attachments and system records in Claude Code sessions, including exo's injected memories.
