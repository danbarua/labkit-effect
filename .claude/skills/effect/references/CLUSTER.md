# effect/cluster and effect/workflow

labkit-effect is evaluating these modules; `src/` does not use them yet. The facts below come from two sources:

- probes on the branch `probe/effect-cluster` (commit `32b61605ba`, folder `probes/effect-cluster/`);
- reading `repos/effect` at 4.0.2.

Both modules are marked unstable in 4.0.2.

## Delivery and replay

- **Delivery is at least once.** After a restart:
  - a handler that was part-way through runs again from its start;
  - an activity that was part-way through runs again from its start;
  - an activity that finished does not run again, and its stored result is returned.

  A side effect performed before the crash is performed a second time. A runner that takes over another runner's shards also delivers again every request that has no final reply.
- **Replay re-runs the workflow function.** A workflow is a function, and the engine stores no position inside it. To continue a run, the engine calls the function again from its first line, and each activity that finished returns its stored result instead of running. The engine continues a run when:
  - a suspended run is woken by a deferred or a timer;
  - the runtime restarts over the same storage.
- **Code outside activities runs again on every replay.** Keep the workflow body deterministic. Put anything that is not deterministic, or that has a side effect, in an activity.
- **An activity's name is its key.** Its result is stored under its name and attempt number. Two activities with the same name in one run share one stored result: the second returns the first one's result and does not run.
- **An activity's name must be unique within the run, and the same on every replay.** Take the unique part from one of these:
  - the id of the journalled message that started the work, which is a fact;
  - a step number;
  - a tool call id;
  - a value that an earlier activity returned.

  Never generate it in the workflow body with `crypto.randomUUID()` or `Date.now()`. The replay generates a different name, finds no stored result, and runs the activity again.

## Expectations and timers

- **`DurableDeferred` is a named wait point whose result is stored.** An entity completes it with a message carrying the deferred's token. `DurableDeferred.raceAll` and `Activity.raceAll` record only the winner.
- **A `DurableClock` that loses a race is not cancelled.** It fires at its time and sends its completion to the workflow. A workflow that has finished ignores it. Each such timer costs one stored request and one reply.
- **`Workflow.interrupt` cleans up.** It ends the run as interrupted, runs the run's compensations, and deletes the run's pending timers from storage.
- **Only completion is stored.** Waiting on a deferred stores nothing, so an expectation that is never met leaves no record unless code writes one.

## Messages and mailboxes

- **Persistence is set per request type** with the annotation `ClusterSchema.Persisted`, whose default is `false`. A persisted request is in storage before its handler runs. An ephemeral request is never stored.
- **A full mailbox treats the two kinds differently.** Persisted requests beyond the mailbox's capacity wait in storage and are delivered later. Ephemeral requests beyond it fail at once with `MailboxFull`.
- **An entity handles one request at a time by default.** Set the `concurrency` option of `Entity.toLayer` when a request must be handled while another one runs, such as a cancel while a tool runs.
- **An entity's in-memory state is lost on a restart.** Rebuild it from labkit's journal.
- **Only a request's payload is stored, not an activity's inputs.** An activity's stored record has its name and attempt number. Inputs that must be recorded go in a message's payload, or in the activity's result.

## Versions, storage and machines

- **Workflows have no versioning.** Changing a workflow's code changes what happens to the runs in flight:
  - a renamed activity runs again;
  - a changed schema makes the run fail with a defect when it resumes;
  - a renamed workflow leaves its runs orphaned.

  Workflows are for crash recovery, such as a turn or a job watch. Long-lived state belongs in labkit's journal.
- **Nothing is ever purged.** The tables `cluster_messages` and `cluster_replies` keep every row. Only `Workflow.interrupt` deletes rows, and only the run's timers. Effect's tables are Effect's own bookkeeping, and labkit does not delete rows from them. Under consideration: one SQLite file per session, emptied when no run is suspended and no message is unprocessed.
- **`SingleRunner` runs the cluster in one process.** It needs a SQL client; `@effect/sql-sqlite-bun` provides one for Bun.
- **Across machines, the cluster needs more.** Every runner needs the same SQL database, and every runner that hosts entities must accept inbound connections from the others. A machine behind NAT, such as a Colab VM, can only be a client. Use the cluster within one machine.

## Testing code built on the cluster

- **The cluster runs in one process with in-memory storage** for tests. Build it from `ClusterWorkflowEngine.layer`, `Sharding.layer`, `MessageStorage.layerMemory`, `RunnerStorage.layerMemory`, `Runners.layerNoop` and `RunnerHealth.layerNoop`. Configure the shard groups `default` and `workflow` as both available and assigned.
- **A request to an entity waits on the clock.** While the test waits, advance the test clock and call `Sharding.pollStorage` in a bounded loop.
- **Set the test clock's start time before the cluster's layers are built** (`references/TESTING.md`).
- **Cost on SQLite with the real clock,** on a Mac in October 2026:
  - about 0.8 ms per persisted request;
  - about 6.5 ms per workflow, counting its start, a deferred, two activities and its completion.
