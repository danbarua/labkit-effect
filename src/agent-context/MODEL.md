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
  session a compaction covers and what decided it was due, and nothing else. A summary of a window
  is a `WindowSummary` (`forks.ts`): the window, the provider whose requests carry it (`kind`), the
  summary, the summarizer that wrote it and when. Summaries are a record beside the session's facts
  (`Summaries`: `SummariesInMemory`, or `SummariesInFolder`, a text file for each summary in a
  folder for each session and kind), and one once recorded is not changed. The session's facts
  grow as if nothing were compacted, and a window says nothing about which providers have a summary
  of it. `compact(session, summarizer, decidedBy)` compacts between turns, for the provider the
  session is asking: the span is every fact after that provider's last summary's window (from the
  start when it has none), the summarizer is given that provider's summaries and the messages of
  the span, the summary is recorded, and then the window is reported. A `CompactionPolicy` has a
  name and decides from the facts whether to compact now and with which summarizer; `compactIfDue`
  asks it, run between turns by whoever runs the session, and records its name on the window. The
  importers write the summaries Claude Code and Codex made to `summaries.jsonl`, written by
  `claude-code` or `codex`, and name `claude-code auto`, `claude-code manual` or `codex` as what
  decided the window.
- A6. A request carries the messages the request before it carried, as recorded with that request,
  followed by the messages of the facts recorded since (`nextMessages`). Nothing before the last
  request is projected again: a change to the projection changes what later requests add, not
  what an earlier request carried. A compaction's view is the one that rebuilds the messages.
- A7. With `CompactedConversation`, a request carries only the summaries of the provider it goes to.
  The first request to a provider after its latest summary carries all of its summaries, in the
  order written, as one instruction message (the harness speaking; the Anthropic adapter sends
  instructions that open the conversation in the top-level system), then the messages of the facts
  that summary's window keeps and of those after its span. A summary is read from the record and
  never written again, so a change of summarizer changes later summaries only.
- A8. A request to a provider that has been sent a request since its latest summary carries on from
  its last request (A6), whatever other providers were asked in between; a provider with no
  summaries and no request before is sent the whole conversation. So after a switch the new
  provider starts from the beginning, and a switch back goes on from where the old one was.

Each of these is an Effect service, supplied by a layer. `example-providers.ts` holds examples: a
notice of the current time, a fixed model, and a selector that moves to a larger model when the
contents are estimated not to fit.

## What is not built

- A policy the loop asks by itself: whoever runs the session asks one between turns.
- A compaction policy that applies at a share of the model's context window: that needs an
  estimate of the next request's size (`TODO.md`).
- A provider's own compaction (Anthropic's compaction block, OpenAI's `compaction` item). Neither
  adapter asks for one or sends one back.
- Caching. No request marks anything for the provider's cache.
- Model selectors in the loop. The loop asks `ModelProvider` for the model (from the session's
  facts), so `ModelSelectors` and `assemble` are used only by their tests.
- Forks as sessions, the turn pointer, and addressing facts by session and position.

The FizzBuzz example compacts with two summarizers (`src/examples/fizzbuzz/summarizers.ts`) when
the count reaches given numbers or after every FizzBuzz (`compaction-policies.ts`;
`tests/examples/fizzbuzz-compaction.test.ts`). It also has an older toy (`FizzBuzzCompaction` in
`src/examples/fizzbuzz/compaction.ts`): a view that sends the completed turns as one summary,
computed from the facts for every request, recording nothing and using no window.
