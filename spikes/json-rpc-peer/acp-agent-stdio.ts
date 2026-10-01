/**
 * SPIKE: the agent in `acp-agent.ts` on stdin and stdout, as an editor launches an ACP agent. It runs
 * until stdin closes. Nothing but protocol messages is written to stdout.
 */

import { Deferred, Effect, Stream } from "effect";
import { runAgent } from "./acp-agent.ts";

const program = Effect.gen(function* () {
  const ended = yield* Deferred.make<void>();
  yield* runAgent(
    {
      read: Stream.fromReadableStream({ evaluate: () => Bun.stdin.stream(), onError: (error) => error }).pipe(
        Stream.ensuring(Deferred.succeed(ended, undefined)),
      ),
      write: (line) => Effect.sync(() => void process.stdout.write(line)),
    },
    { hangInterrupted: yield* Deferred.make<void>() },
  );
  yield* Deferred.await(ended);
});

Effect.runPromise(Effect.scoped(program)).then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
