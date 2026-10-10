---
name: effect
description: How labkit-effect writes Effect v4 code — services, layers, errors, schemas, scopes, schedules — and how it tests that code with the test clock; also what holds for code built on effect/cluster and effect/workflow. Use when writing, reviewing or testing Effect code in this repository.
---

# Effect in labkit-effect

## Sources

- **The installed version is `effect@4.0.2`.** `repos/effect` is Effect's source at that tag. Start at `repos/effect/LLMS.md`, and read the source before guessing at an API. `~/Code/lib/effect` is an older beta and does not match.
- **Typecheck what you write** with `bun run typecheck`, not against memory of another Effect version.

## Precedence

When two sources disagree, the one earlier in this list wins:

1. `CLAUDE.md`, and the module's `docs/<module>.md`.
2. `oxlint.config.ts` and the other checks in `bun run check`:
   - Effect's lint preset (`@effect/tsgo`, `strict`: every rule an error);
   - the rules for functional modules and abstract layers (`scripts/oxlint/abstract-layers.js`);
   - the dependency check and the brand check.
3. This skill.
4. The skills this one adapts (`ATTRIBUTION.md`).

## Where this repository differs from general Effect advice

- **A `switch` on `_tag` names every member.** Code dispatches on a union with a `switch` that lists each member. The lint rule `typescript/switch-exhaustiveness-check` makes a missing member an error, and a `default` branch does not count as covering one, so adding a member makes the compiler point at every place that must handle it. Advice to never compare `_tag` does not apply here.
- **Errors in the error channel are caught by tag.** Use `Effect.catchTag` or `Effect.catchTags`. The lint preset reports a hand-written dispatch on an error's tag.
- **`Data.TaggedError` is the default error class.** It is for a failure that stays inside the process. Use `Schema.TaggedError` only for a failure that crosses a wire or is stored, because only that needs a codec.
- **`Context.Reference` marks an extension point.** A list-shaped extension point, such as `TurnEndHooks` or `ToolCallPolicies`, is a `Context.Reference` with an empty default, so that a host adds pieces without editing a central file. A capability the program cannot run without, such as `SessionContext`, is a `Context.Service`, which has no default.
- **Functional modules.** The modules listed in `functionalModules` in `oxlint.config.ts` have:
  - no `let`;
  - no loop statements;
  - no in-place changes;
  - log event names taken from the module's log key table.

  State that changes over time lives in a `Ref`. State that the session's facts already determine is computed from the facts when it is read. It is not kept in a `Ref` beside them.
- **Tests use `bun:test`, not `@effect/vitest`.** There is no `it.effect`. Read `references/TESTING.md` before writing a test.

## Defaults for new code

- **Compose** with `Effect.gen(function* () { ... })`.
- **A service** is a class extending `Context.Service<Self, Interface>()("<module>/<Name>")`. Its implementation is a layer built with `Layer.effect(Service, Effect.gen(...))`, returning `Service.of({ ... })`.
- **A public operation** gets a stable name with `Effect.fn("<module>.<operation>")`, which also gives it a span. Few operations have one today; new ones add it.
- **Input from outside the process is decoded** with Schema at the boundary, for example with `Schema.decodeUnknownEffect`. A cast never stands in for decoding.
- **Retries and repeats** use a `Schedule`, and every retry has a bound. Retry only an operation that is safe to repeat. Effect's cluster and workflow modules deliver at least once, so code built on them is retried whether or not it is safe (`references/CLUSTER.md`).
- **A source of many values over time**, which needs backpressure or interruption, is a `Stream`.
- **Background work and resources have an owner.** A background fiber belongs to a scope (`Effect.forkScoped`, a `FiberSet`), and a resource is released by a finalizer.
- **Configuration** is read through `Config`, or from the environment that an entry point passes in (`agent-process/environment.ts`). `node/no-process-env` reports a read of `process.env` in `src/` outside tests.

## Do not

- **Do not cast.** Type assertions (`x as T`, `<T>x`) and non-null assertions (`x!`) are lint errors. Narrow, annotate, or decode instead; `as const` is allowed. The files that had casts when the rules started are exempt (`scripts/lint-exceptions.ts`): a file leaves its list when its last cast is gone, and no file joins a list.
- **Do not give a `Context.Reference` a default** that stands in for persistence, credentials or a transport. A program that forgot to provide the real one then runs on the default with no error. `Blobs` (`agent-session/blobs.ts`), whose default is an in-memory store, is an existing case.
- **Do not use `Layer.mergeAll` or `Layer.provideMerge` only to make a type error go away.** The error usually names a dependency that some layer has to provide.
- **Do not sleep in a test** (`Effect.sleep`, `Bun.sleep`, `setTimeout`); `abstract/no-sleep-in-tests` reports it. Synchronize instead (`references/TESTING.md`). A bounded wait for a real process or server carries its reason: `// oxlint-disable-next-line abstract/no-sleep-in-tests -- <reason>`.
- **Do not read a clock or a random source in a workflow's body** (`Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, `performance.now()`); `abstract/workflow-deterministic` reports it (`references/CLUSTER.md`).
- **Do not keep a copy of the facts in a `Ref`.** Compute the view from the facts when it is read.

## References

- **Tests, the test clock, synchronization and test services:** `references/TESTING.md`.
- **Code built on `effect/cluster` and `effect/workflow`:** `references/CLUSTER.md`.
