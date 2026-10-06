/** The draft a session is before turn zero: changed, shown, defaulted, and opened. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BoringContextAssembler } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { ModelName, ProviderName, SessionId, TokenCount, ToolName } from "../agent-machine/names.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
import { ModelFromFacts } from "../agent-session/configuration/model-choice.ts";
import { type Options, optionsOf } from "../agent-session/configuration/options.ts";
import { immutableSystemPromptOf, immutableToolCatalogOf, modelOf } from "../agent-session/configuration/session-setup.ts";
import { capabilitiesOf } from "../agent-session/configuration/well-known-models.ts";
import { ModelClient, ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { openSession } from "../agent-session/loop.ts";
import { EphemeralSessionStore } from "../agent-session/session-store.ts";
import { CountingTurns } from "../agent-session/turns.ts";
import { type Asked, type CatalogSource, ModelCatalog } from "./catalog.ts";
import { chooseModel, defaultModel, draftOf, opening, optionsOfDraft, withSettings, withDefaults } from "./draft.ts";

const asked = (provider: string, model: string): Asked => ({ provider: ProviderName.make(provider), model: ModelName.make(model) });
const option = (options: Options, name: keyof ModelSettings) => options.offered.find((each) => each.name === name);

test("choosing another model keeps the settings as given, and the options follow the new model: an effort it does not accept shows as the nearest it does", async () => {
  // gpt-6.1-sol takes effort max; gpt-5.5 goes no higher than xhigh.
  const before = draftOf({ model: asked("openai", "gpt-6.1-sol"), settings: { effort: "max", cache: "1h" } });
  const after = chooseModel(before, asked("openai", "gpt-5.5"));
  expect(after.settings).toEqual({ effort: "max", cache: "1h" });
  const [shownBefore, shownAfter] = await runTest(Effect.all([optionsOfDraft(before), optionsOfDraft(after)]));
  expect(option(shownBefore, "effort") as unknown).toEqual({ _tag: "OneOf", name: "effort", now: "max", values: ["default", "low", "medium", "high", "xhigh", "max"] });
  expect([shownAfter.model, shownAfter.settings]).toEqual([ModelName.make("gpt-5.5"), { effort: "max", cache: "1h" }]);
  expect(option(shownAfter, "effort") as unknown).toEqual({ _tag: "OneOf", name: "effort", now: "xhigh", values: ["default", "low", "medium", "high", "xhigh"] });
});

test("settings given anew replace the ones they name, default removes one, and a setting not named keeps its value", () => {
  const draft = draftOf({ model: asked("anthropic", "claude-sonnet-5-5"), settings: { effort: "high", thinking: "between_tools", observe: "all" } });
  expect(withSettings(draft, { effort: "low", cache: "5m", observe: "default" }).settings).toEqual({ effort: "low", thinking: "between_tools", cache: "5m" });
  // A draft made with nothing but its model says no setting, and has no system prompt and no tools.
  expect(draftOf({ model: asked("anthropic", "claude-opus-5-5") })).toEqual({ model: asked("anthropic", "claude-opus-5-5"), settings: {}, system: undefined, tools: [] });
});

const services = Layer.mergeAll(
  ModelFromFacts,
  BoringContextAssembler,
  CountingTurns,
  EphemeralSessionStore,
  Layer.succeed(ModelClient, { respond: () => Effect.die("no request") }),
  Layer.succeed(ToolRunner, { run: () => Effect.die("no tools") }),
);

const look: ToolSpec = { name: ToolName.make("look"), description: "Reads a file.", input: { type: "object" }, kind: "read", replay: "safe" };

test("a session opened with the draft asks its model with its settings, has its system prompt and tools, and shows the draft's options", async () => {
  const draft = draftOf({
    model: asked("anthropic", "claude-opus-5-5"),
    settings: { thinking: "disabled", effort: "max", maxOutputTokens: TokenCount.make(4000) },
    system: "Be brief.",
    tools: [look],
  });
  const [model, system, tools, fromFacts, shown] = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(opening(draft, SessionId.make("s1")));
      yield* session.idle;
      const facts = yield* session.facts;
      return [yield* modelOf(facts), immutableSystemPromptOf(facts), yield* immutableToolCatalogOf(facts), yield* optionsOf(facts), yield* optionsOfDraft(draft)] as const;
    }).pipe(Effect.provide(services)),
  );
  expect(model).toEqual({ ...draft.model, settings: draft.settings });
  expect([system, tools]).toEqual(["Be brief.", [look]]);
  expect(fromFacts).toEqual(shown);
});

test("a draft with no setting, system prompt or tool opens a session with none", async () => {
  const draft = draftOf({ model: asked("openai", "gpt-5.5") });
  const [model, system, tools] = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(opening(draft, SessionId.make("s1")));
      yield* session.idle;
      const facts = yield* session.facts;
      return [yield* modelOf(facts), immutableSystemPromptOf(facts), yield* immutableToolCatalogOf(facts)] as const;
    }).pipe(Effect.provide(services)),
  );
  expect([model, system, tools]).toEqual([draft.model, undefined, []]);
});

test("an output limit that is not given defaults to the model's own, or 32768 tokens when that is not known; a limit that is given stays", () => {
  const limitOf = (provider: string, model: string, settings?: ModelSettings) =>
    withDefaults(draftOf({ model: asked(provider, model), settings: { effort: "high", ...settings } }), capabilitiesOf(provider, model)).settings;
  // claude-opus-5-5 writes up to 128000 tokens; gpt-5.2-chat-latest up to 16384; nothing is known of the local model.
  expect(limitOf("anthropic", "claude-opus-5-5")).toEqual({ effort: "high", maxOutputTokens: TokenCount.make(128_000) });
  expect(limitOf("openai", "gpt-5.2-chat-latest")).toEqual({ effort: "high", maxOutputTokens: TokenCount.make(16384) });
  expect(limitOf("localhost", "qwen")).toEqual({ effort: "high", maxOutputTokens: TokenCount.make(32768) });
  expect(limitOf("anthropic", "claude-opus-5-5", { maxOutputTokens: TokenCount.make(100000) })).toEqual({ effort: "high", maxOutputTokens: TokenCount.make(100000) });
});

const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });
const source = (provider: string, models: ReadonlyArray<string> | undefined): CatalogSource => ({
  provider: ProviderName.make(provider),
  models: models?.map((model) => ModelName.make(model)),
});

test("the model a draft starts with is the first that the catalog lists; a catalog that lists none returns none", async () => {
  const first = await runTest(defaultModel.pipe(Effect.provide(catalogOf([source("lan", undefined), source("anthropic", ["claude-a", "claude-b"]), source("localhost", ["qwen"])]))));
  // The first source did not answer, so it lists nothing.
  expect(first).toEqual(asked("anthropic", "claude-a"));
  expect(await runTest(defaultModel.pipe(Effect.provide(catalogOf([source("lan", undefined), source("localhost", [])]))))).toBeUndefined();
});
