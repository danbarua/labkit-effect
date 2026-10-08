# labkit-effect

labkit is a coding agent: a model that reads your project, runs commands and changes files, asking
you first before anything that could do harm. It runs at the terminal (the `labkit` command) and
inside editors through the Agent Client Protocol (ACP). It is written in TypeScript with
[Effect](https://effect.website) and runs on [Bun](https://bun.sh).

It is being built. It is used day to day at the terminal, and in VS Code for testing.

## What it does

- **Talks to the models you have keys for**: Anthropic, OpenAI and xAI, or a local
  OpenAI-compatible server. You choose the model, its reasoning effort and its thinking.
- **Keeps every session**, so you can carry on with it later, at the terminal or in an editor.
- **Asks before it acts.** It reads your project without asking. Before it changes a file or runs a
  command, it asks, unless you have allowed it. A command is judged by each program it runs:
  `git log | head` runs, `git push` asks, and a command that reads `~/.aws/credentials` asks even if
  it only uses `cat`. You can allow a program for the rest of a session, and write rules that allow
  or refuse programs in every session.
- **Trusts a project only when you say so.** A cloned project's `.env` and settings are not read
  until you trust its folder.
- **Uses MCP servers** that you configure, and the tools of the editor it runs in.
- **Can report what it does** (traces, logs and metrics) to a local Grafana stack.

## Getting started

```sh
bun install
bun link                                   # puts the labkit command on your PATH
export ANTHROPIC_API_KEY=…                 # or OPENAI_API_KEY, XAI_API_KEY, or a server at localhost:8000
labkit                                     # in the folder you want to work in
```

The [guide](docs/guide/README.md) covers using labkit:
[getting started](docs/guide/getting-started.md), [trusted folders](docs/guide/trusted-folders.md)
and [permissions](docs/guide/permissions.md).

## In an editor

`bun src/agent-acp/main.ts` (`bun run acp:dev`) is the command an editor launches: ACP protocol v1
on stdin and stdout. It writes a log file, whose path it prints once on stderr, and exits when stdin
closes.

`bun run vscode:dev [folder]` opens VS Code on a folder (this checkout when none is given) with
labkit's ACP client and this agent in it. It builds the client from `LABKIT_VSCODE_CLIENT`
(labkit-web's `packages/app-vscode`; set it in `.env`), and runs VS Code with user data of its own
(`~/.labkit/vscode-dev`), so your own VS Code settings are not changed.

The editor lists a folder's sessions, newest first, and reopens one with its history. The agent's
options are flags (`bun src/agent-acp/main.ts --help`), each read from a `LABKIT_ACP_…` variable
when not given: the model new sessions start on, the permission mode, where sessions are kept
(`~/.local/share/labkit/sessions/`), the settings to read, and the MCP servers to start.
`bun run acp:logs [--errors]` prints the newest launch's log (`~/.local/share/labkit/logs/`). The
agent's design is in [docs/agent-acp.md](docs/agent-acp.md).

## For developers

```sh
bun run check          # builds and tests the command parser, then typecheck, lint, schemas, dependencies and tests
bun cli --help         # the CLI from this checkout (it reads this checkout's .env, as Bun always does)
bun run commands:import && bun run commands:ask-rate   # measure the permission policy over saved sessions
bun scripts/trajectories/sweep.ts claude-code          # replay saved sessions through the core
```

`bun run check` needs Rust (`cargo`, with the `wasm32-unknown-unknown` target). The adapter tests
start [VidaiMock](https://github.com/vidaiUK/VidaiMock), a server that answers as the providers'
APIs do; `bun run vidaimock:install` downloads the pinned release into `.tools/`, checking its
SHA-256.

### Design constraints (Dan, verbatim)

- C1. Pure state machines.
- C2. Message passing only.
- C3. Build in the abstract. No concrete implementations.
- C4. Facts, Decisions, Effects, Observations.
- C5. No unbranded strings.
- C6. Everything written down - code or prose - says exactly what it means and nothing else.
- C7. Behaviours: implementation details. Those are the layer *around* the core. Contracts. Adapters.

### Layout

| Directory | What it is | Design doc |
| --- | --- | --- |
| `src/agent-machine/` | The core: machines that pass messages (agent, conversation turn, turn step, call), and the facts, decisions and effect requests they record. Imports only `Schema` from `effect`. | [agent-machine](docs/agent-machine.md) |
| `src/agent-policy/` | Whether an effect request continues, is vetoed or waits: permissions, rules, the loop breaker, turn limits. Imports only `Schema` and the core. | [agent-policy](docs/agent-policy.md) |
| `src/agent-session/` | The agentic loop, the contracts as Effect services, and the providers' adapters. | [agent-session](docs/agent-session.md) |
| `src/agent-context/` | What the model is sent: system prompts, tool catalogs, the conversation, compaction. | [agent-context](docs/agent-context.md) |
| `src/agent-config/` | Configuration: layers, plug-ins, seams, the JSON Schema. | [agent-config](docs/agent-config.md) |
| `src/agent-host/` | What the CLI and the ACP host share: the model catalog, provider clients, sessions on disk, logs, trusted folders, the command parser. | [agent-host](docs/agent-host.md) |
| `src/agent-acp/` | The ACP host, on [effective-acp](https://github.com/danbarua/effective-acp). | [agent-acp](docs/agent-acp.md) |
| `src/agent-tools/`, `src/agent-mcp/`, `src/agent-process/` | Tools, MCP clients, child processes. | [agent-mcp](docs/agent-mcp.md), [agent-process](docs/agent-process.md) |
| `src/instrumentation/` | Metrics, traces and logs, sent as OpenTelemetry. | [README](src/instrumentation/README.md) |
| `src/examples/` | The CLI (`cli-repl`), Zork, the spectator, FizzBuzz. | |
| `native/bash-segments/` | The command parser, in Rust, built to WebAssembly. | [bash-segments](docs/bash-segments.md) |
| `scripts/` | Probes against the providers, trajectory importers, the command corpus, the observability stack. | |

The docs come in three kinds:

- **The guide** (`docs/guide/`): what labkit does and how to use it.
- **Design docs** (`docs/<module>.md`): how a module is built, its states, interfaces, decisions
  and tests. `docs/<module>-direction.md` holds direction that is not built.
- **`TODO.md`**: what is to be built.

A module's tests are beside its code. `tests/` holds what joins modules, and `tests/support/` what
tests share. In `agent-machine` and `agent-policy`, `bun run lint` (oxlint, with
`scripts/oxlint/abstract-layers.js`) enforces their imports and pure functions, and refuses the
`string` type and an unbranded `Schema.String`; `bun run check:brands` checks that every schema there
decodes to a type with no unbranded string.

### The brand

These are labkit's names. The agent goes by a brand (`src/agent-host/brand.ts`): the one its entry
point gives, else the one `LABKIT_BRAND` names, else labkit. As `acme` it reads `ACME_…` variables,
keeps its configuration in `~/.config/acme/` and `.acme/` and its sessions in
`~/.local/share/acme/`, and calls itself `acme` to an ACP client and an MCP server.
