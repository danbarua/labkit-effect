# agent-session

The loop around the core (`loop.ts`), and what it is plugged into: the services that carry out its
requests (`contracts.ts`), the providers' adapters (`providers/`), a session's configuration
(`configuration/`), and where its facts are kept (`session-store.ts`, `file-session-store.ts`).

## Rules: where a session's facts are kept

- J1. A session needs a store to run (`openSession` requires `SessionStore`); there is no default.
  `EphemeralSessionStore` keeps the facts in memory, gone when the process ends;
  `FileBackedSessionStore` keeps them in a file. A store opened on facts it already keeps is the
  session going on from them: the loop starts from them.
- J2. Each fact is written down before anything is done on it: an observation before the core
  decides on it; the decisions before the requests that follow from them are carried out; that a
  request was made (`ModelRequestDispatched`, `ToolCallDispatched`) before it goes out. The file
  store flushes each write to the disk (`fsync`) before `append` returns, so this holds through a
  power cut as well as a killed process. So after a crash, a request with no dispatch in the facts
  was not made, and one with a dispatch and no outcome may have been.
- J3. A write that fails stops the session: nothing after it is written, the requests under way are
  stopped, a tool whose dispatch could not be written does not run, and `observe`, `idle`, `prompt`
  (also while it waits for its turn to end) and `cancel` fail with the reason.
- J4. A file is written by one process at a time, which holds its lock (`<file>.lock`, holding its
  process id); a lock whose process has ended is taken over. A file is read as facts 1..n in order,
  or refused. A last line without its line break (a write that did not finish) is not read, and is
  cut off before the file is written to again.
- J5. Facts that stop while a turn runs leave it running, with no one carrying out its requests.
  Going on with it (`goOn`) or ending it (`endTurnLeftRunning`) is the host's choice
  (agent-machine X4, X5).

## Rules: a host driving turns

A host gives the user's input with `prompt`, stops the turn with `cancel`, and asks which turn is
under way with `turn`. The CLI still gives observations with `observe` and waits with `idle`.

- L1. The turn under way is the latest `TurnStarted` with no `TurnEnded` recorded for it; between
  turns there is none. A turn the facts left running (J5) is under way until the host goes on with
  it or ends it.
- L2. `prompt` records the input as the user's (`InputArrived` from `User`, its text and
  attachments, with the origin `CurrentOrigin` gives) and returns how the turn that took it ended.
  With no turn under way the loop starts one for it. It waits on the facts recorded, not on `idle`,
  and holds nothing while it waits: the session takes observations meanwhile, a permission answer
  given from another fiber among them.
- L3. With a turn under way, `prompt`'s input goes to that turn, which takes it between steps
  (agent-machine I3); `prompt` returns when that turn ends, with its ending. If the turn ends other
  than by an answer the input is dropped (I6, X3) and `prompt` returns that ending all the same; the
  next input starts a new turn. Two `prompt`s at once are recorded one after the other: the first
  starts a turn if none is under way, the second goes to the same turn, and both return its ending.
  No input waits anywhere but in a turn's mailbox.
- L4. A turn that failed leaves no turn under way: the next `prompt` starts a new one and returns
  how that one ended.
- L5. `cancel` records `TurnInterrupted` for the turn under way, with the origin `CurrentOrigin`
  gives, and returns once it is recorded, not when the turn has ended: the turn ends `Interrupted`
  once its requests have reported how far they got (agent-machine X1–X3). A call waiting for a
  permission answer ends `NotRun` and the question is no longer waited on. With no turn under way
  `cancel` records nothing.

## Rules: when a user's change of configuration is made

A user's change of model or settings is a fact once it is observed (`ModelChangeArrived`). When it
is observed is decided outside the core, by the session's configuration gate
(`configuration/gate.ts`), so that the model that started a turn completes it. The fallback chain's
change does not go through the gate: it is observed at once, and the core takes it between steps.

- G1. While no turn runs, a change is made at once.
- G2. While a turn runs, a change is held; changes held are merged in the order they came, the
  later's fields winning, and made as one when the host settles the gate: when the turn ends, and
  before a turn starts. Settling while a turn runs makes nothing.
  A change held is not a fact: if the process ends while it is held, it is lost.
- G3. A change submitted after the turn has ended and before the host settles is made with the one
  held: none is lost.

