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
- [ ] Streaming: every adapter waits for the whole response. Stream where the provider streams,
      with cancellation, so a generation can be interrupted.
- [ ] The Chat Completions adapter sends back none of a response's other fields
      (`reasoning_content`) and none of the session's settings; it records each as left out or
      enforced.
- [ ] A response cut short should end at its last completed part. Without streaming the adapter
      cannot tell which part was cut, so the last one is recorded as it came.
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

## Try

- [ ] FizzBuzz against a real model through the Anthropic adapter (costs a little).
- [ ] FizzBuzz runs written out as trajectories, as sample data for the UI.

## Trajectories

- [ ] Claude Code: 7 divergent observations in 5 sessions, not yet examined.
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
