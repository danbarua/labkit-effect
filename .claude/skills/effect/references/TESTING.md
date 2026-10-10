# Testing Effect code in labkit-effect

## The harness

- **Tests use `bun:test`.** Import `test` from `tests/support/test.ts`, not from `bun:test`. It gives each test:
  - a folder of its own, `logs/tests/<test file>/<test name>/`, emptied when the test starts;
  - its identity as the origin of the observations the test reports to a session.
- **Run a program with `runTest`** (`tests/support/run.ts`). It runs the program in a scope and a session context, and writes the program's log lines to the test's `log.jsonl`. A test that asserts on log lines provides its own logger, which replaces that one.
- **Run tests with their output in a file:**

  ```sh
  FORCE_COLOR=0 NO_COLOR=1 bun test ./src/<module>/<file>.test.ts > logs/commands/<name>.txt 2>&1
  ```

  Then read the file. Do not pipe `bun test`.
- **Start a test path with `./` or `/`.** `bun test` reads any other path as a filter that matches part of a file name.

## The test clock

- **Provide the test clock** with `Effect.provide(TestClock.layer())`, or as part of the test's layer. `TestClock` comes from `effect/testing`.
- **Fork the effect that sleeps, then move the clock** with `TestClock.adjust(...)`. If the sleeping effect runs inline before the clock moves, the test waits forever.
- **Make sure the timer exists before moving the clock** when that matters. The code under test signals that it has reached its wait, for example by completing a `Deferred` or waiting on a `Latch`, and the test adjusts the clock after that signal.
- **A jump of the test clock costs real time when periodic loops are running.** `TestClock.setTime` and `TestClock.adjust` wake each due sleep in turn. A loop that sleeps a fixed interval therefore wakes once per interval across the whole jump, and the jump's real duration grows with its size.
  - With no periodic loop running, moving the clock to any date is immediate. `src/agent-context/context-assembly.test.ts` moves it to a 2026 date.
  - With periodic loops running, as in Effect's cluster, whose loops sleep 100 to 200 ms, a jump of one hour took about 180 ms. A jump to a 2026 date would take days.
  - In that case, set the start time in a layer that is built before the loops start:

  ```ts
  /** A test clock set to `timestamp` before any layer built on it starts sleeping. */
  const testClockAt = (timestamp: number) =>
    Layer.effect(
      Clock.Clock,
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(timestamp);
        return clock;
      }),
    );

  // Provided below the layers whose loops sleep:
  app.pipe(Layer.provideMerge(cluster), Layer.provideMerge(testClockAt(Date.UTC(2026, 9, 10, 12))));
  ```

## Synchronize; do not sleep

- **Pick the primitive by what the test waits for:**
  - **`Deferred`:** a signal or a result that happens once, such as "the worker has started".
  - **`Queue`:** interactions in order, or inputs the test scripts.
  - **`Latch`:** a gate. The code under test waits at it, the test inspects the intermediate state, then opens it.
  - **`Ref`:** recorded state, such as a count of attempts. Read it only after a `Deferred`, a `Queue`, a `Latch` or a joined fiber shows that the write has happened.
- **Real time is only for real processes and servers.** A test that starts a process or a server may wait in real time, with a bound such as 50 checks 20 ms apart, and fails when the bound is reached. The tests in `agent-process` and `agent-mcp` do this.
- **Polling is only for code that offers no handshake.** labkit's own code exposes a point a test can wait on. Code that drives `effect/cluster` cannot: the cluster has no such points, and Effect's own cluster tests advance the clock and read storage in a loop. For that code, polling under the test clock with a bound is the way to test it (`references/CLUSTER.md`).

## Test services

- **A fake that several tests share is a test service.** It implements the production interface. It records the calls it gets and returns responses the test scripts. Tests control and inspect it through a second, test-only service; production code depends only on the real one.
- **An unexpected call to a fake fails the test.**
- **Fakes live in test files or `tests/support/`,** never in `src/` outside a test file.

## Assert the end state

Assert both of these:

- **the result:** the returned value, or the typed error;
- **the state the operation left:** the session's facts, files written, processes ended, log events.

A fake's call count does not show that the real dependency behaves that way. When the behaviour depends on a real dependency, such as SQLite, a process or the file system, the test uses the real one.
