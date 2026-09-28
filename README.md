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
| `src/agent-core/` | The session: facts, decisions, effect requests, the machine, the view. See its `MODEL.md`. | `Schema` from `effect` |
| `src/agent-policy/` | Whether an effect request continues, is vetoed, or waits. See its `MODEL.md`. | `Schema` from `effect`, `agent-core` |
| `src/agent-effect/` | The layer around them: contracts as Effect services, adapters, the loop. | anything |

`bun run check:core` enforces the imports of the first two and C5.

## Commands

```sh
bun install
bun run check       # typecheck, check:core, tests
```
