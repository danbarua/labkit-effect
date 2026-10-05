# agent-policy

`src/agent-policy` defines policies. A policy decides whether an effect request from the core
continues, is vetoed, or waits. The effect requests that policies review are tool calls (`RunTool`)
and model requests (`RequestModelResponse`). The loop in `agent-session` applies a session's
policies before it carries out each request. The core (`agent-machine`) does not know that policies
exist: it receives a veto as an observation, like any other outcome.

## Files

| File | Responsibility |
| --- | --- |
| `policy.ts` | The `Policy` interface and `every`, which applies several policies in order. |
| `permissions.ts` | The permission policy, by Claude Code's permission modes. |
| `loop-breaker.ts` | `repeatedCalls` and `repeatingTurns`: they stop a model that makes the same tool call again and again. |
| `max-turn-requests.ts` | `maxTurnRequests`: a limit on the number of model requests in one turn (ACP's `max_turn_requests`). |

## Policies

A policy is a state machine for one request.

- `start(request)` returns `Decided` with a verdict, or `Waiting`.
- A verdict is `Continue` or `Veto { reason }`.
- `Waiting` can carry `asks`: what the policy wants answered. The layer that shows the question to
  a person interprets it.
- `receive(state, message)` handles a message while the policy waits: an answer (`Answered`) or a
  clock tick (`Tick`). It returns a verdict, or waits again. Waiting is how a policy delays an
  effect.

A policy can decide by any means: fixed rules, parsing a command, a model's judgement, or asking a
person.

`every(policies)` applies policies in order:

- The first veto is the verdict. The verdict's `by` field is the position of the policy that vetoed.
- A policy that waits holds the policies after it until it decides.
- The request continues when every policy lets it continue.

## Permissions

`permissions(mode, canAsk, kindOf, facts)` decides by the tool's kind (`kindOf`) and the permission
mode. A tool whose kind is not known is treated as `other`.

| Mode | Tool that only reads (`read`, `search`, `think`, `fetch`) | Tool that changes files (`edit`, `delete`, `move`) | Any other tool |
| --- | --- | --- | --- |
| `default` | runs | asks | asks |
| `acceptEdits` | runs | runs | asks |
| `dontAsk` | runs | vetoed | vetoed |
| `bypassPermissions` | runs | runs | runs |

When the policy asks, it offers four options:

| Option id | ACP kind | Effect |
| --- | --- | --- |
| `allow-once` | `allow_once` | This call runs. |
| `allow-session` | `allow_always` | This call runs. Later calls to the tool run without a question, in every mode. |
| `reject-once` | `reject_once` | This call is vetoed. |
| `reject-session` | `reject_always` | This call is vetoed. Later calls to the tool are vetoed without a question, in every mode, `bypassPermissions` included. |

An answer that names no offered option vetoes the call.

The policy reads session answers from the session's facts (`PermissionAsked`, `PermissionAnswered`).
A process that resumes the session from its facts therefore applies the same answers.

When no one can answer (`canAsk` is false, as in the CLI's print mode), a call that would be asked
about is vetoed. The veto's reason names the permission modes that let the call run:
`acceptEdits or bypassPermissions` for a tool that changes files, and `bypassPermissions` for any
other tool.

## Loop breaker

| Setting | Default | Meaning |
| --- | --- | --- |
| `nudgeAt` | 3 | The identical call in a row that `repeatedCalls` vetoes, and each one after it. |
| `stopAt` | 5 | The number of identical calls in a row after which `repeatingTurns` vetoes the turn's next model request. |
| `key` | `sameToolAndInput` | Two calls are identical when their keys are equal. The default key is the tool and the input as received. |

- `repeatedCalls` is a tool call policy. Its veto reason, which the model receives as the call's
  result, states how many identical calls were made in a row, and that the turn ends after `stopAt`.
- `repeatingTurns` is a model request policy. Its veto ends the turn as `Vetoed`.
- Calls are in a row when they are in the same turn and no other call of that turn came between
  them. Calls are ordered by when each was first recorded: as it arrived (`ToolCallArrived`), or in
  its response (`ModelResponded`), in the response's order.
- A call recorded twice counts once. When a later turn reuses a call id, the id refers to the later
  call.
- Both policies count from the session's facts, so a resumed session counts the same calls. The
  calls of one response are all recorded before any of them is reviewed; each call is counted by
  its position, not by how many identical calls the facts hold when it is reviewed.

## Turn request limit

`maxTurnRequests(facts, limit)` vetoes a turn's model request beyond the `limit`-th. The default
limit is 1000. The policy counts the turn's `AskModel` and `TellModel` decisions (`requestsIn` in
`agent-machine`). The decision for a request is recorded before the request is reviewed, so the
count includes the request under review.

The veto's reason is the JSON `{ "stop": "max_turn_requests", "limit": <limit> }`. The ACP host
reports it as the stop reason `max_turn_requests`.

The default is about two and a half times the most requests that one real turn made in the
sessions in `trajectories/` (392 requests over an hour, among 7,456 turns of Claude Code and Codex).
It stops a turn that runs away and no turn that works.

## How the loop applies policies

A host composes two lists of named policies (`NamedPolicy`): `ToolCallPolicies` and
`ModelRequestPolicies`. The loop (`agent-session/loop.ts`) applies each list with `every`, as the
facts stand when the request is reviewed.

Tool calls are reviewed before they run:

- While the policies wait, the loop records each question as `PermissionAsked`, with the origin
  `tool call policy <name>`. It gives the policies the next `PermissionAnswered` recorded for the
  call.
- A vetoed call ends `Failed { Vetoed { reason } }` and never starts. The model receives the reason
  as the call's result.
- A call that is still waiting for an answer when its turn stops, or when the process ends, ends
  `Failed { NotRun }`.
- A tool call policy that waits without asking anything is a defect, because nothing would answer
  it.

Model requests are reviewed before a model is chosen for them:

- A vetoed request is not made. The loop records `ModelVetoed`, and the turn ends `Vetoed`.
- A request that a policy holds is not made either. Nothing can wake a waiting model request policy
  yet, so the loop records `ModelFailed` with a message that tells the user to wait and try again,
  followed by what the policy asks. The loop logs `loop.model.held` as a warning.

Each decision is recorded with the deciding policy's name in its origin (`tool call policy <name>`,
`model request policy <name>`). Each veto is logged with that name (`loop.tool.vetoed`,
`loop.model.vetoed`).

## Design decisions

- **Policies read facts.** A policy's verdict depends only on the request, the session's facts and
  the messages it receives. A session resumed from its facts therefore gets the same verdicts.
- **A veto is an observation.** The core has two observations for a veto: `ModelVetoed`, which ends
  the turn as `Vetoed`, and `ToolEnded` with `Failed { Vetoed }`, which settles the call like any
  other outcome. The Claude Code importer (`scripts/trajectories/claude-code.ts`) also records
  `ModelVetoed` where Claude Code wrote "No response requested." in a running turn.
- **Model settings are adjusted, not vetoed.** When a model does not accept a setting, the
  provider's adapter changes the setting to the nearest one that the model accepts and records
  `SettingAdjusted`. That is an adjustment, not a policy's verdict.

## Tests

- `src/agent-policy`: `permissions.test.ts`, `loop-breaker.test.ts`, `max-turn-requests.test.ts`.
- `src/agent-session`: how the loop applies policies (`permission.test.ts`,
  `model-request-policy.test.ts`, `loop-breaker.test.ts`, `resume.test.ts`).
- `tests/examples/policies.test.ts`: `every`, waiting, answers and clock ticks, with the example
  policies in `src/examples/policies.ts`.
