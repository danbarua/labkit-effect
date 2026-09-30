# agent-core

Inputs arrive, turns run, the model is asked, tools are called. The core records what it
observes and what it decides, and sends requests for effects. It does not carry them out, and it
does not decide whether they happen.

## Terms

Status: **open** means Dan has not settled it. **Proposal** means the wording is Claude's.

| # | Term | Definition | Status |
|---|------|------------|--------|
| T1 | Observation | Dan: "a Fact that's out of our sphere of influence." Proposal: something that reached the harness from outside, which the harness did not choose: an input, model output, a tool's outcome, a policy's veto. | open |
| T2 | Decision | Proposal: a choice the harness makes, computed by a pure function of the facts. | open |
| T3 | Effect | Proposal: an action on the outside world. The core sends a request for it as a message; an adapter carries it out. Its result reaches the core as an Observation. | open |
| T4 | Fact | Dan: an Observation is a kind of Fact. Proposal: a Fact is a recorded Observation or a recorded Decision, at its position in the session. | open |
| T5 | Event | Dan uses it for an Observation arriving and for a message the harness sends. Proposal: not a domain term. Arriving is an Observation; leaving is an Effect request. | open |

## Rules

- R1. Content from outside the harness (a tool's input or output, a provider's metadata, a
  policy's reason, a part of a response the adapter does not recognise) is carried as `Received`:
  its media type, and its body as text or bytes, unparsed. The core does not look inside it. An
  adapter that needs the contents parses it, and handles and logs a parse that fails.
- R2. A model response is recorded with every part the model sent, in order. A part the adapter
  does not recognise is recorded as `Unrecognised`, holding what was received.
- R3. A failed model request is recorded as `FailureText`; what was received with it is logged by
  the adapter that received it.
- R4. A tool call succeeds or fails. `Failed` carries the reason (`Reported`, `NotFound`,
  `InputRejected`, `Vetoed`), for code that cares; code that needs only ok or not-ok matches on the
  outcome's two cases.
- R5. Every `switch` over a union ends in `satisfies never`, so a new kind of observation or decision
  does not compile until every machine handles it.
- R6. The core is machines that pass messages, in a tree: the agent, a conversation turn per
  turn, a turn step per model request, a call per tool call. Each is a table from (state kind,
  message kind) to a transition, "ignored" or "deferred"; whether a message is acted on depends on
  the two kinds alone. A deferred message waits in the machine's mailbox and is tried again after
  its next transition. The router delivers an observation to the machine its fields address. An
  observation a machine ignores is recorded as `ObservationNotExpected`; one addressed to a turn or
  call no machine exists for, as `ObservationUndelivered`.

- R7. Every observation is recorded with its origin: who or what in the world outside the core
  reported it (a user through some surface, another session, a provider, a tool, a part of the
  harness, a test). A decision has none: it is the core's own. Whoever gives a session an
  observation says who it is; giving one with no origin is a defect.

## Input during a turn

Dan: "The world isn't sealed while the agent thinks, skeddadles, makes 20 tool calls."

- I1. Input arrives from the user, the system (a wake-up, a scheduled prompt), or another agent,
  at any time.
- I2. Every machine has a mailbox. Input that arrives while no turn is running waits in the
  agent's mailbox. When a turn starts is decided by the layers around the core, which report
  `TurnStarted`; the turn then takes every input waiting (Decision `InputDelivered`, one per
  input).
- I3. Input that arrives while a turn runs waits in the turn's mailbox and is taken between steps:
  when every call of a tool batch has settled, or when the model gives a final answer. The model is
  then asked again.
- I4. After a response with no tool calls (a final answer, or one cut short) the turn asks the
  layers around the core for anything more first (request `BeforeTurnEnded`; a Stop hook's
  feedback, say, arrives as input), and they answer with `TurnEndReviewed`. The turn ends
  (Decision `TurnEnded`: `Answered`, or `CutShort`) when no input was taken by then; otherwise it
  goes on. A response cut short is not followed by another request with nothing new for the model
  to answer. How often hooks may hold a turn open is the layers' business.
- I7. A response that is whole, has no tool calls, and that its provider marks as not the end of
  the model's turn (`Unfinished`: Anthropic's `pause_turn`) is followed by another request at
  once. Whether a response that reads as unfinished, with no such mark, is followed up is a
  judgement for the layers around the core.
- I5. The sender can cancel input still waiting in a mailbox (Observation `InputCancelled`); it is
  withdrawn. Cancelling input already taken changes nothing.
- I6. A turn that ends other than by an answer (`Failed`, `Vetoed`) drops the input still waiting
  (Decision `InputDropped`). No turn is under way until the next input
  arrives. (Dan: "There is no 'next turn', until stimulus is received.")

## Tool calls

- C1. A tool call is three facts: the model asked for it (`ToolCallArrived` while its response is
  still arriving, or as a part of `ModelResponded`), the tool began to run (`ToolCallDispatched`),
  and how it ended (`ToolEnded`). A call may have the first without the second, and the second
  without the third.
- C2. A call that arrives while the response streams is run at once, without waiting for the rest
  of the response; the response, when it is recorded, holds the call as one of its parts and does
  not run it again. The calls of one response run at the same time.
- C3. Every call a recorded response made has a result when the model is next sent the
  conversation: the one recorded; for a call with none, that how it ended was not observed
  (`Indeterminate`) when it began to run, and that it was not run (`NotRun`) when it did not. The
  result follows the response that made the call, whenever the tool ended.
- C4. A call that arrived in a response that then failed is recorded, with its dispatch and its
  end. The response is not, so the model is not sent the call or its result.

## Interruption

- X1. Interrupted while a step is under way, the turn asks for its work to stop (`StopTurnWork`)
  and waits to hear how far each request got: a model request reports the response as far as it
  had arrived, with the parts that were complete (`ModelResponded`, ending `Interrupted`); a tool
  that was running, that how it ended was not observed; a call not yet run, that it was not. The
  turn then ends (`Interrupted`). It ends on a step's boundary, so the conversation goes on from it.
- X2. Interrupted between steps, the turn ends at once.
- X3. Input that arrives while the turn waits is dropped when it ends, as I6 says.

## Decisions and effects

Every effect the core requests follows one pattern: a Decision recorded, an effect request sent,
the outcome observed. When a turn starts is not one of them: the layers around the core decide it
and report `TurnStarted`.

| Decision | Request | Observed outcome |
|---|---|---|
| `ModelAsked` | `RequestModelResponse` | `ModelResponded`, `ModelFailed`, `ModelVetoed` |
| (none: every proposed call is requested) | `RunTool` | `ToolCallDispatched` when the tool begins to run, then `ToolEnded` (`Succeeded`, `Failed`) |
| (none: the turn was interrupted) | `StopTurnWork` | each request under way reports how far it got |

Whether a requested effect happens is decided outside the core. The core sees a veto as an outcome:
a vetoed tool call settles like any other, and the model is asked again; a vetoed model request
ends the turn.

What the design has to allow, without surprising a maintainer (Dan, "not a spec"): layers above the
core that assemble what the model is sent (system prompt, history, tool schemas, system notices),
choose which model and how it is called, and carry out the call, for example with routing policies.

## What the model has seen

The model's response to a request is its observation of what the request carried, as a tool's
result is the harness's observation of the tool (Dan: the LLM "observes the tool result out loud and
then continues").

- S1. `ModelAsked { turn }` is recorded where the request is made: it is made from the facts before
  it, and the conversation view decides which of them are sent.
- S2. The model has seen a fact once it responds to a request that contained it. A request that
  fails leaves what it carried unseen. Working out what is unseen belongs to whatever reads the
  facts for a purpose (the next request, a person's display, a protocol).
- S3. `ModelFailed` means the request failed after whatever the layers around the core do first:
  retries with back-off, another model or provider. The turn ends, and no turn is under way until
  the next input. That turn's first request carries the input and everything still unseen. It
  carries the error as the layer encoded it (`error`), beside the words (`failure`). An attempt
  that failed on the way, after which the request went on, is `ModelAttemptFailed`; it is recorded
  when it happens, and the turn does not end.
- S4. A compaction is started by the layers around the core, which report the span they chose as
  `CompactionWindow { window, previous, through, kept }`. It goes to the agent like input: taken at
  once while no turn runs, otherwise waiting in the turn's mailbox until between steps, or until the
  turn ends. Taking it records `WindowOpened`. Requests after that are made in the window: a summary
  in place of the facts through `through`, except those at `kept`, then everything after. The
  summary is not a fact of the session; it belongs to a compaction fork over the window, held apart.
- S5. A notice (timely context, such as the current time) is decided on by the layers around the
  core, which report it as `NoticeInserted { turn, text }` while they make the request that carries
  it. Every later request carries it in the same place: a provider that binds thinking to what came
  before it rejects a request that leaves out a notice sent earlier. Notices are disposable content:
  a compaction may drop them.

## Captured observations

Streamed partial model output is side-band information for display, like a progress bar: a
captured observation, not recorded (Dan). Two kinds are passed on while a response arrives: each
stream event as received (`ModelStreamed`), and each part of the response once it is complete
(`ModelPartArrived`). The response is recorded whole when the stream ends, with the parts that
were completed: one still arriving when it was cut short is not part of it. `throttle.ts` is a machine that releases captured items
in batches at most once per interval; time is an input, so it also serves tests.

## Direction (Dan, 2026-09-29): not a spec

**Streaming, and every kind of thinking content.** Where a provider streams, requests stream; where
it returns anything about the model's thinking (summaries, progress updates between tool calls,
commentary before a tool call), requests ask for it. Two reasons: a person watching can interrupt
a generation that is going off course and fix what misled it (reword the prompt, remove the
context that was misread); and an advisor agent is given the thinking summaries and tool calls as
they arrive, can make read-only tool calls of its own, and records nit, concern and blocker
notices. A compaction can then say what was assumed, what the advisor warned, and what the better
course was, which steers a model better than a bare rule ("never X").

**Reconfiguring a session.** A change to how a session runs (the same model with different
thinking, another model, another provider) is an observation recorded like any other, so a session
loaded from its record, or a fork, goes on with it. It is a message posted to the session's inbox, and the session
reconfigures itself when it takes it, between steps as with other mail. Fallback chains are built
on this: when a provider is down or a subscription's limit is reached, whatever notices reports a
change of model or provider, and the next request goes there. Built for the model and provider:
`ModelChangeArrived`, taken as `ModelChangeTaken`. A model's settings (`thinking`, `observe`,
`effort`) are said in the opening and in a change; each stays as last said.

**Configuration is three kinds of fact.** How a request is to be processed (which model, how it
thinks, what of its thinking is shown, how much effort) is said in the core in a small set of
plain terms, the way one would say it to a colleague. It shows up in the record as:

- a preference: what the user, or whoever started the session, asked for;
- a decision: what the harness chose, such as a fallback to another provider;
- an enforcement: what a model requires whatever was asked (Opus 5.5 was asked for, so thinking
  is on).

Each provider's adapter writes the wire format of its API. Each model, or class of models, that
brings its own constraints has a small function that runs before the request and makes it one the
provider will accept, doing the sensible thing and recording what it enforced
(`SettingEnforced`); it is not a validator of every combination. An enforcement is a change to the
session's settings for that model: it is recorded on the first request, the requests after it are
sent what the model allows, and nothing more is enforced. What was asked stands for any other model. Shaping a request and refusing one are the same place with a
different outcome. Whoever needs a model without thinking chooses a model that allows it.

