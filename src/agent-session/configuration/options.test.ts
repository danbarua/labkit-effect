/** What a host shows of a configuration: from a model and its settings alone, or from a session's facts, following each change taken. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler } from "../../../tests/support/boring.ts";
import { runTest } from "../../../tests/support/run.ts";
import { test } from "../../../tests/support/test.ts";
import { AdjustmentReason, ModelName, ProviderName, SessionId, TokenCount, TurnId } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { ModelClient, ToolRunner } from "../contracts.ts";
import { openSession } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { optionsFor, optionsOf, type Options } from "./options.ts";
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

const draft = (provider: string, model: string, settings: ModelSettings) => ({ provider: ProviderName.make(provider), model: ModelName.make(model), settings });
const nowOf = (options: Options, name: keyof ModelSettings) => options.offered.find((each) => each.name === name)?.now;

test("the options of a model and its settings need no session: a well-known model offers what it takes, with each value now", async () => {
  const options = await Effect.runPromise(optionsFor(draft("openai", "gpt-5.5", { effort: "medium", cache: "1h" })));
  expect(options as unknown).toEqual({
    provider: "openai",
    model: "gpt-5.5",
    settings: { effort: "medium", cache: "1h" },
    offered: [
      { _tag: "OneOf", name: "effort", now: "medium", values: ["low", "medium", "high", "xhigh"] },
      { _tag: "OneOf", name: "thinking", values: ["auto", "off"] },
      { _tag: "OneOf", name: "observe", values: ["all", "progress_only", "off"] },
      { _tag: "OneOf", name: "cache", now: "1h", values: ["5m", "1h"] },
      { _tag: "Number", name: "maxOutputTokens" },
    ],
  });
});

test("an effort beyond the model's highest stays as said, and its value now is the nearest the model takes, among those offered", async () => {
  const options = await Effect.runPromise(optionsFor(draft("openai", "gpt-5.5", { effort: "max" })));
  expect(options.settings).toEqual({ effort: "max" });
  expect(options.offered[0] as unknown).toEqual({ _tag: "OneOf", name: "effort", now: "xhigh", values: ["low", "medium", "high", "xhigh"] });
});

test("with thinking off, the effort said is not sent, so no effort is now", async () => {
  const options = await Effect.runPromise(optionsFor(draft("openai", "gpt-5.5", { thinking: "off", effort: "high" })));
  expect(options.settings).toEqual({ thinking: "off", effort: "high" });
  expect(nowOf(options, "effort")).toBeUndefined();
  expect(nowOf(options, "thinking")).toBe("off");
});

test("a provider with no settings function offers every value, and each setting is now as said", async () => {
  const options = await Effect.runPromise(optionsFor(draft("nowhere", "m", { effort: "max", maxOutputTokens: TokenCount.make(10) })));
  expect(options.offered as unknown).toEqual([
    { _tag: "OneOf", name: "effort", now: "max", values: ["low", "medium", "high", "xhigh", "max"] },
    { _tag: "OneOf", name: "thinking", values: ["auto", "before_answer", "between_tools", "off"] },
    { _tag: "OneOf", name: "observe", values: ["all", "progress_only", "off"] },
    { _tag: "OneOf", name: "cache", values: ["off", "5m", "1h"] },
    { _tag: "Number", name: "maxOutputTokens", now: 10 },
  ]);
});

const services = Layer.mergeAll(
  ModelFromFacts,
  BoringContextAssembler,
  CountingTurns,
  NoTurnEndHooks,
  EphemeralSessionStore,
  Layer.succeed(ModelClient, { respond: () => Effect.die("no request") }),
  Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
);

test("a session opened with a model and settings, before any request, has the options of that model and settings alone", async () => {
  const target = draft("anthropic", "claude-opus-5-5", { thinking: "off", effort: "max", maxOutputTokens: TokenCount.make(4000) });
  const [fromFacts, alone] = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(openedWith({ session: SessionId.make("s1"), model: target, system: undefined, tools: [] }));
      yield* session.idle;
      return [yield* optionsOf(yield* session.facts), yield* optionsFor(target)] as const;
    }).pipe(Effect.provide(services)),
  );
  expect(fromFacts).toEqual(alone);
});

test("after a setting is adjusted, the session's options have the adjusted setting, and nothing more is adjusted", async () => {
  const options = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      const model = draft("anthropic", "claude-opus-5-5", { thinking: "off", effort: "high" });
      yield* session.observe(openedWith({ session: SessionId.make("s1"), model, system: undefined, tools: [] }));
      yield* session.observe({
        _tag: "SettingAdjusted",
        turn: TurnId.make("turn-1"),
        provider: model.provider,
        model: model.model,
        adjusted: { _tag: "Thinking", asked: "off", used: "auto" },
        reason: AdjustmentReason.make("this model does not allow thinking to be turned off"),
      });
      yield* session.idle;
      return yield* optionsOf(yield* session.facts);
    }).pipe(Effect.provide(services)),
  );
  expect(options.settings).toEqual({ thinking: "auto", effort: "high" });
  expect(options.offered.slice(0, 2) as unknown).toEqual([
    { _tag: "OneOf", name: "effort", now: "high", values: ["low", "medium", "high", "xhigh", "max"] },
    { _tag: "OneOf", name: "thinking", now: "auto", values: ["auto"] },
  ]);
});
