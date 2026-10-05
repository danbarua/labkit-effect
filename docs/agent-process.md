# agent-process

`src/agent-process` starts, stops and restarts the child processes that a session keeps, such as
MCP servers that run over stdio. Each run of a child process has its own process group, so stopping
the run also stops every process that the child started. The module does not decide which commands
run or when: `agent-mcp` and the hosts make those decisions.

The module also removes credentials from the environment that a child process inherits, and from
command arguments before they are logged.

## Files

| File | Responsibility |
| --- | --- |
| `machine.ts` | A pure state machine for one process group. `stepProcess(state, event)` returns the next state and the effects to perform (`Spawn`, `Kill`). |
| `process-group.ts` | `makeProcessGroup(command, onRun)` performs the machine's effects with Effect's `ChildProcessSpawner` and logs every state change. |
| `environment.ts` | Classifies environment variable names as credential names (`shouldRedact`), removes credential variables from an inherited environment, and redacts credential flag values in command arguments (`redactedArgs`). |
| `log-keys.ts` | The names of the log events that this module writes. |

## States

| State | Meaning |
| --- | --- |
| `Idle` | No run was started, or the last run was stopped. |
| `Starting` | A run was requested, and its process has not started yet. |
| `Running` | The run's process is running. The state carries the process id. |
| `Exited` | The run's process ended without a stop request. The state carries the exit code, or the name of the signal that ended the process. |
| `Failed` | The command could not be started. The state carries the reason. |

## Interfaces

- `makeProcessGroup(command, onRun)` requires a `Scope` and a `ChildProcessSpawner`. It returns a
  `ProcessGroup` with `start`, `restart`, `stop`, `state` and `changes`.
- `onRun(run, handle)` receives each run's process handle. `onRun` runs in the run's scope, so it is
  interrupted when the run's scope closes.
- `EnvironmentTransform` and `environmentOf` build the environment for commands that the model
  runs. `agent-config` exposes the transforms as the `commandEnvironment` seam.
  `credentialsLeftOut(allowList)` is the transform that removes credential variables.

Other modules use these functions:

| Module | Uses |
| --- | --- |
| `agent-mcp` | `makeProcessGroup` for stdio servers; `withoutCredentials` in `connectStdio`; `shouldRedact` for HTTP header names. |
| `agent-tools` | `withoutCredentials` for the default environment of `run_command`. |
| `agent-config` | `credentialsLeftOut` for the `credentials` plug-in; `redactedArgs` for `effective-settings.json`. |
| `agent-host` | `shouldRedact` to collect the credential values that logs redact; `redactionPlaceholder`. |
| `agent-acp`, CLI | `environmentOf` and `credentialsLeftOut` for the environment of the commands that the model runs. |

## Design decisions

- **Run numbers.** Each start creates a run with the next run number. The machine ignores
  `Started`, `StartFailed` and `Ended` events for any run other than the current one, because a
  stopped process can report its exit after its replacement has started.
- **One process group per run.** Effect's spawner starts the process detached, in a new process
  group. Closing the run's scope kills the whole group. MCP servers that are launched through `npx`
  or a shell start child processes of their own, and killing only the direct child would leave
  those processes running.
- **Run scope inside the session scope.** Each run's scope is a child of the scope that the group
  was made in. Closing the session's scope therefore kills every process group that the session
  started.
- **Output grace period.** When a run exits by itself, `process-group.ts` waits up to
  `consumerGrace` (2 seconds) for `onRun` to finish before it closes the run's scope. A process's
  last output can still be unread when the process exits.
- **Which variables are removed.** A variable that the child inherits from this process is removed
  when `shouldRedact` classifies its name as a credential name. A variable that the command's own
  configuration sets (an MCP server's `env`) is passed unchanged, because that is how a server
  receives the credential it needs.
- **Arguments are redacted in logs only.** The log shows `--token=<redacted>`. The process receives
  the original value.
- **Signal names.** Effect's spawner reports a signalled exit as an error whose cause message names
  the signal. `process-group.ts` parses the signal name from that message. When the error names no
  signal, the run is `Exited` with neither a code nor a signal, and `process.run.exit_unread` is
  logged as a warning with the error.

## Tests

- `process.test.ts`: the state machine (examples and a property test); exit codes, signals and
  failures to start; the output grace period; and that stopping a run or closing the session's
  scope kills the processes that the run started in the background.
- `environment.test.ts`: credential name classification, argument redaction, the environment that a
  run receives, and what is logged about a run's arguments and environment.
