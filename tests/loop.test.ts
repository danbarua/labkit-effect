/** The loop around the core, with stub services: what it does regardless of which adapters run. */

import { expect, test } from "bun:test";
import { Effect, Layer, Logger, References } from "effect";
import { ModelName, ModelText, ProviderName, StopReason, TurnId } from "../src/agent-core/names.ts";
import type { Observation } from "../src/agent-core/observation.ts";
import { BoringContextAssembler, CountingTurns } from "../src/agent-effect/boring.ts";
import { ModelClient, ModelProvider } from "../src/agent-effect/contracts.ts";
import { openSession } from "../src/agent-effect/loop.ts";
import { receivedJson } from "../src/agent-effect/received.ts";
import { SmolToolRunner } from "../src/agent-effect/smol-tools.ts";

test("a log line written while a request is carried out carries the request's turn", async () => {
  const logged: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) } });
  });
  const client = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.logInfo("stub.responding").pipe(
        Effect.as({
          _tag: "ModelResponded" as const,
          turn,
          provider: target.provider,
          model: target.model,
          parts: [{ _tag: "Text" as const, text: ModelText.make("ok") }],
          stop: StopReason.make("end_turn"),
          metadata: receivedJson({}),
        }),
      ),
  });
  const provider = Layer.succeed(ModelProvider, {
    select: () =>
      Effect.succeed({
        provider: ProviderName.make("stub"),
        model: ModelName.make("stub-1"),
        endpoint: new URL("http://stub.invalid/"),
      }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe({ _tag: "SessionOpened", session: "s1" } as unknown as Observation);
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "hi" } as unknown as Observation);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(provider, client, BoringContextAssembler, CountingTurns, SmolToolRunner, Logger.layer([capture])),
      ),
    ),
  );
  expect(logged).toContainEqual({ message: ["stub.responding"], annotations: { turn: TurnId.make("turn-1") } });
});
