# To do

Compiled from the notes (`src/*/MODEL.md`), the trajectory sweeps and review discussion, as of
2026-09-30. Delete an item when it is done or dropped.

## Decisions for Dan

- [ ] The terms T1–T5 in agent-core's `MODEL.md` are all still marked open.
- [ ] Where the model is chosen. The loop's `ModelProvider` chooses it, so context assembly's
      model selectors go unused, and `ModelChoice.endpoint` has no counterpart in `Target`.
      Reconfiguration through the inbox (below) may settle it.

## Build

- [ ] Changes to the system prompt or tools after the session opens, as facts of their own (the
      opening records them; Anthropic takes tool changes mid-conversation as `tool_addition` and
      `tool_removal` blocks). Codex records settings changes as `thread_settings_applied`, which
      the importer reads only for the first model.
- [ ] A user's change of model or settings has no way in. `ModelChangeArrived` will come from the
      surface the user works through (its origin says so), and the session is not bridged to one
      yet; today only the fallback chain reports it.
- [ ] `InputArrived.from` says what a fact's origin says (the outside world: a user, the system,
      another agent). Fold it into the origin.
- [ ] A call that arrived in a response that then failed may have run; the model is not told. When
      the harness knows which tools change things, tell the model, or do not run those early.
- [ ] `ToolCallDispatched` is reported by the loop when it hands a call to the tool runner. When
      tools run in another process (the ACP host), that adapter reports it.
- [ ] The Chat Completions adapter does not stream.
- [ ] A request retried after its stream had begun passes its parts on a second time.
- [ ] The Chat Completions adapter sends back none of a response's other fields
      (`reasoning_content`) and none of the session's settings; it records each as left out or
      enforced.
- [ ] A model's own output limit: a `maxOutputTokens` above what a model allows is sent as asked,
      and the provider rejects it. A settings function per model class could enforce the nearest.
- [ ] A model's settings function can only shape a request. Refusing one is the same place with
      another outcome (`ModelVetoed`, which nothing produces yet); build it when a case needs it.
- [ ] Settings functions exist for the Anthropic classes met so far (Opus 5.5, Fable and Mythos 5;
      Sonnet 5.5). A model in no class is sent what was asked.
- Returning to the primary provider after a fallback is the user's (a manual `/switch`), as other
  harnesses do. Doing it by itself would need the harness to know more of the world: a later
  feature, not ruled out.
- [ ] Policy as an Effect service, with the gate between the core's requests and the adapters in
      the loop (pre-flight veto, dry run).
- [ ] The call lifecycle through Effect: timeouts and retries with `Schedule`.
- [ ] Forks and the turn pointer (`session/turn`; turn zero of a root points at itself).
- [ ] Compaction as forks: a revisable summary per fork, summarising ahead of time from the fact
      stream, strategies compared side by side.
- [ ] Starting tools while the response streams: a machine per model request, fed by the stream,
      that tells the step `CallReady`.
- [ ] Telemetry: parent spans for sessions and turns; an OTLP exporter; Effect's logs through
      OpenTelemetry.
- [ ] The summary view merges the summary and the next input into one user message. Anthropic's
      rule for its own compaction: the kept turns follow the summary unchanged, and the first kept
      turn has a different role from the last summarised message, or the API merges them; compacting
      exactly the messages of a request already sent makes the kept turns start with the reply.

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

- [ ] Claude Code: 9 observations the core does not expect, and 49 that follow from two of them.
      Three follow a refusal that Claude Code asked again after; three are responses with no turn;
      one follows an answered turn; two follow a message Claude Code wrote itself.
- [ ] Claude Code writes messages of its own as assistant messages with model `<synthetic>` and
      `stop_reason: "stop_sequence"` (137 in 808 files: "No response requested.", API errors, "Not
      logged in"). The importer records them as model responses; they are the harness's.
- [ ] Codex: three responses in files from 2026-08 are split in two by a `token_count` that arrived
      mid-response, and the first half is recorded as `Unfinished`.
- [ ] Codex: 8 turns still running when Codex completes them; 10 completions while another turn
      runs. Neither diverges.
- [ ] Codex compactions copy the user's messages word for word; match them back to positions so
      `kept` means the same for both tools.
- [ ] The request that writes a compaction's summary has no place: Claude Code does not record it,
      and the Codex importer counts and drops it.
- [ ] Not mapped yet: subagents and messages between agents (for moderated debates and peer review
      later), images, `fork-context-ref`, `model_refusal_no_fallback`, developer messages (system
      prompts).

## Parked by Dan

- Google (no Effect package).
- Jev, later, as a tool.
- Cache-control headers, and compaction that knows the provider's cache.
- Attachments and system records in Claude Code sessions, including exo's injected memories.
