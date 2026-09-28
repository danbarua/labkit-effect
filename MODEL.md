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

- R1. An Observation is recorded as received. Every part of it is in the Fact. Leaving a part out
  is a Decision, and is recorded as one. (Proposal.)
- R2. A decoder for a model response maps every received part to a part in the Observation. A part
  the decoder does not recognise becomes an `Unrecognised` part holding what was received.
- R3. For every machine state and every Observation kind, the machine produces a stated result.
  An Observation the current state does not expect produces the Decision `ObservationNotExpected`.
  The compiler checks this: every `switch` over a union ends in `satisfies never`.
- R4. A live view and a view built after reload are the same function applied to the same facts.

## Open questions

- Q1. Streamed partial model output: is each chunk an Observation, recorded? Not decided.
- Q2. Is starting a turn a Decision, or does a user message start one by definition? The code has
  it as a Decision (`TurnStarted`).
