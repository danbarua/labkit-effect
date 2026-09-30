# agent-context

Assembles what the model is sent next. What is described here is built; where the design may go is
in `DESIGN.next.md`.

## What is built

- A1. A session's system prompt and tools are recorded when it opens. `opening(session, model)`
  asks each system prompt provider and each tool catalog, in the order listed, joins the prompts
  and appends the catalogs, and makes the `SessionOpened` observation that holds them.
- A2. Every request's system prompt and tools are read from the session's facts, not asked for
  again: the facts are the one place they are held.
- A3. The conversation a request carries is a view of the session's facts, given by the
  `Conversation` service. `WholeConversation` is every turn of it.
- A4. Notices come from their providers, in order, for each request, and go at the end of what the
  request carries, as one instruction message. Each is reported as `NoticeInserted`, so later
  requests carry it where it was sent (agent-machine S5).
- A5. A compaction window is a marker: `CompactionWindow` (agent-machine S4) records which span of the
  session a compaction would cover, and nothing else. A summary of a window is a `WindowSummary`
  (`forks.ts`), held apart from the session's facts; the importers write the ones Claude Code and
  Codex made to `summaries.jsonl`.

Each of these is an Effect service, supplied by a layer. `example-providers.ts` holds examples: a
notice of the current time, a fixed model, and a selector that moves to a larger model when the
contents are estimated not to fit.

## What is not built

- Compaction. No request is made in a window: nothing chooses which of a window's summaries a
  request uses, and nothing writes a summary while a session runs. The window marker is recorded
  and taken (`WindowOpened`), and that is all.
- A provider's own compaction (Anthropic's compaction block, OpenAI's `compaction` item). Neither
  adapter asks for one or sends one back.
- Caching. No request marks anything for the provider's cache.
- Model selectors in the loop. The loop asks `ModelProvider` for the model (from the session's
  facts), so `ModelSelectors` and `assemble` are used only by their tests.
- Forks as sessions, the turn pointer, and addressing facts by session and position.

The FizzBuzz example (`src/examples/fizzbuzz/compaction.ts`) has a toy compaction: a view of the
conversation that sends the completed turns as one summary, computed from the facts for every
request. It shows where a compaction's view would sit. It records nothing and uses no window.
