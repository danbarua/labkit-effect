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
| `src/agent-machine/` | Machines with mailboxes that pass messages (agent, conversation turn, turn step, call), the router, and the facts, decisions and effect requests they record. See its `MODEL.md`. | `Schema` from `effect` |
| `src/agent-policy/` | Whether an effect request continues, is vetoed, or waits. See its `MODEL.md`. | `Schema` from `effect`, `agent-machine` |
| `src/agent-session/` | The layer around them: contracts as Effect services, adapters, the loop (which records every fact, and so owns the journal). | anything |
| `src/agent-context/` | Context assembly: what the model is sent, from system prompts, tool catalogs and a view of the conversation. See its `MODEL.md`. | anything |
| `src/instrumentation/` | Tool usage counted from facts, as Effect metrics, and OpenTelemetry. See its `README.md`. | anything |
| `src/acp/` | The Agent Client Protocol in Effect: schemas generated from the official SDK's JSON Schemas, a two-way JSON-RPC peer, the stdio and Streamable HTTP wires, and version and capability negotiation. Its tests drive it with the official SDK. See its `MODEL.md`. | anything but `@agentclientprotocol/sdk`, which only its tests import |
| `src/agent-host/` | What both hosts share, lifted from the CLI: the model catalog, the provider clients, the services a session runs with, the permission policy for a mode, the folder sessions are kept in, and log files. See its `MODEL.md`, and `DESIGN.next.md` for where the hosts are going. | the core; never `src/acp` or a host |
| `src/agent-acp/` | The ACP host: joins `src/acp` to a session of the core. Built: the pure projection of a session's facts and deltas to `session/update`. See its `MODEL.md`, and `src/agent-host/DESIGN.next.md` for the layers. | anything |
| `src/examples/` | Examples, not part of the harness: the FizzBuzz session (a scripted model, its tools, a toy compaction) and example policies. | anything |
| `scripts/probes/` | Live checks against the providers' APIs. Each reads its key from the environment and writes what it saw to a folder per run, `logs/probes/<probe>/<run>/` (not committed). | anything |
| `scripts/trajectories/` | Importers that project Claude Code and Codex sessions' records through the core's decisions into `trajectories/` (not committed). | anything |

Each module's `MODEL.md` says what it builds, as rules with ids. A rule has at least one test whose
name starts with its id, and `bun run check:rules` fails when one has none. `DESIGN.next.md`, where
a module has one, holds direction that is not built. `TODO.md` is what is to be built.

A module's tests are beside its code (`src/agent-machine/turn.test.ts`). The core's tests import only
the core and `tests/support/`. `tests/` holds what joins modules: `tests/examples/` tests the
examples, `tests/telemetry.test.ts` the instrumentation through one, and `tests/support/` what
tests share (a driver for the core's machines, stand-ins for a provider, the test runner).

In the first two, `bun run lint` (oxlint, with Effect's recommended preset and the rules in
`scripts/oxlint/abstract-layers.js`) enforces their imports and pure functions, in everything but
their tests (no `let`, no loops,
no call that changes a value in place), and refuses the `string` type and an unbranded
`Schema.String`. `bun run check:brands` asks the TypeScript checker that every schema there decodes
to a type with no unbranded string, however it is built.

## Commands

```sh
bun install
bun run vidaimock:install   # the mock provider server the adapter tests run against
bun run check               # installs it if missing, then typecheck, lint, check:brands, check:rules, tests
bun scripts/trajectories/sweep.ts codex         # run both sweeps after changing a core machine, and
bun scripts/trajectories/sweep.ts claude-code   # read the counts of observations not expected
```

The adapter tests start [VidaiMock](https://github.com/vidaiUK/VidaiMock), a server that answers as
the providers' APIs do. `scripts/vidaimock.ts` downloads the pinned release for this platform into
`.tools/`, refusing an archive whose SHA-256 differs from the one it holds.
