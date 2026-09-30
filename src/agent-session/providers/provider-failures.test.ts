/**
 * A provider that cannot be reached. VidaiMock always answers, so this is the one failure it cannot
 * play; the others (HTTP statuses, retries) are tested against it in `vidaimock.test.ts`.
 */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect, Layer, Logger } from "effect";
import { ModelName, ProviderName, TurnId } from "../../agent-machine/names.ts";
import { ModelClient } from "../contracts.ts";
import { logKeys } from "../log-keys.ts";
import { anthropicModelClient } from "./anthropic-client.ts";
import { anthropicAt } from "../../../tests/support/providers.ts";
import { runTest } from "../../../tests/support/run.ts";

test("a provider that cannot be reached fails as a network error, retried first", async () => {
  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = gone.url;
  await gone.stop(true);
  const logged: Array<unknown> = [];
  const observed = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ModelClient).respond(
        { provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5") },
        { system: undefined, tools: [], messages: [{ role: "user", parts: [{ _tag: "Text", text: "hi" }] }] },
        TurnId.make("turn-1"),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          anthropicModelClient({ times: 2, firstWait: "1 millis" }).pipe(Layer.provide(anthropicAt(url))),
          Logger.layer([Logger.make((options) => logged.push(options.message))]),
        ),
      ),
    ),
  );
  const events = (key: string) => logged.filter((message) => Array.isArray(message) && message[0] === key);
  expect(observed).toMatchObject({ _tag: "ModelFailed" });
  expect(events(logKeys.provider.requestFailed)).toMatchObject([[logKeys.provider.requestFailed, { reason: "NetworkError" }]]);
  expect(events(logKeys.provider.requestRetried)).toHaveLength(2);
});
