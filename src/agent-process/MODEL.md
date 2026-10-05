# agent-process

The child process groups a session keeps: a process started in a group of its own, kept for as long
as the session, stopped and started again on request, and ended whole, what it started included,
when it is stopped or the session's scope closes. MCP servers run on it (`agent-mcp`); it knows
nothing of what a process is for.

## What is built

- `environment.ts`: a spawned process's environment, without this process's credentials.
- `machine.ts`: a group's life as a pure machine: `Idle`, `Starting`, `Running`, `Exited`,
  `Failed`; asked to `Start`, `Restart` or `Stop`; told a run `Started`, `StartFailed` or `Ended`.
- `process-group.ts`: `makeProcessGroup(command, onRun)`, in the scope it is given (a session's):
  each run in a scope of its own, a child of that scope, started with Effect's spawner, which runs
  it detached in a group of its own and ends the group when the run's scope closes. `onRun` is
  given each run's handle, in the run's scope. Every change of state is logged.

## What is not built

- The editor's terminals (`agent-acp` `run_command`, `terminal/create`) run with the editor's
  environment, credentials included: ACP lets an agent add variables to a terminal's, not leave
  them out.

## Rules

- PG1. Each start is a run, numbered from 1. What is reported about a run that is not the current
  one changes nothing. Asked to start while a run is starting or running, nothing changes; asked to
  start again, the run there is is ended and another started; asked to stop, the run there is is
  ended and the group is `Idle`.
- PG2. A run that ends by itself is `Exited`, with its exit code; a run that a signal ended is
  `Exited` with the signal's name and no exit code. An exit that gives neither is logged as a
  warning (`process.run.exit_unread`), with the error. What a run wrote is read to its end
  (`onRun` finishes, for two seconds at most) before its scope closes.
- PG3. A command that cannot be started is `Failed`, with the reason.
- PG4. Stopping a run ends its whole group, what it started in the background included.
- PG5. Closing the scope a group was made in ends its group.
- PE1. A variable holds a credential if its name includes one of these words, in any case: `TOKEN`,
  `KEY`, `AUTH`, `SECRET`, `PASSWORD`, and similar. The words of a name are separated by `_`, `-`,
  `.`, and by a capital that follows a lower-case letter: `apiKeyId` holds `Key`; `monkey` holds no
  credential word. When you log a
  command or write its arguments, omit credential flag values (for example, --token=<redacted>).
  Run the command with the actual values.
- PE2. A run receives this process's environment minus credential variables, plus any environment
  settings the command specifies. Log the names of credential variables you removed and environment
  variables you set. Do not log their values. The MCP client's connectStdio removes credential
  variables the same way. The workspace's run_command gets its environment from the host (see
  agent-config CF13). By default, it uses this process's environment from when the tools were made,
  minus credential variables.
