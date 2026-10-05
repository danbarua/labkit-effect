# agent-session

`src/agent-session` runs a session. It holds the loop around the core (`agent-machine`): the loop
records each observation, asks the core what follows, records the decisions, and carries out the
requests that the core makes. The module also holds the services that carry out those requests:
the provider adapters, the stores where a session's facts are kept, and the session's configuration.

## Files

| Area | Files |
| --- | --- |
| The loop | `loop.ts` (`openSession`, `Session`), `contracts.ts` (the services that the loop needs), `report.ts`, `work.ts`, `origin.ts`, `turns.ts`, `model-stream.ts` |
| Where facts are kept | `session-store.ts`, `file-session-store.ts`, `blobs.ts` |
| What a request carries | `conversation.ts`, `tool-output.ts`, `turn-context.ts`, `sent.ts`, `received.ts` |
| Tools | `tool-sources.ts`, `tool-input.ts` |
| Providers | `provider-call.ts`, `shaping.ts`, `model-fallback.ts`, `providers/` (Anthropic Messages, OpenAI Responses, xAI, Chat Completions) |
| Configuration | `configuration/`: the model and settings read from the facts, the well-known models, the options a host offers, and the gate for a user's changes |
| Usage | `accounting.ts`: the context gauge and cost, read from the facts |
| Shared | `first-answer.ts` (an ordered list of sources where the first that knows answers), `log-keys.ts` |

## Services the loop needs

| Service | Job |
| --- | --- |
| `SessionStore` | Keeps the session's facts. Required: there is no default. |
| `ModelProvider` | Returns the model that a request goes to. |
| `ContextAssembler` | Builds what a model request carries. |
| `ModelClient` | Makes a model request. |
| `ToolRunner` | Runs a tool call. |
| `Turns` | Gives each new turn its identity. |
| `ToolCallPolicies`, `ModelRequestPolicies` | Review requests before they are carried out (`docs/agent-policy.md`). Empty by default. |
| `TurnEndHooks`, `MaxHolds` | Review a turn before it ends. Empty and 0 by default. |

## The loop

For each observation, the loop:

1. writes the observation to the store;
2. delivers it to the core, and writes the decisions that the core makes;
3. carries out each request that follows, in a fiber of its own.

Each fact is written before anything is done on it. That a request was made is recorded before the
request goes out (`ModelRequestDispatched`, `ToolCallDispatched`). After a crash, a request with no
dispatch in the facts was therefore not made, and a request with a dispatch and no outcome may have
been made.

Observations are recorded one at a time, in the order they arrive. Because each request runs in its
own fiber, the session takes further observations while requests run; input waits in the core's
mailboxes. A turn starts when input arrives while the agent is idle: the loop asks `Turns` for an
identity and records `TurnStarted`.

When the core asks for a turn's work to stop, each request under way ends what it is doing and
reports how far it got: a model request reports the response as far as it arrived, and a tool run
reports that its end was not observed.

A request that dies of a defect is logged with the defect's message and stack (`loop.request.died`),
and an outcome is recorded for it, so its turn still ends:

| Request | Outcome recorded |
| --- | --- |
| Model request | `ModelFailed`, with the defect's message and stack |
| Tool run | `ToolEnded` with `Failed { Indeterminate }` |
| Turn-end review | `TurnEndReviewed` |

While a request runs, `CurrentWork` holds the session, the turn, and for a tool run the call and the
tool. Every log line written during the request is annotated with them, and each request runs in a
span named for its kind (`agent.model.request`, `agent.tool.run`, `agent.turn.review`).

### When a write fails

A write that fails stops the session:

- nothing after it is written;
- the requests under way are interrupted;
- a tool whose dispatch could not be written does not run;
- `observe`, `idle`, `prompt` (also while it waits for its turn to end) and `cancel` fail with the
  reason;
- the failure is logged as an error (`loop.store.failed`) with the facts that were not written.

## What a host calls

| Operation | Behaviour |
| --- | --- |
| `observe(observation)` | Records the observation with the origin that `CurrentOrigin` gives, and returns once it is recorded. A session given an observation with no origin set is a defect. |
| `prompt(input)` | Records the input as the user's (`InputArrived` from `User`, with its text and attachments) and returns how the turn that took it ended. |
| `cancel` | Records `TurnInterrupted` for the turn under way and returns once it is recorded. |
| `turn` | Returns the turn under way, or undefined. |
| `idle` | Waits until no request is running. |
| `facts` | Returns the session's facts. |
| `goOn` | Continues a turn that the facts left running. |
| `subscribe` | Every fact recorded from now on. |
| `streamed` | What model requests pass on while their responses stream. None of it is recorded. |

- **The turn under way** is the latest `TurnStarted` with no `TurnEnded` for it. Between turns there
  is none.
- **`prompt`** starts a turn when none is under way. When a turn is under way, the input goes to
  that turn, which takes it between steps; `prompt` returns when that turn ends. If the turn ends
  other than with an answer, the input is dropped and `prompt` returns that ending. Two `prompt`
  calls at once go to the same turn, and both return its ending. A turn that failed leaves no turn
  under way, so the next `prompt` starts a new one. `prompt` waits on the facts recorded, and holds
  nothing while it waits: the session takes observations meanwhile, such as a permission answer
  from another fiber.
- **`cancel`** returns before the turn has ended. The turn ends `Interrupted` once its requests have
  reported how far they got. A call that is waiting for a permission answer ends `NotRun`, and its
  question is no longer waited on. With no turn under way, `cancel` records nothing.

### A turn the facts left running

`openSession` starts from the facts that its store keeps. When the facts stop while a turn runs,
the turn is left under way with its requests unanswered: the process that was carrying them out has
ended. The host chooses what to do:

- `goOn` carries out each request that has no outcome. A model request is made again. A tool call
  runs again only when its tool's `replay` is `safe` (it changes nothing). Any other call ends
  `Indeterminate` if it had begun, and `NotRun` if it had not.
- `endTurnLeftRunning` interrupts the turn and records what is known of each request. No request is
  made again.

## Where facts are kept

| Store | Behaviour |
| --- | --- |
| `EphemeralSessionStore` | Keeps the facts in memory, until the process ends. |
| `FileBackedSessionStore(file)` | Keeps the facts in a file, one JSON line per fact. |

A store opened on facts it already keeps is the session continuing from them.

The file store:

- **Lock.** One process writes a file at a time. The process holds `<file>.lock`, which contains
  its process id, while the store is open. A lock whose process has ended is taken over, and so is a
  lock file that names no process (a process id is a positive integer). Taking over a lock is logged
  as a warning.
- **Reading.** A file is read as facts 1 to n, in order; a file that is not is refused. A last line
  without its line break is a write that did not finish: it is not read, it is cut off before the
  file is written to again, and the cut is logged as a warning.
- **Flushing.** Each `append` writes its facts and flushes them to the disk (`fsync`) before it
  returns, so a fact is on the disk before anything follows from it, through a power cut as well as
  a killed process. The folder of a new file is flushed too, so the file is found after a power cut.
  When the file system cannot flush the folder, that is logged as a warning and the store opens.
- **Format.** The format is the facts' schema as it is today. A file written before the schema
  changed may not read back; the store refuses it, with an instruction to delete it.

`blobs.ts` keeps bytes outside the facts, by the SHA-256 of the bytes; the facts hold references.

## A user's change of configuration

A user's change of model or settings becomes a fact when it is observed (`ModelChangeArrived`).
The configuration gate (`configuration/gate.ts`) decides when it is observed, so that the model
that started a turn completes it:

- While no turn runs, a change is made at once.
- While a turn runs, a change is held. Changes held are merged in the order they came, the later
  change's fields winning. The host settles the gate when the turn ends and before a turn starts;
  settling makes the held change as one. Settling while a turn runs makes nothing.
- A change submitted after the turn ended and before the host settles is made together with the
  held change.
- A held change is not a fact: if the process ends while a change is held, the change is lost.

A fallback chain's change of model does not go through the gate. It is observed at once, and the
core takes it between steps.

## A tool's output as the model is sent it

A tool's output is recorded as received. `tool-output.ts` decides how the conversation sends it. An
MCP server's result (`mcpToolResult`) is sent as plain text, one line per block:

| Block | Text sent |
| --- | --- |
| text | the text |
| embedded text resource | the resource's text |
| resource link | a Markdown link |
| image or audio | a line naming its type and media type |

A result with no text is sent as its `structuredContent`, as JSON. A tool's own failure (`isError`)
is sent the same way. Any other output is sent as recorded.

## Providers

Each provider adapter shapes the core's context into the provider's wire format and the response
back into the core's observations:

| Adapter | API |
| --- | --- |
| `providers/anthropic-client.ts` | Anthropic Messages |
| `providers/openai-client.ts` | OpenAI Responses |
| `providers/xai-client.ts` | xAI, through the Responses adapter |
| `providers/openai-compat-client.ts` | OpenAI-compatible Chat Completions |

- `provider-call.ts` does what every adapter does around one request: posts it, retries the
  failures that `AiError` marks retryable before a response begins, and otherwise ends as
  `ModelFailed` with the error and the request as posted. The whole error is logged where it is
  caught.
- `shaping.ts` holds what every adapter needs to shape a context. Where an adapter supplies or
  replaces something that the context does not say, it records it as `Supplied` and logs it.
- `model-fallback.ts` tries the session's target, then each fallback, moving on only after a
  failure that means the provider cannot serve the request now. When a fallback answers, the chain
  records a change of model to it.
- Each adapter's `*-settings.ts` maps the session's settings to the provider's fields. A setting
  that a model does not accept is sent as the nearest one it does, and the difference is recorded
  as adjusted before the request.

## Design decisions

- **Write before acting.** Recording each fact before anything follows from it makes the facts
  the one account of what happened: after a crash, the facts say which requests were made.
- **The facts are the one place.** Every request reads the model, its settings, the system prompt
  and the tools from the facts, so a session that continues from its facts behaves as the original
  session would have.
- **Only safe tools run again.** A tool call that may change something is not repeated when a
  session continues after a crash, because what it would change may have changed since; the model
  looks before it asks again.

## Tests

- `loop.test.ts`, `loop-concurrency.test.ts`, `prompt.test.ts`, `go-on.test.ts`, `resume.test.ts`:
  the loop and the operations a host calls.
- `file-session-store.test.ts`: the stores.
- `configuration/*.test.ts`: the gate, the model choice, settings and options.
- `tool-output.test.ts`, `conversation.test.ts`, `shaping.test.ts`: what a request carries.
- `permission.test.ts`, `model-request-policy.test.ts`, `loop-breaker.test.ts`: policies in the
  loop.
- `providers/*.test.ts`: each adapter.
