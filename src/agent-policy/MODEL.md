# agent-policy

The place between the core's effect requests and the adapters that carry them out where a request
can be allowed, refused or held. Permissions, budgets and rate limits are built here. A policy reads
one of the core's effect requests and gives a verdict; the loop records a veto as the core's
observation for it. The core does not know policies exist.

Dan: "something might execute a decision to continue, veto or delay an Effect." How a policy decides
(permissions, parsing a command, a model's judgement, asking a person) is the policy's business.

## What is built

- `policy.ts`: what a policy is (a machine per request) and `every`, which applies several in order.
- `permissions.ts`: permission to run a tool call, by Claude Code's permission modes (`default`,
  `acceptEdits`, `dontAsk`, `bypassPermissions`), from each tool's kind. What it asks offers ACP's
  options: allow once, allow the tool for the rest of the session, reject.
- `loop-breaker.ts`: a model that makes the same call again and again in a row is told so, then
  stopped: one policy on tool calls, one on model requests.
- In the loop (`agent-session/loop.ts`): each tool call goes through the session's tool call
  policies (`ToolCallPolicies`) before it runs, and each model request through its model request
  policies (`ModelRequestPolicies`) before it is made. A host composes each list.

## What is not built

- Waking a model request policy that waits: that needs background jobs and watchdogs, which the
  runtime does not have. Until then a held request fails, telling the user to wait (P9).
- Claude Code's `plan` and `auto` modes; allow and deny rules by tool and argument
  (`--allowedTools`, `--disallowedTools`).

## What a veto is, elsewhere in the code

- The core's two observations for a veto exist and are handled: `ModelVetoed { turn, reason }` ends
  the turn as `Vetoed`; `ToolEnded` with `Failed { Vetoed { reason } }` settles the call like any
  other outcome, and the model is asked again with the reason as the call's result. The Claude Code
  importer also records `ModelVetoed`, where Claude Code wrote "No response requested." in a running
  turn.
- A model's settings are not vetoed. A setting the model does not allow is changed to the nearest
  one it does, and recorded (`SettingAdjusted`, agent-machine M3). That is an adjustment made by the
  provider's adapter, not a verdict.

## Rules

- P1. A policy is a machine per request. Given the request it gives a verdict, `Continue` or
  `Veto { reason }`, or waits. Given a message while waiting (an answer, a clock tick) it gives a
  verdict or waits again. Waiting is how a policy delays an effect.
- P2. A waiting policy can say what it wants answered (`asks`). The layer that shows it to someone
  interprets it.
- P3. `every([...])` applies policies in order. The first veto is the verdict; the request continues
  when every policy lets it continue.
- P5. A call to a tool that only reads (`read`, `search`, `think`, `fetch`) runs in every mode. A
  call to a tool that changes things, or whose kind is not known: `default` asks; `acceptEdits` runs
  one that edits, deletes or moves files and asks for others; `dontAsk` vetoes; `bypassPermissions`
  runs. Allowing (once, or for the session) lets the asked call run; rejecting vetoes it.
- P6. Allowing a tool for the session is an answer in the session's facts. A later call to that tool
  runs without being asked, in any mode, in this process or one that goes on from the facts.
- P7. Where no one can answer, what would be asked is vetoed, and the reason says how to let it run.
- P8. In the loop, a tool call the policy waits on records what it asks (`PermissionAsked`) and runs
  only once an answer is observed for the call (`PermissionAnswered`) and the policy lets it. A
  vetoed call ends `Vetoed` and never begins to run. A call waiting for an answer when its turn
  stops, or when the process ends and the session goes on from its facts, ends `NotRun`.
- P9. In the loop, each list of policies is applied in order, as `every`. A vetoed model request is
  not made: `ModelVetoed` is recorded, from the model request policy, and the turn ends `Vetoed`. A
  model request held by a policy that waits is not made either: `ModelFailed` is recorded, saying to
  wait and try again, with what the policy asks.
- P10. The loop breaker vetoes the `nudgeAt`-th identical call in a row (3 by default), and each
  after it, with a reason the model reads as the call's result; once a turn's last `stopAt` calls
  (5) are identical, it vetoes the turn's next model request. Calls are identical when `key` gives
  them the same key: by default, the same tool and the same input as received. Calls are in a row
  when no other call of their turn came between them, in the order they are first recorded: a call
  made again after others (running the tests, editing, running them again) starts the count again.
  A call is counted by its place in that order, so calls in one response reviewed together count as
  the model made them. Both count from the facts.
