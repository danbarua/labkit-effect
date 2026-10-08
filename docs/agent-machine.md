# agent-machine

`src/agent-machine` is the core: pure state machines for a session. Inputs arrive, turns run, the
model is asked, tools are called. The core records what it observes and what it decides, and sends
requests for effects. It does not carry the effects out, and it does not decide whether they
happen; the layers around it (`agent-session`, the hosts) do both.

Direction that is not built is in [agent-machine-direction.md](agent-machine-direction.md).

## Terms

| Term | Definition |
| --- | --- |
| Observation | Dan: "a Fact that's out of our sphere of influence." Something that reached the harness from outside, which the harness did not choose: an input, model output, a tool's outcome, a policy's veto. It is recorded with its origin. |
| Decision | A choice that the core makes, computed by its machines from the facts. |
| Effect | An action on the outside world. The core sends a request for it as a message; an adapter carries it out. Its result reaches the core as an observation. |
| Fact | A recorded observation or a recorded decision, at its position in the session (`seq`), with the time it was recorded. |
| Event | Not a term of the code. Dan uses it for an observation arriving and for a message the harness sends; in the code, the first is an observation and the second an effect request. |

## Files

| File | Responsibility |
| --- | --- |
| `observation.ts`, `decision.ts`, `request.ts`, `fact.ts` | The schemas of observations, decisions, effect requests and facts. |
| `origin.ts` | Who or what reported an observation. |
| `received.ts` | `Received`: content from outside, unparsed. |
| `names.ts` | Branded strings for every kind of name and id. |
| `blob.ts` | `BlobRef`: a reference to bytes kept outside the facts. |
| `settings.ts` | A model's settings in the core's terms. |
| `table.ts` | A machine as a transition table. |
| `agent.ts`, `conversation-turn.ts`, `turn-step.ts`, `call.ts` | The four machines. |
| `messages.ts` | The messages that machines send each other. These are not facts. |
| `router.ts` | `deliver`: routes an observation to its machine, and the messages that follow, until none are left. |
| `throttle.ts` | A machine that releases captured observations in batches. |
| `left-running.ts`, `not-observed.ts` | What facts that stop while a turn runs leave under way, and the outcomes to record for it. |
| `turn-requests.ts` | `requestsIn`: how many model requests a turn has made. |

## Content from outside

Content from outside the harness (a tool's input or output, a provider's metadata, a policy's
reason, a part of a response that the adapter does not recognise) is carried as `Received`: its
media type, and its body as text or bytes, unparsed. The core does not look inside it. An adapter
that needs the contents parses them, and handles and logs a parse that fails.

Every observation is recorded with its origin: who or what outside the core reported it (a user
through some surface, another session, a provider, a tool, a part of the harness, a test). A
decision has no origin, because it is the core's own. Giving a session an observation with no origin
is a defect.

## Machines

The core is four kinds of machine in a tree:

| Machine | One per | Handles |
| --- | --- | --- |
| agent | session | input while no turn runs, turn starts, compaction windows and model changes between turns |
| conversation turn | turn | the steps of a turn, input during the turn, the end of the turn |
| turn step | model request | the request, its response, and the tool calls it makes |
| call | tool call | permission, dispatch and the end of one call |

- Each machine is a table from (state kind, message kind) to a transition, "ignored" or "deferred".
  Whether a message is acted on depends on the two kinds alone.
- Every machine has a mailbox. A deferred message waits there and is tried again after the
  machine's next transition.
- The router delivers an observation to the machine its fields address. An observation that a
  machine ignores is recorded as `ObservationNotExpected`; one addressed to a turn or a call that no
  machine exists for is recorded as `ObservationUndelivered`.
- `McpServerChanged` is recorded for the session's record and its host. `FolderAdded` is recorded
  for the permission policy, which counts the folder as inside the working folder, and for the
  model, which is told of the folder where it was added (`conversation.ts`). No machine acts on
  either, nothing follows from them, and neither is recorded as `ObservationNotExpected`.
- Every `switch` in the core ends in `satisfies never`, so a new kind of observation, decision or
  request does not compile until every machine handles it.

## Decisions and effects

Every effect that the core requests follows one pattern: a decision is recorded, an effect request is
sent, and the outcome is observed. When a turn starts is not one of them: the layers around the core
decide it and report `TurnStarted`.

| Decision | Request | Observed outcome |
| --- | --- | --- |
| `AskModel` (a turn's first step), `TellModel` (each later step) | `RequestModelResponse` | `ModelRequestDispatched` when the request is made, then `ModelResponded`, `ModelFailed` or `ModelVetoed` |
| none: every proposed call is requested | `RunTool` | `PermissionAsked` and `PermissionAnswered` when a policy asks first, `ToolCallDispatched` when the tool begins to run, then `ToolEnded` (`Succeeded` or `Failed`) |
| none: the model gave a response with no tool calls | `BeforeTurnEnded` | input, if any, then `TurnEndReviewed` |
| none: the turn was interrupted | `StopTurnWork` | each request under way reports how far it got |

Whether a requested effect happens is decided outside the core. The core sees a veto as an outcome:
a vetoed tool call settles like any other, and the model is asked again; a vetoed model request ends
the turn.

A tool call succeeds or fails. `Failed` carries the reason (`Reported`, `NotFound`, `InputRejected`,
`Vetoed`, `Indeterminate`, `NotRun`) for code that cares; code that needs only success or failure
matches on the two cases.

## Input

Dan: "The world isn't sealed while the agent thinks, skeddadles, makes 20 tool calls."

- Input arrives from the user, the system (a wake-up, a scheduled prompt), or another agent, at any
  time.
- Input that arrives while no turn runs waits in the agent's mailbox. When the layers around the
  core start a turn (`TurnStarted`), the turn takes every waiting input (`InputDelivered`, one per
  input).
- Input that arrives while a turn runs waits in the turn's mailbox and is taken between steps: when
  every call of a tool batch has settled, or when the model gives a response with no tool calls. The
  model is then asked again.
- The sender can cancel input that is still waiting in a mailbox (`InputCancelled`); it is withdrawn.
  Cancelling input already taken changes nothing.

## The end of a turn

After a response with no tool calls, the turn asks the layers around the core for anything more
(`BeforeTurnEnded`; a Stop hook's feedback, for example, arrives as input), and they answer with
`TurnEndReviewed`.

- Before that request, a whole response with answer text is recorded as `TurnCompleted`, and one
  with none (only thinking or commentary) as `TurnIncomplete`.
- When no input was taken by the time of `TurnEndReviewed`, the turn ends (`TurnEnded`: `Completed`,
  `Incomplete` or `CutShort`). Otherwise it continues with another step.
- A response cut short is not followed by another request unless input gives the model something
  new to answer.
- Whether an incomplete turn is held open is a turn-end hook's decision, and how often hooks may hold
  a turn open is the layers' business.
- A whole response with no tool calls that its provider marks as not the end of the model's turn
  (`Unfinished`: Anthropic's `pause_turn`) is followed by another request at once. Whether a
  response that reads as unfinished, with no such mark, is followed up is for the layers around the
  core to judge.
- A turn that ends other than with an answer (`Failed`, `Vetoed`, `Interrupted`) drops the input
  still waiting (`InputDropped`). No turn is under way until the next input arrives. Dan: "There is
  no 'next turn', until stimulus is received."

## Tool calls

- A tool call is three facts: the model asked for it (`ToolCallArrived` while its response is still
  arriving, or as a part of `ModelResponded`), the tool began to run (`ToolCallDispatched`), and how
  it ended (`ToolEnded`). A call can have the first without the second, and the second without the
  third.
- A call that succeeded records its output, the text the model is sent, and, when its tool gives
  them, the details of what it did (`ToolDetail`), which the model is never sent. `FileChanged` is
  a text file created, with its whole text, or updated, with a unified diff of the change. A patch
  over 32 KiB is cut at the end of a line, and the bytes left out are recorded with it (`cut`). A
  failed call records no details.
- A call that arrives while the response streams runs at once, without waiting for the rest of the
  response. When the response is recorded, it holds the call as one of its parts and does not run it
  again. The calls of one response run at the same time.
- Every call that a recorded response made has a result when the model is next sent the
  conversation: the one recorded; for a call with none, `Indeterminate` when it began to run and
  `NotRun` when it did not. The result follows the response that made the call, whenever the tool
  ended.
- A call that arrived in a response that then failed is recorded, with its dispatch and its end.
  The response is not recorded, so the model is not sent the call or its result.
- A call belongs to the turn that started it. A step finishes only when every call it opened has
  settled, whatever became of its model request, so a turn whose request failed or was vetoed ends
  after its calls' ends are recorded.

## Interruption

- Interrupted while a step is under way, the turn asks for its work to stop (`StopTurnWork`) and
  waits to hear how far each request got: a model request reports the response as far as it had
  arrived, with the complete parts (`ModelResponded`, ending `Interrupted`); a tool that was running
  reports that its end was not observed; a call not yet run reports that it was not. The turn then
  ends `Interrupted`, on a step's boundary, so the conversation continues from it.
- Interrupted during the turn-end review (`BeforeTurnEnded`), the turn asks for the review to stop
  (`StopTurnWork`) and waits for it to report (`TurnEndReviewed`). The layers around the core stop
  the turn-end hooks and report at once, without the hooks' feedback. The turn then ends
  `Interrupted`, and the model is not asked again, even when input was taken during the review.
- An interruption records the user's intent. The turn ends once what was under way for it has
  reported.
- Input that arrives while the turn waits is dropped when it ends. A compaction window or a change of
  model that arrives while the turn waits is taken when it ends.

## Continuing from facts

A session can continue from its facts, which are kept as given.

- Between turns the machines hold nothing, and every request reads what it carries from the facts,
  so continuing from facts that stop between turns is the same as starting the next turn.
- A session continued from its facts builds its machines from the facts after the last turn's end
  only (`worldAndRequestsOf`). It has no machine for a turn, or a call, of a turn that ended
  before. An observation addressed to one is recorded differently:
  - in a session continued from its facts: `ObservationUndelivered`;
  - in a session that was not: `ObservationNotExpected` for a turn's observation, and no decision
    for a call's `ToolEnded`, which the call's machine still takes.
- Every request a turn makes has its outcome recorded before the turn ends, so such an observation
  comes only from a fault, such as a response reported twice.
- Facts can also stop while a turn runs: the process ended with requests made and no outcome
  recorded (`leftRunning` lists them). Whoever continues from the facts decides what becomes of the
  turn:
  - **End it.** The turn is interrupted, and each request under way receives what is known of it: a
    model request gets `ModelResponded` with ending `Indeterminate`, holding the tool calls that had
    arrived; a call that began gets an end that was not observed; a call that had not begun was not
    run; a turn-end review gets `TurnEndReviewed`, with no input from the hooks. No request is made
    again. The turn ends `Interrupted`, and the conversation continues from
    it.
  - **Continue it.** Each request with no outcome is carried out. A model request is made again. A
    tool call runs again only when its tool's `replay` is `safe` (it changes nothing), and is asked
    about again if it was waiting for an answer. Any other call, `idempotent` included, is not run:
    it ends `Indeterminate` if it had begun and `NotRun` if it had not, because what it would change
    may have changed since; the model looks before it asks again. A turn that was being interrupted
    receives what is known of each request, as when ending it, and ends.

## What the model has seen

The model's response to a request is its observation of what the request carried, as a tool's result
is the harness's observation of the tool (Dan: the LLM "observes the tool result out loud and then
continues").

- A request for a model response is three facts, as a tool call is: the core asked (`AskModel` or
  `TellModel`, holding only the turn and step), the request was made (`ModelRequestDispatched`,
  naming the provider and model and holding what it carried: the system prompt, the tools and the
  conversation; once for each provider tried), and what came of it. The core does not decide what a
  request carries; the record of what it carried is the dispatch fact.
- The decision is recorded where the request is made: the request is made from the facts before it,
  and the conversation view decides which of them are sent.
- The model has seen a fact once it responds to a request that contained it. A request that fails
  leaves what it carried unseen. A request that was made and has no recorded outcome is
  indeterminate: whether the model saw what it carried is not known. Working out what is unseen
  belongs to whatever reads the facts for a purpose (the next request, a display, a protocol).
- `ModelFailed` means that the request failed after whatever the layers around the core do first:
  retries with back-off, another model or provider. The turn ends, and no turn is under way until the
  next input; that turn's first request carries the input and everything still unseen. `ModelFailed`
  carries the error as the layer encoded it (`error`) beside the words (`failure`). An attempt that
  failed and after which the request went on is `ModelAttemptFailed`, recorded when it happens; the
  turn does not end.
- A compaction window is reported by the layers around the core, as the span they chose:
  `CompactionWindow { window, decidedBy, previous, through, kept }`, where `decidedBy` names what
  decided the compaction was due. It goes to the agent like input: taken at once while no turn runs,
  otherwise waiting in the turn's mailbox until between steps or until the turn ends. Taking it
  records `WindowOpened`. The core records the marker and nothing more: what a request carries in a
  window is the layers' business, and a summary is not a fact of the session.
- A notice (timely context, such as the current time) is decided on by the layers around the core,
  which record it as `NoticeInserted { turn, text }` while they make the request that carries it.
  Every later request carries it in the same place, because a provider that binds thinking to what
  came before it rejects a request that omits a notice sent earlier. A compaction may drop notices.

## The model and its settings

- A session asks the model that its opening names, until a change of model is taken.
  `ModelChangeArrived` goes to the agent like input and is taken (`ModelChangeTaken`) at once while
  no turn runs, between the steps of a turn that does, or when the turn ends. A session loaded from
  its record asks the model it last changed to.
- A fallback chain is built on this: when another provider answers, it reports the change, which the
  core takes between steps so that the turn can complete. A user's change is observed only between
  turns, when the configuration gate (`agent-session/configuration/gate.ts`) decides.
- A model's settings are given in the core's own terms (`settings.ts`):

  | Setting | Values |
  | --- | --- |
  | `thinking` | `disabled`, `between_tools` |
  | `observe` | `all`, `progress_only`, `off` |
  | `effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
  | `maxOutputTokens` | a number of tokens |
  | `cache` | `off`, `5m`, `1h` |

  Each is optional, given in the opening or in a change of model (`SettingsChange`), and keeps its
  last value. A setting that is not given is left to the provider. A change that gives a setting as
  `default` removes it, so the provider's default applies again.
- A setting is the intent of whoever set it, a person or a policy, and a change of model carries
  the settings over. Where a model does not take a value, the provider's adapter sends the nearest
  value it takes, or nothing, and reports `SettingAdjusted` on the first request. From then on the
  value used is the session's setting for that model, so nothing more is adjusted. For any other
  model the value given still applies, and giving the setting again discards the adjustment. An
  adjustment lets the request go on; a request that the harness or an extension refuses is vetoed
  instead (`ModelVetoed`).

## What is passed on and not recorded

- While a response arrives, each stream event as received (`ModelStreamed`) and each part of the
  response once it is complete (`ModelPartArrived`) are passed on to whoever follows the session.
  Neither is recorded: the response is recorded whole when the stream ends, with the complete
  parts. A part still arriving when the response was cut short or stopped is not part of it.
- The text that each stream event adds to an answer, to commentary, or to the readable text of
  thinking is passed on as it arrives (`ModelDelta`, with the kind of part). A part's deltas, joined,
  are its text, and are passed on before its `ModelPartArrived`. A response that arrives whole, a
  part with no readable text, and a tool call have no deltas. A delta that adds no text is not
  passed on.
- The end of a model request is passed on last, after everything it streamed
  (`ModelResponseEnded`), however it ended: answered, failed or stopped.
- `throttle.ts` is a machine that holds what is passed on and releases it in batches, at most once
  per interval. Time is an input, so the machine reads no clock. The loop sets the interval
  (`ModelStreamInterval`), and releases everything held when a part completes and when the request
  ends, whether or not the interval has passed.

## Tests

- `rules.test.ts`, `turn.test.ts`, `queued-input.test.ts`, `interrupted.test.ts`,
  `model-change.test.ts`, `seen.test.ts`, `compaction-window-marker.test.ts`,
  `recorded-only.test.ts`, `throttle.test.ts`: the machines, driven by `tests/support/drive.ts`.
- `src/agent-session`: the loop's side of the same behaviour. `go-on.test.ts` and `resume.test.ts`
  cover continuing from facts; `providers/streaming.test.ts` and `providers/deltas.test.ts` cover
  what is passed on while a response arrives; `configuration/settings.test.ts` covers settings.
