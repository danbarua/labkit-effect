# Model

The domain core of a coding harness: a session in which a user talks to a model, and the model
calls tools.

## Constraints (Dan, verbatim)

- C1. Pure state machines.
- C2. Message passing only.
- C3. Build in the abstract. No concrete implementations.
- C4. Facts, Decisions, Effects, Observations.
- C5. No unbranded strings.
- C6. Everything written down - code or prose - says exactly what it means and nothing else.
- C7. Behaviours: implementation details. Those are the layer *around* the core. Contracts. Adapters.

## Layout

- `src/agent-core/`: data and pure machines. Imports `Schema` from `effect` and nothing else from
  outside itself. `bun run check:core` enforces this and C5.
- `src/agent-effect/`: the layer around the core. Contracts as Effect services, adapters, the loop.

## Terms

Status: **open** means Dan has not settled it. **Proposal** means the wording is Claude's.

| # | Term | Definition | Status |
|---|------|------------|--------|
| T1 | Observation | Dan: "a Fact that's out of our sphere of influence." Proposal: something that reached the harness from outside, which the harness did not choose: user input, model output, a tool's output, a permission answer. | open |
| T2 | Decision | Proposal: a choice the harness makes, computed by a pure function of the facts and the configuration. | open |
| T3 | Effect | Proposal: an action on the outside world. The core sends a request for it as a message; an adapter carries it out. Its result reaches the core as an Observation. | open |
| T4 | Fact | Dan: an Observation is a kind of Fact. Proposal: a Fact is a recorded Observation or a recorded Decision. The journal is the sequence of Facts. | open |
| T5 | Event | Dan uses it for an Observation arriving and for a message the harness sends. Proposal: not a domain term. Arriving is an Observation; leaving is an Effect request. | open |
| T6 | View | Proposal: a pure function of the facts, for example the conversation shown to a user. Not recorded. | open |

## Rules

- R1. A recorded Observation is kept as received. Every part of it is in the Fact. Leaving a part
  out is a Decision, and is recorded as one. (Proposal.)
- R2. A decoder for a model response maps every received part to a part in the Observation. A part
  the decoder does not recognise becomes an `Unrecognised` part holding what was received.
- R3. For every machine state and every Observation kind, the machine produces a stated result.
  An Observation the current state does not expect produces the Decision `ObservationNotExpected`.
  The compiler checks this: every `switch` over a union ends in `satisfies never`.
- R4. A live view and a view built after reload are the same function applied to the same facts.
- R5. The journal is read strictly: a fact with a field this build does not know is refused, not
  stripped. Effect Schema strips unknown fields by default.

## Input during a turn

Dan: "The world isn't sealed while the agent thinks, skeddadles, makes 20 tool calls."

- I1. Input arrives from the user, the system (a wake-up, a scheduled prompt), or another agent,
  at any time.
- I2. Input that arrives while the session is idle leads to a turn. The core decides when and with
  which inputs (Decision `TurnRequested`, request `StartTurn`); an adapter starts the turn, chooses
  its identity, and reports it (Observation `TurnStarted`). Input that arrives while a turn is
  starting is queued for that turn's next step.
- I3. Input that arrives during a turn is queued. It is given to the turn (Decision
  `InputDelivered`) at the next point between steps: when every call of a tool batch has settled,
  or when the model gives a final answer. The model is then asked again.
- I4. A turn ends (Decision `TurnAnswered`) on a final answer with no input queued. (Dan chose this.)
- I5. The sender can cancel a queued input (Observation `InputCancelled`). Cancelling an input
  already given to a turn is recorded as `ObservationNotExpected`.
- I6. A turn that fails drops its queued input (Decision `InputDropped`, recorded before
  `TurnFailed`). No turn is under way until the next input arrives. (Dan: "There is no 'next turn',
  until stimulus is received.")

## Decisions and effects

The core decides **when** and with **what**; an adapter decides **how** (Dan). Every effect follows
one pattern: a Decision recorded, an effect request sent, the outcome observed.

| Decision | Request | Observed outcome |
|---|---|---|
| `TurnRequested` | `StartTurn` | `TurnStarted` |
| `ModelAsked` | `RequestModelResponse` | `ModelResponded`, `ModelFailed` |
| `ToolCallAllowed` | `RunTool` | `ToolEnded` |
| (none; the question is not a choice) | `AskPermission` | `PermissionAnswered` |

What the design has to allow, without surprising a maintainer (Dan, "not a spec"): layers above the
core that assemble what the model is sent (system prompt, history, tool schemas, system notices),
choose which model and how it is called, and carry out the call, for example with routing policies.

## What the model has seen

The model's response to a request is its observation of what the request carried, as a tool's
result is the harness's observation of the tool (Dan: the LLM "observes the tool result out loud and
then continues").

- S1. `ModelAsked { turn, through }` records how far a request goes: the conversation through the
  fact at `through`.
- S2. The model has seen a fact once it responds to a request that contained it. A request that
  fails leaves what it carried unseen. The view holds `seenThrough` and `sentThrough`, and
  `unseen(view)` lists the inputs, tool results and refusals the model has not seen.
- S3. `ModelFailed` means the request failed after whatever the layer around the core does first:
  retries with back-off, another model or provider. The turn fails and the session is idle until
  the next input. That turn's first request carries the input and everything still unseen.

## Captured observations

Streamed partial model output is side-band information for display, like a progress bar: a
captured observation, not recorded (Dan). `throttle.ts` is a machine that releases captured items
in batches at most once per interval; time is an input, so it also serves tests.

## Open questions

