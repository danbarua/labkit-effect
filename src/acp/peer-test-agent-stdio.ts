/**
 * The agent in `peer-test-agent.ts` on stdin and stdout, as an editor launches an ACP agent. It runs
 * until stdin closes, then exits 0. Logs go to stderr, so stdout carries only protocol messages.
 */

import { BunStdio } from "@effect/platform-bun";
import { Deferred, Effect, References } from "effect";
import { runAgent } from "./peer-test-agent.ts";
import { fromStdio } from "./stdio.ts";

const program = Effect.gen(function* () {
  const peer = yield* runAgent(yield* fromStdio, {
    hanging: yield* Deferred.make<void>(),
    hangInterrupted: yield* Deferred.make<void>(),
  });
  yield* peer.closed;
});

Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(BunStdio.layer), Effect.provideService(References.LogToStderr, true)),
).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
