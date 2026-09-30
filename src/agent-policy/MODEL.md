# agent-policy

The smallest of the modules. It shows that there is a place between the core's effect requests and
the adapters that carry them out where a request can be allowed, refused or held. Permissions,
budgets and rate limits would be built there. It reads the core's effect requests and produces the
core's observations; the core does not know it exists.

Dan: "something might execute a decision to continue, veto or delay an Effect." How a policy decides
(permissions, parsing a command, a model's judgement, asking a person) is the policy's business.

## What is built

- `policy.ts`: what a policy is (a machine per request) and `every`, which applies several in order.
- `gate.ts`: a machine that applies a policy to each request and gives what follows: the request
  forwarded, the core's observation for a veto, or what a waiting policy asks.
- Both are pure, and tested with the example policies in `src/examples/policies.ts`
  (`tests/examples/policies.test.ts`): a deny list of tool names, asking a person, holding model
  requests until a time, a spent budget.

## What is not built

- The gate is not in the loop. The loop carries out every request the core makes; nothing in it
  vetoes or holds one.
- No policy is part of this module. The four in `src/examples/policies.ts` are examples.

## What a veto is, elsewhere in the code

Whoever builds permissions starts from these:

- The core's two observations for a veto exist and are handled: `ModelVetoed { turn, reason }` ends
  the turn as `Vetoed`; `ToolEnded` with `Failed { Vetoed { reason } }` settles the call like any
  other outcome, and the model is asked again with the reason as the call's result.
- The gate is the only code that makes them from a policy's verdict. The Claude Code importer also
  records `ModelVetoed`, where Claude Code wrote "No response requested." in a running turn.
- A model's settings are not vetoed. A setting the model does not allow is changed to the nearest
  one it does, and recorded (`SettingEnforced`, agent-machine M3). That is an adjustment made by the
  provider's adapter, not a verdict.

## Rules

These say what the gate does, as the example policies exercise it. They are not a specification of
permissions.

- P1. A policy is a machine per request. Given the request it gives a verdict, `Continue` or
  `Veto { reason }`, or waits. Given a message while waiting (an answer, a clock tick) it gives a
  verdict or waits again. Waiting is how a policy delays an effect.
- P2. A waiting policy can say what it wants answered (`asks`). The layer that shows it to someone
  interprets it.
- P3. `every([...])` applies policies in order. The first veto is the verdict; the request continues
  when every policy lets it continue.
- P4. The gate applies a policy between the core's requests and the adapters that carry them out.
  `Continue` forwards the request. `Veto` becomes the core's observation for a veto: `ToolEnded`
  with `Vetoed`, or `ModelVetoed`, with the reason as the policy gave it. A waiting request is
  held, and what the policy asks is passed on. `BeforeTurnEnded` and `StopTurnWork` are forwarded
  without review.
