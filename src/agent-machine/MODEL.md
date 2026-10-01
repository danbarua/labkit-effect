# agent-machine

Inputs arrive, turns run, the model is asked, tools are called. The core records what it
observes and what it decides, and sends requests for effects. It does not carry them out, and it
does not decide whether they happen.

Everything here is built. Each rule has an id, and at least one test whose name starts with that
id; `bun run check:rules` fails when a rule has none. Where the design may go is in
`DESIGN.next.md`.

## Terms

The code is built on these as worded. The wording is Claude's except where Dan is quoted, and Dan
has not yet confirmed or reworded it.

| # | Term | Definition |
|---|------|------------|
| T1 | Observation | Dan: "a Fact that's out of our sphere of influence." Something that reached the harness from outside, which the harness did not choose: an input, model output, a tool's outcome, a policy's veto. It is recorded with its origin. |
| T2 | Decision | A choice the core makes, computed by its machines from the facts. |
| T3 | Effect | An action on the outside world. The core sends a request for it as a message; an adapter carries it out. Its result reaches the core as an Observation. |
| T4 | Fact | Dan: an Observation is a kind of Fact. A Fact is a recorded Observation or a recorded Decision, at its position in the session, with the time it was recorded. |
| T5 | Event | Not a term of the code. Dan uses it for an Observation arriving and for a message the harness sends: arriving is an Observation; leaving is an Effect request. |

## Rules

- R1. Content from outside the harness (a tool's input or output, a provider's metadata, a
  policy's reason, a part of a response the adapter does not recognise) is carried as `Received`:
  its media type, and its body as text or bytes, unparsed. The core does not look inside it. An
  adapter that needs the contents parses it, and handles and logs a parse that fails.
- R2. A model response is recorded with every part that was complete, in order. A part the adapter
  does not recognise is recorded as `Unrecognised`, holding what was received.
- R3. A tool call succeeds or fails. `Failed` carries the reason (`Reported`, `NotFound`,
  `InputRejected`, `Vetoed`, `Indeterminate`, `NotRun`), for code that cares; code that needs only
  ok or not-ok matches on the outcome's two cases.
- R4. Every `switch` in the core ends in `satisfies never`, so a new kind of observation, decision
  or request does not compile until every machine handles it.
- R5. The core is machines that pass messages, in a tree: the agent, a conversation turn per
  turn, a turn step per model request, a call per tool call. Each is a table from (state kind,
  message kind) to a transition, "ignored" or "deferred"; whether a message is acted on depends on
  the two kinds alone. A deferred message waits in the machine's mailbox and is tried again after
  its next transition. The router delivers an observation to the machine its fields address. An
  observation a machine ignores is recorded as `ObservationNotExpected`; one addressed to a turn or
  call no machine exists for, as `ObservationUndelivered`.
- R6. Every observation is recorded with its origin: who or what in the world outside the core
  reported it (a user through some surface, another session, a provider, a tool, a part of the
  harness, a test). A decision has none: it is the core's own. Whoever gives a session an
  observation says who it is; giving one with no origin is a defect.

## Decisions and effects

Every effect the core requests follows one pattern: a Decision recorded, an effect request sent,
the outcome observed. When a turn starts is not one of them: the layers around the core decide it
and report `TurnStarted`.

| Decision | Request | Observed outcome |
|---|---|---|
| `AskModel` (a turn's first step), `TellModel` (each later step) | `RequestModelResponse` | `ModelRequestDispatched` when the request is made, then `ModelResponded`, `ModelFailed` or `ModelVetoed` |
| (none: every proposed call is requested) | `RunTool` | `ToolCallDispatched` when the tool begins to run, then `ToolEnded` (`Succeeded`, `Failed`) |
| (none: the model gave a response with no tool calls) | `BeforeTurnEnded` | input, if any, then `TurnEndReviewed` |
| (none: the turn was interrupted) | `StopTurnWork` | each request under way reports how far it got |

Whether a requested effect happens is decided outside the core. The core sees a veto as an outcome:
a vetoed tool call settles like any other, and the model is asked again; a vetoed model request
ends the turn.

## Input during a turn

Dan: "The world isn't sealed while the agent thinks, skeddadles, makes 20 tool calls."

- I1. Input arrives from the user, the system (a wake-up, a scheduled prompt), or another agent,
  at any time.
- I2. Every machine has a mailbox. Input that arrives while no turn is running waits in the
  agent's mailbox. When a turn starts is decided by the layers around the core, which report
  `TurnStarted`; the turn then takes every input waiting (Decision `InputDelivered`, one per
  input).
- I3. Input that arrives while a turn runs waits in the turn's mailbox and is taken between steps:
  when every call of a tool batch has settled, or when the model gives a response with no tool
  calls. The model is then asked again.
- I4. After a response with no tool calls the turn asks the layers around the core for anything
  more first (request `BeforeTurnEnded`; a Stop hook's feedback, say, arrives as input), and they
  answer with `TurnEndReviewed`. A whole response with answer text is recorded as
  `TurnCompleted`, one with none (only thinking or commentary) as `TurnIncomplete`, before the
  request. The turn ends (Decision `TurnEnded`: `Completed`, `Incomplete`, or `CutShort`) when no
  input was taken by then; otherwise it goes on. Whether an incomplete turn is held open is a
  host's turn-end hook's to decide. A response cut short is not followed by another request with nothing new for the model
  to answer. How often hooks may hold a turn open is the layers' business.
- I5. The sender can cancel input still waiting in a mailbox (Observation `InputCancelled`); it is
  withdrawn. Cancelling input already taken changes nothing.
- I6. A turn that ends other than by an answer (`Failed`, `Vetoed`, `Interrupted`) drops the input
  still waiting (Decision `InputDropped`). No turn is under way until the next input arrives.
  (Dan: "There is no 'next turn', until stimulus is received.")
- I7. A response that is whole, has no tool calls, and that its provider marks as not the end of
  the model's turn (`Unfinished`: Anthropic's `pause_turn`) is followed by another request at
  once. Whether a response that reads as unfinished, with no such mark, is followed up is a
  judgement for the layers around the core.

## Tool calls

- TC1. A tool call is three facts: the model asked for it (`ToolCallArrived` while its response is
  still arriving, or as a part of `ModelResponded`), the tool began to run (`ToolCallDispatched`),
  and how it ended (`ToolEnded`). A call may have the first without the second, and the second
  without the third.
- TC2. A call that arrives while the response streams is run at once, without waiting for the rest
  of the response; the response, when it is recorded, holds the call as one of its parts and does
  not run it again. The calls of one response run at the same time.
- TC3. Every call a recorded response made has a result when the model is next sent the
  conversation: the one recorded; for a call with none, that how it ended was not observed
  (`Indeterminate`) when it began to run, and that it was not run (`NotRun`) when it did not. The
  result follows the response that made the call, whenever the tool ended.
- TC4. A call that arrived in a response that then failed is recorded, with its dispatch and its
  end. The response is not, so the model is not sent the call or its result.

## Interruption

- X1. Interrupted while a step is under way, the turn asks for its work to stop (`StopTurnWork`)
  and waits to hear how far each request got: a model request reports the response as far as it
  had arrived, with the parts that were complete (`ModelResponded`, ending `Interrupted`); a tool
  that was running, that how it ended was not observed; a call not yet run, that it was not. The
  turn then ends (`Interrupted`). It ends on a step's boundary, so the conversation goes on from it.
- X2. Interrupted between steps, the turn ends at once.
- X3. Input that arrives while the turn waits is dropped when it ends, as I6 says.
- X4. A session can go on from its facts, which are kept as given. Between turns the machines hold
  nothing, and what a request carries is read from the facts, so going on from facts that stop
  between turns is no different from starting the next turn. Facts may also stop while a turn
  runs: the process ended with requests made and no outcome recorded. Nobody is carrying those
  requests out, so the turn is interrupted and each is given what is known of it: no response was
  observed (`ModelResponded`, ending `Indeterminate`, holding the tool calls that had arrived), and
  how each call still running ended was not observed. The request is not made again. The turn
  ends as `Interrupted`, and the conversation goes on from it.

## What the model has seen

The model's response to a request is its observation of what the request carried, as a tool's
result is the harness's observation of the tool (Dan: the LLM "observes the tool result out loud and
then continues").

- S1. `AskModel { turn }` (the turn's first step, which carries its input) or
  `TellModel { turn, step }` (each later step, after what the step before came to) is recorded
  where the request is made: it is made from the facts before it, and the conversation view
  decides which of them are sent.
- S2. The model has seen a fact once it responds to a request that contained it. A request that
  fails leaves what it carried unseen. Working out what is unseen belongs to whatever reads the
  facts for a purpose (the next request, a person's display, a protocol).
- S3. `ModelFailed` means the request failed after whatever the layers around the core do first:
  retries with back-off, another model or provider. The turn ends, and no turn is under way until
  the next input. That turn's first request carries the input and everything still unseen. It
  carries the error as the layer encoded it (`error`), beside the words (`failure`). An attempt
  that failed on the way, after which the request went on, is `ModelAttemptFailed`; it is recorded
  when it happens, and the turn does not end.
- S6. A request for a model response is three facts, as a tool call is: the core asked
  (`AskModel` or `TellModel`), the request was made (`ModelRequestDispatched`, naming the provider and model it
  went to and holding what it carried: the system prompt, the tools and the conversation; once
  for each provider tried), and what came of it. The decision holds only the turn and step: what a request
  carries is not decided by the core, and is on record in the fact that the request was made. A request that was made and has no
  outcome recorded is indeterminate: whether the model saw what it carried is not known.
- S4. A compaction window is reported by the layers around the core, as the span they chose:
  `CompactionWindow { window, decidedBy, previous, through, kept }`, where `decidedBy` names what
  decided the compaction was due. It goes to the agent like input: taken at
  once while no turn runs, otherwise waiting in the turn's mailbox until between steps, or until the
  turn ends. Taking it records `WindowOpened`. The core records the marker and nothing more: what a
  request carries in a window is the layers' business, and a summary is not a fact of the session.
- S5. A notice (timely context, such as the current time) is decided on by the layers around the
  core, which report it as `NoticeInserted { turn, text }` while they make the request that carries
  it. Every later request carries it in the same place: a provider that binds thinking to what came
  before it rejects a request that leaves out a notice sent earlier. Notices are disposable content:
  a compaction may drop them.

## The model and its settings

- M1. A session asks the model its opening names, until a change of model is taken
  (`ModelChangeArrived`, which goes to the agent like input and is taken at once while no turn
  runs, between steps of a turn that does, or when the turn ends: `ModelChangeTaken`). A session
  loaded from its record asks the model it last changed to. A fallback chain is built on this:
  when another provider answers, it reports the change.
- M2. How a model is to process requests is said in the core's own terms: `thinking` (auto,
  before_answer, between_tools, off), `observe` (all, progress_only, off), `effort` (low to max)
  and `maxOutputTokens`. Each is optional, said in the opening or in a change of model, and stays
  as last said. One left unsaid is left to the provider.
- M3. Where a model does not allow what was said, the provider's adapter sends the nearest thing it
  allows and reports `SettingAdjusted` on the first request. From then on what was used is the
  session's setting for that model, so nothing more is adjusted. What was said stands for any
  other model, and saying a setting again puts the adjustment aside. A setting is adjusted so that
  the request can go on. Enforcing is something else: a request the harness or an extension
  refuses is vetoed (`ModelVetoed`).

## What is passed on and not recorded

- V1. While a response arrives, each stream event as received (`ModelStreamed`) and each part of
  the response once it is complete (`ModelPartArrived`) are passed on to whoever follows the
  session. Neither is recorded: the response is recorded whole when the stream ends, with the
  parts that were completed. A part still arriving when the response was cut short or stopped is
  not part of it.
- V2. `throttle.ts` is a machine that holds what is passed on and releases it in batches, at most
  once per interval; time is an input, so it reads no clock.
