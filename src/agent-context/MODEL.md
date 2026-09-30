# agent-context

Assembles what the model is sent next. What is described here is built; where the design may go is
in `DESIGN.next.md`.

## What is built

- A1. A session's system prompt and tools are recorded when it opens. `opening(session, model)`
  asks each system prompt provider and each tool catalog, in the order listed, joins the prompts
  and appends the catalogs, and makes the `SessionOpened` observation that holds them.
- A2. Every request's system prompt and tools are read from the session's facts, not asked for
  again: the facts are the one place they are held.
- A3. The conversation a request carries is given by the `Conversation` service.
  `WholeConversation` is every turn of it (A6).
- A4. Notices come from their providers, in order, for each request, and go at the end of what the
  request carries, as one instruction message. Each is reported as `NoticeInserted`, so later
  requests carry it where it was sent (agent-machine S5).
- A5. A compaction window is a marker: `CompactionWindow` (agent-machine S4) records which span of the
  session a compaction covers, and nothing else. A summary of a window is a `WindowSummary`
  (`forks.ts`): the window, the summary, and the summarizer that wrote it. Summaries are a record
  beside the session's facts (`Summaries`; `SummariesInMemory` holds them for as long as its layer
  lasts), and one once recorded is not changed. The session's facts grow as if nothing were
  compacted. `compact(session, summarizer)` compacts on request, between turns: the span is every
  fact after the last window's span, the summarizer is given the summaries of the windows before
  and the messages of the span, the summary is recorded, and then the window is reported. The
  importers write the summaries Claude Code and Codex made to `summaries.jsonl`, written by
  `claude-code` or `codex`.
- A6. A request carries the messages the request before it carried, as recorded with that request,
  followed by the messages of the facts recorded since (`nextMessages`). Nothing before the last
  request is projected again: a change to the projection changes what later requests add, not
  what an earlier request carried. A compaction's view is the one that rebuilds the messages.
- A7. With `CompactedConversation`, the first request in a window carries the summary of every
  window opened so far, in the order opened, each as recorded, then the messages of the facts the
  window keeps and of those after its span. Later requests in the window carry on from it (A6).
  A summary is read from the record and never written again, so a change of summarizer changes
  the summaries of later windows only.

Each of these is an Effect service, supplied by a layer. `example-providers.ts` holds examples: a
notice of the current time, a fixed model, and a selector that moves to a larger model when the
contents are estimated not to fit.

## What is not built

- Compaction the session decides on itself, by a policy: a window is made only when `compact` is
  asked for.
- A provider's own compaction (Anthropic's compaction block, OpenAI's `compaction` item). Neither
  adapter asks for one or sends one back.
- Caching. No request marks anything for the provider's cache.
- Model selectors in the loop. The loop asks `ModelProvider` for the model (from the session's
  facts), so `ModelSelectors` and `assemble` are used only by their tests.
- Forks as sessions, the turn pointer, and addressing facts by session and position.

The FizzBuzz example compacts on request with two summarizers (`src/examples/fizzbuzz/summarizers.ts`,
`tests/examples/fizzbuzz-compaction.test.ts`). It also has an older toy (`FizzBuzzCompaction` in
`src/examples/fizzbuzz/compaction.ts`): a view that sends the completed turns as one summary,
computed from the facts for every request, recording nothing and using no window.
