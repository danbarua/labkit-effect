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
| `src/agent-host/` | What both hosts share, lifted from the CLI: the model catalog, the provider clients, the services a session runs with, the permission policy for a mode, the folder sessions are kept in and a host's record of a session beside its facts, log files (and the ACP launcher's, JSONL, rotated), the draft a session is before turn zero, and a session's transcript as Markdown. See its `MODEL.md`, and `DESIGN.next.md` for where the hosts are going. | the core; never `effective-acp` or a host |
| `src/agent-acp/` | The ACP host, protocol v1 over stdio: `makeHost` joins `effective-acp` (the ACP protocol, a package of its own on npm: github.com/danbarua/effective-acp) to sessions of the core (a draft at `session/new`, turn zero at the first prompt), with tools through the editor's `fs/*`, permission, cancel, `usage_update`, `/export`, and `session/load`, `resume` and `list` over the sessions the directory keeps; the projection of a session's facts and the core's stream items to `session/update`; and the launcher, `bun src/agent-acp/main.ts`. See its `MODEL.md`, and `src/agent-host/DESIGN.next.md` for the layers. | anything |
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
bun run acp:logs [--errors]  # the newest ACP launch log (~/.labkit/logs; LABKIT_ACP_LOG_DIR, _LEVEL, _MAX_BYTES, _BACKUPS)
bun cli --help              # the CLI; --model, --permission-mode, --max-turns and its other shared options
                            # are read from LABKIT_MODEL, LABKIT_PERMISSION_MODE, ... when not given
bun scripts/trajectories/sweep.ts codex         # run both sweeps after changing a core machine, and
bun scripts/trajectories/sweep.ts claude-code   # read the counts of observations not expected
```

The adapter tests start [VidaiMock](https://github.com/vidaiUK/VidaiMock), a server that answers as
the providers' APIs do. `scripts/vidaimock.ts` downloads the pinned release for this platform into
`.tools/`, refusing an archive whose SHA-256 differs from the one it holds.

## The ACP agent

`bun src/agent-acp/main.ts` (`bun run acp:dev`) is the command an editor launches: protocol v1 on
stdin and stdout, a log file whose path it says once on stderr, exit 0 when stdin closes.

`bun run vscode:dev [folder]` opens VS Code on a folder (this checkout when none is given) with
labkit's ACP client and this agent in it, as `labkit-effect`. It builds the client from
`LABKIT_VSCODE_CLIENT` (labkit-web's `packages/app-vscode`; set it in `.env`) and runs VS Code with
user data of its own (`~/.labkit/vscode-dev`), whose `settings.json` it gives the agent's entry in
`acp.agents`; the user's own settings are not changed. Run `bun install` in this checkout first.

Each session that had a turn is a folder in the session directory: its facts (`facts.jsonl`) and
the host's record of it (`host.json`: the working folder, and a title from the first prompt). The
editor lists them (`session/list`, by working folder, the latest first) and reopens one with
`session/load`, which replays its history, or `session/resume`, which does not. A turn the process
left running (the editor closed mid-turn) is ended as interrupted when its session is reopened,
and nothing it had begun is run again. A session is open in one process at a time. `session/fork`
waits for the core (`TODO.md`, Sessions).

The environment: `LABKIT_ACP_MODEL` (the model new sessions start on, `provider/model`; else the
first the catalog lists), a provider's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`) or
the local server at `http://localhost:8000/v1`, `LABKIT_ACP_SESSIONS_DIR` (default
`~/.labkit/sessions`), `LABKIT_ACP_LOCAL_TOOLS=1` (tools on the local disk instead of through the
editor: a stopgap), `LABKIT_ACP_STRICT_TOOL_INPUT=1` (refuse a tool call whose input has
properties its tool does not take; without it, the call runs without them, and its result says so), and `LABKIT_ACP_LOG_DIR`, `_LEVEL`, `_MAX_BYTES`, `_BACKUPS`.

These are labkit's names. The agent goes by a brand (`src/agent-host/brand.ts`): the one its entry
point gives (`main(brand)`, `launch(env, brand)`), else the one `LABKIT_BRAND` names, else labkit.
As `acme` it reads `ACME_ACP_*`, keeps its sessions and logs in `~/.acme/`, its configuration in
`~/.config/acme/` and `.acme/`, and calls itself `acme` to an ACP client and an MCP server.
