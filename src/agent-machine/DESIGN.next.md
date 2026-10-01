# agent-machine: where the design may go

Direction from Dan (2026-09-29 and 2026-09-30), recorded so the design can grow into it. Nothing
here is built, and none of it is a rule. What is built is in `MODEL.md`; what is to be built next
is in `TODO.md`.

## What the layers above the core are for

The design has to allow, without surprising a maintainer, layers above the core that assemble what
the model is sent (system prompt, history, tool schemas, system notices), choose which model and
how it is called, and carry out the call, for example with routing policies.

## Every kind of thinking content, and why

Requests stream and ask for whatever a provider returns about the model's thinking (built: see
MODEL.md M2 and V1). The reasons are what is to come:

- a person watching can interrupt a generation that is going off course and fix what misled it
  (reword the prompt, remove the context that was misread);
- an advisor agent is given the thinking summaries and tool calls as they arrive, can make
  read-only tool calls of its own, and records nit, concern and blocker notices;
- a compaction can then say what was assumed, what the advisor warned, and what the better course
  was, which steers a model better than a bare rule ("never X").

## Configuration as three kinds of fact

How a request is to be processed shows up in the record as:

- a preference: what the user, or whoever started the session, asked for;
- a decision: what the harness chose, such as a fallback to another provider;
- an adjustment: what a model requires whatever was asked (Opus 5.5 was asked for, so thinking
  is on).

A fact's origin says which (built: MODEL.md R6, M3). Not built: a way for a user to change the
model or its settings while a session runs, which will come from the surface the user works
through.

Each model, or class of models, that brings its own constraints has a small function that runs
before the request and makes it one the provider will accept; it is not a validator of every
combination. Shaping a request and refusing one are the same place with a different outcome:
refusing (`ModelVetoed`) is not built. Whoever needs a model without thinking chooses a model that
allows it.
