# agent-context

`src/agent-context` assembles what the model is sent in each request: the system prompt, the tools,
the conversation, and notices. It also compacts a session: it writes summaries of spans of the
conversation and gives each provider a conversation that starts from that provider's summaries.

Direction that is not built is in [agent-context-direction.md](agent-context-direction.md).

## Files

| File | Responsibility |
| --- | --- |
| `assemble.ts` | The services that assembly reads (`SystemPrompts`, `Notices`, `Conversation`, `ModelSelectors`), `opening`, and `assembleContents`. |
| `assembler.ts` | `AgentContextAssembler`, the loop's `ContextAssembler`; `WholeConversation`. |
| `compaction.ts` | `compact`, `compactIfDue`, `CompactionPolicy`, `Summarizer`, `Summaries` and `SummariesInMemory`; `CompactedConversation`. |
| `forks.ts` | `WindowSummary`: a summary of one compaction window, for one provider. |
| `summaries-in-folder.ts` | `SummariesInFolder`: summaries kept as files. |
| `provider-compaction.ts` | `providerCompaction`: a summarizer that asks the provider for its own compaction. |
| `digest.ts` | `DigestSummarizer`: a summarizer that lists a span's attachments and tool calls, with no model. |
| `example-providers.ts` | Examples: a notice of the current time, a fixed model selector, and a selector that moves to a larger model. |
| `log-keys.ts` | The names of the log events that this module writes. |

## The system prompt and tools

`opening(session, model)` builds the `SessionOpened` observation:

- The system prompt is the output of each system prompt provider (`SystemPrompts`), in the order
  listed, joined by blank lines.
- The tools are those that the session's tool sources offer (`ToolSources`), in order. A source with
  a namespace offers each tool as `<namespace>__<tool>`.

Every request reads the system prompt and tools from the session's facts, not from the providers.
`assembleContents` does not depend on `SystemPrompts`, so it cannot ask the providers again.

## What a request carries

`AgentContextAssembler` builds each request's `ModelContext`:

1. The system prompt and tools, as the session's facts record them.
2. The conversation, from the `Conversation` service.
3. The notices from the notice providers (`Notices`), in order, as one instruction message after
   the latest input or tool result. Each notice is recorded as `NoticeInserted` for the request's
   turn, so later requests carry it at the same place. A provider that checks the prefix before a
   thinking block rejects a request that leaves out a notice sent earlier.

A notice provider may read live state, not only the facts: its notice is in the facts once it is
inserted.

Two `Conversation` services are built:

| Service | Messages |
| --- | --- |
| `WholeConversation` | The whole session (`nextMessages`). The hosts use this one. |
| `CompactedConversation` | For a session with compaction windows: each provider's summaries, then the facts that follow them. The FizzBuzz example and the probes use this one. |

`nextMessages` returns the messages that the last request carried, as recorded with that request
(`ModelRequestDispatched.sent`), followed by the messages of the facts recorded after it. Facts
before the last request are not projected again. A change to the projection therefore changes what
later requests add, never what an earlier request carried.

## Compaction

A compaction window is a fact (`CompactionWindow`) that records which span of the session a
compaction covers and which policy decided it was due. The summary is not a fact: it is a
`WindowSummary` kept in `Summaries`, beside the session's facts. The session's facts grow as if
nothing were compacted.

A `WindowSummary` records:

| Field | Meaning |
| --- | --- |
| `session` | The session it summarises. |
| `window` | The window it covers. |
| `kind` | The provider whose requests carry it. |
| `writtenBy` | The summarizer that wrote it. |
| `writtenAt` | When it was written. |
| `summary` | Text, or JSON: a provider's own compaction items. |

A summary is never changed once it is recorded. A change of summarizer changes later summaries only.

`compact(session, summarizer, decidedBy)` runs between turns, for the provider that the session is
currently asking:

1. The span is every fact after that provider's latest window, including the turn that window kept.
   With no earlier summary for that provider, the span starts at the beginning of the session.
2. When the span holds more than one turn, its last turn is kept unsummarised and follows the
   summary.
3. The summarizer receives that provider's earlier summaries, the span's messages (without the
   kept turn), the session's model, and the session's system prompt and tools.
4. The summary is recorded in `Summaries`.
5. Then the window is recorded, named `window-<n>` for the session's n-th window, with the previous
   window and the sequence numbers of the kept turn. Recording the summary first means a failed
   summary leaves no window.

`compactIfDue(session, policy)` asks a `CompactionPolicy` whether to compact now and with which
summarizer, and records the policy's name on the window. Whoever runs the session calls it between
turns; the loop does not call it.

`CompactedConversation` gives a request to provider P:

- When P was sent a request after its latest window, or P has no summary and was sent a request:
  the messages of P's last request, as recorded, followed by the messages of the facts since. A
  switch back to P therefore continues from where P was.
- Otherwise, when P has a summary: one instruction message with P's summaries in the order written,
  then the messages of the turn that the window kept and of the facts after the window. Only P's
  summaries are carried, and only those of this session.
- When P has no summary and was never sent a request: the whole conversation. After a switch to a
  new provider, that provider starts from the beginning.

Two providers in one session can therefore be sent different conversations; what both are sent is
the facts since the later of their summaries.

A text summary is a `Text` part. A JSON summary is a provider's own compaction: each item becomes an
`Unrecognised` part from that provider, which only that provider's adapter sends, unchanged. A
provider's compaction was made from the summaries before it, so it replaces them in the message.

## Summarizers

| Summarizer | Summary |
| --- | --- |
| `providerCompaction(compactions)` | Asks the provider for its own compaction. The request carries the session's system prompt and tools, the provider's earlier summaries, then the span. The Responses adapter's `openAiCompactions` does this for OpenAI and xAI. The request is not recorded in the session's facts. A compaction that still fails after its retries is a defect, because the session has no summary to continue with. |
| `DigestSummarizer(digests)` | A digest made from the messages alone: the span's attachments by pointer, and one line per tool call. |
| FizzBuzz summarizers | `src/examples/fizzbuzz/summarizers.ts`. |

The trajectory importers write the summaries that Claude Code and Codex made to `summaries.jsonl`,
with `claude-code` or `codex` as the summarizer, and `claude-code auto`, `claude-code manual` or
`codex` as the policy that decided the window.

## Where summaries are kept

| Layer | Storage |
| --- | --- |
| `SummariesInMemory` | In memory, for as long as the layer lasts. |
| `SummariesInFolder(folder)` | One file per summary: `<folder>/<session>/<kind>/<number>_<writtenAt>_<writtenBy>_<window>.txt` or `.json`. Summaries are read back in the order written: by time, then by number within a kind. A file that cannot be written or read is a defect. |

## Model selection

`assemble` chooses a model for the assembled contents with `ModelSelectors`, in order. The loop does
not use it: the loop asks `ModelProvider`, which reads the model from the session's facts. Only the
tests use `assemble` and the selectors.

## Tests

- `context-assembly.test.ts`, `assembler.test.ts`: the opening, the contents of a request, and
  notices.
- `compaction.test.ts`, `summaries-in-folder.test.ts`: `compact`, `CompactedConversation`, and the
  folder of summaries.
- `digest.test.ts`: the digest.
- `src/agent-session/conversation.test.ts`: `nextMessages`.
- `tests/examples/fizzbuzz-compaction.test.ts`: compaction over FizzBuzz sessions, with several
  summarizers, a provider's own compaction, and a switch of provider.
