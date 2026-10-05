# agent-machine: direction

Dan's direction for the core (2026-09-29 and 2026-09-30). The first section describes uses that are
not built. The second records a design that is built, with its rationale. What is built is described
in [agent-machine.md](agent-machine.md); the work planned next is in `TODO.md`.

## Why every kind of thinking content is recorded

Requests stream, and ask for whatever a provider returns about the model's thinking. That is built.
The reasons are what is still to come:

- A person watching can interrupt a generation that is going off course and fix what misled it, by
  rewording the prompt or removing the context that was misread.
- An advisor agent receives the thinking summaries and tool calls as they arrive, can make read-only
  tool calls of its own, and records notices graded as nit, concern or blocker.
- A compaction can then say what was assumed, what the advisor warned, and what the better course
  was. That steers a model better than a bare rule ("never X").

## Configuration as three kinds of fact

How a request is to be processed appears in the record as one of three kinds of fact, distinguished
by the fact's origin. This is built: a user's change of model is observed from the user, a
fallback's change from the harness, and an adjustment as `SettingAdjusted`.

The three kinds:

- a preference: what the user, or whoever started the session, asked for;
- a decision: what the harness chose, such as a fallback to another provider;
- an adjustment: what a model requires whatever was asked (Opus 5.5 was asked for, so thinking is
  on).

Each model, or class of models, that brings its own constraints has a small function that runs
before the request and makes it one that the provider accepts; it is not a validator of every
combination. Shaping a request and refusing one happen in the same place with different outcomes.
Whoever needs a model without thinking chooses a model that allows it.
