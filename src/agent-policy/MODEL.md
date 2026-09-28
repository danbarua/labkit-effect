# agent-policy

Whether an effect the core requests happens. Dan: "something might execute a decision to continue,
veto or delay an Effect." How a policy decides (permissions, parsing a command, a model's judgement,
asking a person) is the policy's business.

It reads the core's effect requests and produces the core's observations. The core does not know
it exists.

## Rules

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
  held, and what the policy asks is passed on.

## Examples

The policies in `tests/policy.test.ts` are examples, not part of this layer: a deny list of tool
names, asking a person, and holding model requests until a time.
