# To do

Compiled from the notes (`src/*/MODEL.md`), the trajectory sweeps and review discussion, as of
2026-09-29. Delete an item when it is done or dropped.

## Decisions for Dan

- [ ] Reshape `Compacted` into the `compaction-window` entry (Dan chose the name): only the span
      (window, previous, through, kept), with the summary belonging to a fork of the history. A
      fork's summary may be text, or a provider's own compaction result: Anthropic's compaction
      block (beta `compact-2026-09-04`) or OpenAI's encrypted `compaction` item, each opaque and
      usable only with that provider.
- [ ] The terms T1–T5 in agent-core's `MODEL.md` are all still marked open.
- [ ] Where the model is chosen. The loop's `ModelProvider` chooses it, so context assembly's
      model selectors go unused, and `ModelChoice.endpoint` has no counterpart in `Target`.
      Reconfiguration through the inbox (below) may settle it.

## Build

- [ ] Starting a session (Dan): a session's first turn needs a model, a system prompt (if any),
      tools (if any) and the first input. A session with no model selected is an invalid state, so
      make it unrepresentable: the starting model is recorded when the session opens, and
      `ModelFromFacts` loses its `initial` default. Whether the system prompt and tools are also
      recorded (they come from context assembly's providers today) is open.
- [ ] Reconfiguring a session, beyond the model and provider (built: `ModelChangeArrived`, taken
      between steps; `ModelFromFacts`; the fallback chain reports the switch when a fallback
      answers): thinking and effort. Newer Anthropic models take thinking as `adaptive` or off and
      use effort in its place; older ones take levels (low, medium, high).
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
- Sending reasoning back to the provider.
- A seam for provider-specific hooks that shape context and apply pre-flight constraints.
- Cache-control headers, and compaction that knows the provider's cache.
- Attachments and system records in Claude Code sessions, including exo's injected memories.
