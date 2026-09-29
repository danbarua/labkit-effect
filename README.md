# labkit-effect

The domain core of a coding harness, and the layers around it.

## Constraints (Dan, verbatim)

- C1. Pure state machines.
- C2. Message passing only.
- C3. Build in the abstract. No concrete implementations.
- C4. Facts, Decisions, Effects, Observations.
- C5. No unbranded strings.
- C6. Everything written down - code or prose - says exactly what it means and nothing else.
- C7. Behaviours: implementation details. Those are the layer *around* the core. Contracts. Adapters.

## Layout

| Directory | What it is | May import |
|---|---|---|
| `src/agent-core/` | Machines with mailboxes that pass messages (agent, conversation turn, turn step, call), the router, and the facts, decisions and effect requests they record. See its `MODEL.md`. | `Schema` from `effect` |
| `src/agent-policy/` | Whether an effect request continues, is vetoed, or waits. See its `MODEL.md`. | `Schema` from `effect`, `agent-core` |
| `src/agent-effect/` | The layer around them: contracts as Effect services, adapters, the loop (which records every fact, and so owns the journal). | anything |
| `src/agent-context/` | Context assembly: what the model is sent, from system prompts, tool catalogs and a view of the conversation. See its `MODEL.md`. | anything |
| `src/instrumentation/` | Tool usage counted from facts, as Effect metrics, and OpenTelemetry. | anything |
| `src/examples/fizzbuzz` | A synthetic scenario for testing the rest: a scripted model, its tools, a toy compaction. | anything |
| `scripts/trajectories/` | Importers that replay Claude Code and Codex sessions through the core into `trajectories/` (not committed). | anything |

In the first two, `bun run lint` (oxlint, with Effect's recommended preset and the rules in
`scripts/oxlint/abstract-layers.js`) enforces their imports and pure functions (no `let`, no loops,
no call that changes a value in place), and refuses the `string` type and an unbranded
`Schema.String`. `bun run check:brands` asks the TypeScript checker that every schema there decodes
to a type with no unbranded string, however it is built.

## Commands

```sh
bun install
bun run check       # typecheck, lint, check:brands, tests
```
