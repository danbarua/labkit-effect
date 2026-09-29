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
- I4. After a final answer the turn asks the layers around the core for anything more first
  (request `BeforeTurnEnded`; a Stop hook's feedback, say, arrives as input), and they answer with
  `TurnEndReviewed`. The turn ends (Decision `TurnEnded`, `Answered`) when no input was taken by
  then; otherwise it goes on. How often hooks may hold a turn open is the layers' business.
- I5. The sender can cancel input still waiting in a mailbox (Observation `InputCancelled`); it is
  withdrawn. Cancelling input already taken changes nothing.
- I6. A turn that ends other than by an answer (`Failed`, `Vetoed`) drops the input still waiting
  (Decision `InputDropped`). No turn is under way until the next input
  arrives. (Dan: "There is no 'next turn', until stimulus is received.")

## Decisions and effects

Every effect the core requests follows one pattern: a Decision recorded, an effect request sent,
the outcome observed. When a turn starts is not one of them: the layers around the core decide it
and report `TurnStarted`.

| Decision | Request | Observed outcome |
|---|---|---|
| `ModelAsked` | `RequestModelResponse` | `ModelResponded`, `ModelFailed`, `ModelVetoed` |
| (none: every proposed call is requested) | `RunTool` | `ToolEnded` (`Succeeded`, `Failed`, `Vetoed`) |

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
- S4. A compaction is started by the layers around the core, which report it as `Compacted { window,
  previous, summary, through, kept }`. It goes to the agent like input: taken at once while no turn
  runs, otherwise waiting in the turn's mailbox until between steps, or until the turn ends. Taking
  it records `WindowOpened`. Requests after that are made in the window: its summary in place of the
  facts through `through`, except those at `kept`, then everything after.

## Captured observations

Streamed partial model output is side-band information for display, like a progress bar: a
captured observation, not recorded (Dan). `throttle.ts` is a machine that releases captured items
in batches at most once per interval; time is an input, so it also serves tests.

## Direction (Dan, 2026-09-29): not a spec

**Starting tools while the response streams.** Claude Code parses tool calls out of the stream and
starts each one as soon as its call is complete, while the model is still writing; its session
files record such a tool's result before the rest of the message. The core has no concept for
this. A shape that fits: a machine per model request fed by the captured stream chunks, tracking
the block being written (thinking, text, a tool call's input accumulating); when a tool call's
block closes it tells the step `CallReady`, and the step opens and runs that call early. The
recorded fact does not change: `ModelResponded` still holds the whole response when the stream
ends, and calls already opened stay open.

**Reconfiguring a session.** A change to how a session runs (the same model with different
thinking, another model, another provider) is an observation recorded like any other, so a replay
or a fork reproduces it. It is a message posted to the session's inbox, and the session
reconfigures itself when it takes it, between steps as with other mail. Fallback chains are built
on this: when a provider is down or a subscription's limit is reached, whatever notices reports a
change of model or provider, and the next request goes there. Built for the model and provider:
`ModelChangeArrived`, taken as `ModelChangeTaken`; thinking is not modelled yet.

