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
  request was made (`ModelRequestDispatched`, `ToolCallDispatched`) before it goes out. So after a
  crash, a request with no dispatch in the facts was not made, and one with a dispatch and no
  outcome may have been.
- J3. A write that fails stops the session: nothing after it is written, the requests under way are
  stopped, a tool whose dispatch could not be written does not run, and `observe` and `idle` fail
  with the reason.
- J4. A file is written by one process at a time, which holds its lock (`<file>.lock`, holding its
  process id); a lock whose process has ended is taken over. A file is read as facts 1..n in order,
  or refused. A last line without its line break (a write that did not finish) is not read, and is
  cut off before the file is written to again.
- J5. Facts that stop while a turn runs leave it running, with no one carrying out its requests.
  Going on with it (`goOn`) or ending it (`endTurnLeftRunning`) is the host's choice
  (agent-machine X4, X5).
