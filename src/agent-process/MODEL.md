# agent-process

The child process groups a session keeps: a process started in a group of its own, kept for as long
as the session, stopped and started again on request, and ended whole, what it started included,
when it is stopped or the session's scope closes. MCP servers run on it (`agent-mcp`); it knows
nothing of what a process is for.

## What is built

- `machine.ts`: a group's life as a pure machine: `Idle`, `Starting`, `Running`, `Exited`,
  `Failed`; asked to `Start`, `Restart` or `Stop`; told a run `Started`, `StartFailed` or `Ended`.
- `process-group.ts`: `makeProcessGroup(command, onRun)`, in the scope it is given (a session's):
  each run in a scope of its own, a child of that scope, started with Effect's spawner, which runs
  it detached in a group of its own and ends the group when the run's scope closes. `onRun` is
  given each run's handle, in the run's scope. Every change of state is logged.

## Rules

- PG1. Each start is a run, numbered from 1. What is reported about a run that is not the current
  one changes nothing. Asked to start while a run is starting or running, nothing changes; asked to
  start again, the run there is is ended and another started; asked to stop, the run there is is
  ended and the group is `Idle`.
- PG2. A run that ends by itself is `Exited`, with its exit code.
- PG3. A command that cannot be started is `Failed`, with the reason.
- PG4. Stopping a run ends its whole group, what it started in the background included.
- PG5. Closing the scope a group was made in ends its group.
