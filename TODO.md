# To do

What is to be built, by capability. What is built is in each module's `MODEL.md`; direction that is
not yet work is in its `DESIGN.next.md`. Delete an item when it is done or dropped. As of
2026-09-30.

## Decisions for Dan

- [ ] The names of the turn and step terms. Proposed: `AskModel` (the decision to make a turn's
      first request) and `TellModel` (each later request in the turn, after tool results) in place
      of the one decision `ModelAsked`; `ModelAnswered` for a response that ends the turn, beside
      `ModelResponded`. Open: whether `AskModel` replaces `TurnStarted` or follows it; whether
      "increments Seq" means a step number within the turn; whether `ModelAnswered` is a second
      observation or stays the turn's ending (`Answered`).

## Build

### The host (ACP)

The session's interface with the user. A real ACP session's log
(`~/.labkit/logs/acp-44517-ec9d22b3-8c0d-465a-83c7-9c227e0aec77.jsonl`, labkit-agent, local Qwen)
is the set of capabilities a first working host needs: choose a model and a thinking level, send
the first input, stream thinking, the model calls a tool, the user is asked for permission, the
tool runs, the model answers, and `/export` writes the session to Markdown without going to the
model.

- [ ] Configuration comes from the host. In the log: the providers on offer are a model catalog
      (models.dev) filtered by which credentials are set, plus a local server; a session opens with
      a default configuration (provider, model, thinking off, streaming, 32,768 output tokens, a step
      limit, permissions `ask`); the user changes the model, thinking and output limit with ACP's
      `session/set_config_option`, each applied at the next idle point as a new version, and every
      request is made with the version in force. Here: the opening is the default, a change is
      `ModelChangeArrived` from `User { via: acp }`, taken between turns (M1–M3).
- [ ] Tool permission. In the log: `write_file` (kind `edit`) waits for the user; the options are
      allow once, allow for the session, reject once; allow for the session is a grant for that
      tool, for all arguments, until the session closes or permissions are reset. Build the policy
      gate (agent-policy) into the loop against that flow, with which tools only read and which
      change things as a property of the tool.
- [ ] Slash commands the host handles itself (`/export`), which are not input to the model.
- [ ] The default output limit. The Anthropic adapter supplies 32,768 because the Messages API
      requires one; that is low for a long multi-step coding task (Grok's default is 128,000).

### Compaction

Built: the window marker, naming what decided it (agent-machine S4); compaction for the provider
being asked, summaries per provider kept in memory or as files, policies asked between turns, and
the view that sends each provider its own summaries (agent-context A5–A8); the Responses adapter can
ask OpenAI or xAI for its own compaction (`openAiCompactions`).

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

### Caching

Built: the `cache` setting (off, 5m, 1h); Anthropic reads nearly every request from the cache with
it (FizzBuzz, 20 turns: 27,556 of 29,032 input tokens).

- [ ] OpenAI reported 0 cached tokens in every FizzBuzz run, requests over 1,024 tokens included,
      with and without `prompt_cache_retention: "24h"`. Find out why before relying on it.
- [ ] Compaction that knows the provider's cache: from the time since the provider's last
      summary (`writtenAt`) and its cache's lifetime, whether the next request can still read the
      cache, and so whether keeping its beginning unchanged saves anything.

### Providers

- [ ] The Chat Completions adapter against the local Qwen model (`http://localhost:8000/v1`,
      `mlx-community/Qwen3.5-9B-8bit`, as in the ACP log): streaming, `reasoning_content` sent back,
      tool calls.
- [ ] A stream cut after a tool call from it was passed on is not retried, and the turn fails
      (`noRetryAfterCalls`): a retry's response names new calls, and the tool ran again for each.
      Decide whether the turn should instead go on with the call that ran.
- [ ] Thinking `off` on xAI is effort `low` for the first request only: once enforced, later
      requests go with no effort (the model's default), because an `Effort` enforcement must name
      an effort that was asked. Making `asked` optional on `Enforced.Effort` (agent-machine) would
      record it.
- [ ] grok-4.20 and grok-build-0.1 refuse `reasoning.effort` of any value; a thinking or effort
      setting gets a 400 from them.
- [ ] xAI's own compaction: after each one, Grok answered the last number before it again
      (FizzBuzz 15 of 25 right; OpenAI's, through the same code, 25 of 25), also outside the
      harness in 5 of 6 runs. Untested: whether sending the tools with `/compact` changes it.

### Telemetry

- [ ] Each request the loop carries out runs in a span (`agent.model.request`, `agent.tool.run`,
      `agent.turn.review`), and each fallback attempt in `agent.model.attempt`, but only the tests
      collect them: nothing exports them. Export them (OTLP), with parent spans for sessions and
      turns, and send Effect's logs through OpenTelemetry.

## Later: worth doing, not core

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
