# To do

What is to be built, by capability. What is built is in each module's `MODEL.md`; direction that is
not yet work is in its `DESIGN.next.md`. Delete an item when it is done or dropped. As of
2026-09-30.

## Decisions for Dan

- [ ] Confirm or reword the terms T1–T5 in agent-machine's `MODEL.md`. The code and tests are built on
      them as worded; none is blocking.
- [ ] Where the model is chosen. The loop's `ModelProvider` chooses it from the session's facts, so
      context assembly's model selectors go unused, and `ModelChoice.endpoint` has no counterpart
      in `Target`.

## Build

### Caching

- [ ] No request marks anything for a provider's cache. Anthropic caches only what a request marks
      (`cache_control`, on the request or on a block), so nothing is cached there: every live
      response so far reports no cache read or write. OpenAI caches a prefix of 1,024 tokens or
      more without being asked. Send the mark, and record what each response says was read and
      written.
- [ ] What keeps a cached prefix alive is already in place and untested against a cache: earlier
      messages are sent the same way every time, thinking goes back unchanged, notices stay where
      they were sent. Check it live once requests are cached.
- [ ] Compaction that knows the provider's cache: when the cache has expired, the next request
      costs the same whatever it carries (agent-context `DESIGN.next.md`).

### Compaction

Built: the window marker only (agent-machine S4, agent-context A5).

- [ ] Requests made in a window: which of a window's summaries a request uses, and the view that
      sends the summary in place of the span.
- [ ] A compaction that runs while a session does, and writes a summary.
- [ ] A provider's own compaction: Anthropic's compaction block (beta `compact-2026-09-04`), OpenAI's
      `compaction` item. Each works only with its own provider.
- [ ] Anthropic's rules for its own compaction, for the view: the kept turns follow the summary
      unchanged, and the first kept turn has a different role from the last summarised message, or
      the API merges them. The FizzBuzz toy view merges the summary and the next input into one
      user message.
- [ ] Our own summary with kept turns breaks the kept turns' thinking on Anthropic (the API accepts
      the swap only for a summary it wrote). On hold: explore keeping the last turn with its
      thinking.
- [ ] Compaction as forks: a revisable summary per fork, summarising ahead of time from the fact
      stream, strategies compared side by side.

### Tool permissions

Built: the gate and what a policy is, pure and not in the loop (agent-policy `MODEL.md`).

- [ ] Policy as an Effect service, with the gate between the core's requests and the adapters in
      the loop (a veto before a request is carried out, a dry run).
- [ ] Which tools only read and which change things, as a property of the tool.
- [ ] A call that arrived in a response that then failed may have run; the model is not told. When
      the harness knows which tools change things, tell the model, or do not run those early.
- [ ] A model's settings function can only shape a request. Refusing one is the same place with
      another outcome (`ModelVetoed`); build it when a case needs it.

### The session's configuration

- [ ] A user's change of model or settings has no way in. `ModelChangeArrived` will come from the
      surface the user works through (its origin says so), and the session is not bridged to one
      yet; today only the fallback chain reports it.
- [ ] Changes to the system prompt or tools after the session opens, as facts of their own (the
      opening records them; Anthropic takes tool changes mid-conversation as `tool_addition` and
      `tool_removal` blocks). Codex records settings changes as `thread_settings_applied`, which
      the importer reads only for the first model.
- [ ] `InputArrived.from` says what a fact's origin says (the outside world: a user, the system,
      another agent). Fold it into the origin.
- [ ] A model's own output limit: a `maxOutputTokens` above what a model allows is sent as asked,
      and the provider rejects it. A settings function per model class could enforce the nearest.
- [ ] Settings functions exist for the Anthropic classes met so far (Opus 5.5, Fable and Mythos 5;
      Sonnet 5.5). A model in no class is sent what was asked.
- Returning to the primary provider after a fallback is the user's (a manual `/switch`), as other
  harnesses do. Doing it by itself would need the harness to know more of the world: a later
  feature, not ruled out.

### Providers

- [ ] The Chat Completions adapter does not stream, sends back none of a response's other fields
      (`reasoning_content`) and none of the session's settings; it records each as left out or
      enforced.
- [ ] A request retried after its stream had begun passes its parts on a second time, and would
      start a tool call a second time.
- [ ] The call lifecycle through Effect: timeouts and retries with `Schedule`.
- [ ] `ToolCallDispatched` is reported by the loop when it hands a call to the tool runner. When
      tools run in another process (the ACP host), that adapter reports it.

### Going on from a session's facts

Built: `sessionFrom(facts)`, and `endTurnLeftRunning` for a turn the facts leave running
(agent-machine X4), tested with facts made in memory.


- [ ] After a turn that got no response (failed, vetoed, interrupted before anything arrived), the
      next request carries that turn's input and the new input as one user message. It is valid
      for both providers, and nothing tells the model the first went unanswered.
- [ ] A turn identity must not be used twice. A `TurnStarted` that names a turn the facts already
      hold is taken, and the turn's input is dropped without a word. `countingTurnsAfter` avoids it
      for the counted identities the tests use; the core does not refuse it.

### Forks

- [ ] Forks as sessions, and the turn pointer (`session/turn`; turn zero of a root points at
      itself). A fact is addressed by its session and its position.

### Telemetry

- [ ] Parent spans for sessions and turns; an OTLP exporter; Effect's logs through OpenTelemetry.

## Later: worth doing, not core

The request and response with each provider come first: whatever goes up or down becomes the same
stream of effects and observations. These build on that.

- [ ] OpenAI `async: true` on a tool: the model goes on past a call before its output is returned.
- [ ] OpenAI mid-turn steering (GPT-6, over a WebSocket to the Responses API): new input during a
      response. The core delivers input at a step's boundary; this would deliver it sooner.
- [ ] OpenAI `end_turn` on a completed response. Codex follows a response with another request when
      it is `false` (`codex-rs/core/src/session/turn.rs`); the responses the public API returned to
      this harness carry no such field. It would map to `Unfinished`.
- [ ] A response that reads as unfinished with no mark from the provider (oh-my-pi's "unexpected
      stop": nothing visible, or text a small model judges to have stopped partway).

## Try

- [ ] FizzBuzz against a real model through the Anthropic adapter (costs a little).
- [ ] FizzBuzz runs written out as trajectories, as sample data for the UI.

## Trajectories

Run both sweeps after a change to a core machine, and read the counts of observations not expected.
On 2026-09-30: Codex none in 168 files; Claude Code 4 in 808.

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
