/** A session's configuration as a host shows it: read from its facts, and following each change taken. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import { ModelName, ProviderName, SessionId, TokenCount } from "../../agent-machine/names.ts";
import { ModelClient, ToolRunner } from "../contracts.ts";
import { openSession } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { optionsOf } from "./options.ts";
import { openedWith } from "./session-setup.ts";

test("the options are the model, the settings in force, and each setting to offer with its value now; they follow a change taken", async () => {
  const [opened, changed] = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      const model = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5"), settings: { effort: "low" as const, maxOutputTokens: TokenCount.make(2000) } };
      yield* session.observe(openedWith({ session: SessionId.make("s1"), model, system: undefined, tools: [] }));
      yield* session.idle;
      const before = yield* optionsOf(yield* session.facts);
      yield* session.observe({ _tag: "ModelChangeArrived", provider: ProviderName.make("xai"), model: ModelName.make("grok-4.7") });
      yield* session.idle;
      return [before, yield* optionsOf(yield* session.facts)] as const;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          BoringContextAssembler,
          CountingTurns,
          NoTurnEndHooks,
          Layer.succeed(ModelClient, { respond: () => Effect.die("no request") }),
          Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
        ),
      ),
    ),
  );
  expect(opened as unknown).toEqual({
    provider: "openai",
    model: "gpt-5.5",
    settings: { effort: "low", maxOutputTokens: 2000 },
    offered: [
      { _tag: "OneOf", name: "effort", now: "low", values: ["low", "medium", "high", "xhigh"] },
      { _tag: "OneOf", name: "thinking", values: ["auto", "off"] },
      { _tag: "OneOf", name: "observe", values: ["all", "progress_only", "off"] },
      { _tag: "OneOf", name: "cache", values: ["5m", "1h"] },
      { _tag: "Number", name: "maxOutputTokens", now: 2000 },
    ],
  });
  // The settings said stay for the other model; xAI has no setting for the cache.
  expect(changed.offered.map((each) => each.name)).toEqual(["effort", "thinking", "observe", "maxOutputTokens"]);
  expect(changed).toMatchObject({ provider: "xai", model: "grok-4.7", settings: { effort: "low" } });
});
