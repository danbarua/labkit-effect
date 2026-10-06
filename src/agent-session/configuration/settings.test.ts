/**
 * A session's settings: how each provider's adapter puts them into a request for a model, what it
 * translates where the model does not take what was given, and how a session's facts give them.
 */

import { type Capabilities, capabilitiesOf, type KnownEffort } from "./well-known-models.ts";
import { afterAll, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ModelName, ProviderName, SessionId, TokenCount } from "../../agent-machine/names.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import { changed, type ModelSettings } from "../../agent-machine/settings.ts";
import { openSession, type Session } from "../loop.ts";
import { EphemeralSessionStore } from "../session-store.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { AnthropicModelClient } from "../providers/anthropic-client.ts";
import { anthropicSettings, anthropicSettle } from "../providers/anthropic-settings.ts";
import { openAiCompatSettings, openAiCompatSettle } from "../providers/openai-compat-settings.ts";
import { openAiSettings, openAiSettle } from "../providers/openai-settings.ts";
import { xAiSettings, xAiSettle } from "../providers/xai-settings.ts";
import { choicesFor, effortFor } from "./settings.ts";
import { sentIn } from "../sent.ts";
import { modelOf, openedWith } from "./session-setup.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { CountingTurns } from "../turns.ts";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { anthropicAt } from "../../../tests/support/providers.ts";
import { anthropicStream } from "../../../tests/support/streams.ts";
import { runTest } from "../../../tests/support/run.ts";
import { SmolToolRunner } from "../../../tests/support/smol-tools.ts";
import { test } from "../../../tests/support/test.ts";

/** What is known of a well-known model. */
const known = (provider: string, model: string) => capabilitiesOf(provider, model);
/** What is known of a model that takes `efforts` and nothing more is known of. */
const taking = (efforts: ReadonlyArray<KnownEffort>): Capabilities => ({ input: [], efforts, price: { input: 0, output: 0 } });
/** What is known of an OpenAI model. */
const gpt = (model: string) => known("openai", model);
const anthropic = (model: string, settings: ModelSettings) => anthropicSettings(settings, known("anthropic", model));

test("Anthropic: nothing said sends nothing; what is said goes into thinking and output_config", () => {
  expect(anthropic("claude-opus-5-5", {})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(anthropic("claude-opus-5-5", { observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } },
    headers: {},
    adjusted: [],
  });
  // Asking to observe says nothing of when to think: the model thinks as it does by default.
  expect(anthropic("claude-opus-5-5", { observe: "off" }).fields).toEqual({ thinking: { type: "adaptive", display: "omitted" } });
});

test("Anthropic: observing progress only needs the display-updates beta", () => {
  expect(anthropic("claude-fable-5-1", { observe: "progress_only" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "updates" } },
    headers: { "anthropic-beta": "thinking-display-updates-2026-08-18" },
    adjusted: [],
  });
});

test("Anthropic: a model that cannot turn its thinking off is sent nothing for disabled, and a model not measured to think between tool calls nothing for between_tools; each is recorded", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"])
    expect(anthropic(model, { thinking: "disabled" })).toEqual({
      fields: {},
      headers: {},
      adjusted: [{ adjusted: { _tag: "Thinking", asked: "disabled" }, reason: "this model's thinking cannot be disabled" }],
    });
  expect(anthropic("claude-opus-5-5", { thinking: "between_tools" })).toEqual({
    fields: {},
    headers: {},
    adjusted: [{ adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: "this model has no between-tools thinking" }],
  });
});

test("Anthropic: Sonnet 5.5 thinks between tool calls, which takes no display and is not taken above high effort", () => {
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", observe: "off" })).toEqual({
    fields: { thinking: { type: "between_tools" } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Observe", asked: "off", used: "progress_only" }, reason: "between-tools thinking always returns progress updates as text" }],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "between_tools" }, output_config: { effort: "high" } },
    headers: {},
    adjusted: [],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", effort: "max" })).toEqual({
    fields: { output_config: { effort: "max" } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: "between-tools thinking is not available at max effort" }],
  });
});

test("Anthropic: Haiku 4.5 takes a thinking budget in place of an effort: each effort is sent as a budget, from its least, 1024 tokens, to below its output limit", () => {
  const budgetOf = (settings: ModelSettings) => anthropic("claude-haiku-4-5", settings).fields["thinking"];
  expect(anthropic("claude-haiku-4-5", { effort: "high" })).toEqual({ fields: { thinking: { type: "enabled", budget_tokens: 16384 } }, headers: {}, adjusted: [] });
  expect([budgetOf({ effort: "low" }), budgetOf({ effort: "medium" }), budgetOf({ effort: "xhigh" })]).toEqual([
    { type: "enabled", budget_tokens: 1024 },
    { type: "enabled", budget_tokens: 4096 },
    { type: "enabled", budget_tokens: 32768 },
  ]);
  // max is the largest budget the request allows: below max_tokens, the output limit given, else the model's, 64,000.
  expect(budgetOf({ effort: "max" })).toEqual({ type: "enabled", budget_tokens: 63_999 });
  expect(budgetOf({ effort: "high", maxOutputTokens: TokenCount.make(8000) })).toEqual({ type: "enabled", budget_tokens: 7999 });
  expect(budgetOf({ effort: "medium", observe: "all" })).toEqual({ type: "enabled", budget_tokens: 4096, display: "summarized" });
  // minimal is not taken: it is sent as low.
  expect(anthropic("claude-haiku-4-5", { effort: "minimal" })).toEqual({
    fields: { thinking: { type: "enabled", budget_tokens: 1024 } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "minimal", used: "low" }, reason: "the nearest effort this model supports (low, medium, high, xhigh, max)" }],
  });
});

test("Anthropic: Haiku 4.5 does not think when no budget fits below its output limit", () => {
  expect(anthropic("claude-haiku-4-5", { effort: "low", maxOutputTokens: TokenCount.make(1024) })).toEqual({
    fields: {},
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "low" }, reason: "the smallest thinking budget (1024 tokens) does not fit under the output limit (1024 tokens)" }],
  });
});

test("OpenAI: a model that does not reason is sent no effort, and no thinking off", () => {
  expect(openAiSettings({ effort: "high", thinking: "disabled" }, gpt("gpt-5.3-chat-latest"))).toEqual({
    fields: {},
    headers: {},
    adjusted: [
      { adjusted: { _tag: "Thinking", asked: "disabled" }, reason: "this model does not reason" },
      { adjusted: { _tag: "Effort", asked: "high" }, reason: "this model has no effort setting" },
    ],
  });
});

test("Anthropic: Haiku 4.5 can turn its thinking off, and thinks only when an effort is given", () => {
  expect(anthropic("claude-haiku-4-5", { thinking: "disabled", effort: "high" })).toEqual({
    fields: { thinking: { type: "disabled" } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "high" }, reason: "not sent while thinking is disabled" }],
  });
  expect(anthropic("claude-haiku-4-5", { observe: "all" })).toEqual({
    fields: {},
    headers: {},
    adjusted: [{ adjusted: { _tag: "Observe", asked: "all" }, reason: "this model thinks only when an effort is set" }],
  });
});

test("Anthropic: an output limit above the model's, which the API refuses, is sent as the model's own", () => {
  expect(anthropic("claude-haiku-4-5", { maxOutputTokens: TokenCount.make(128_000) })).toEqual({
    fields: { max_tokens: 64_000 },
    headers: {},
    adjusted: [{ adjusted: { _tag: "MaxOutputTokens", asked: 128_000, used: 64_000 }, reason: "this model's output limit is 64000 tokens" }],
  } as never);
  expect(anthropic("claude-haiku-4-5", { maxOutputTokens: TokenCount.make(8000) })).toEqual({ fields: {}, headers: {}, adjusted: [] });
});

test("Anthropic: a model of which nothing is known is sent each value as given", () => {
  expect(anthropicSettings({ thinking: "disabled", effort: "max" }).fields).toEqual({ thinking: { type: "disabled" }, output_config: { effort: "max" } });
  expect(anthropicSettings({ thinking: "between_tools" }).fields).toEqual({ thinking: { type: "between_tools" } });
});

test("OpenAI: effort and a summary go into reasoning; disabled is effort none where the model lists it; between tool calls cannot be said", () => {
  expect(openAiSettings({})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(openAiSettings({ observe: "all", effort: "xhigh" })).toEqual({ fields: { reasoning: { effort: "xhigh", summary: "auto" } }, headers: {}, adjusted: [] });
  expect(openAiSettings({ thinking: "disabled", effort: "high" }, gpt("gpt-5.5"))).toEqual({
    fields: { reasoning: { effort: "none" } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "high" }, reason: "not sent while thinking is disabled" }],
  });
  // gpt-5 lists no none: thinking stays on, and the effort is sent as the nearest it takes.
  expect(openAiSettings({ thinking: "disabled", effort: "xhigh" }, gpt("gpt-5"))).toEqual({
    fields: { reasoning: { effort: "high" } },
    headers: {},
    adjusted: [
      { adjusted: { _tag: "Thinking", asked: "disabled" }, reason: "this model's reasoning cannot be disabled" },
      { adjusted: { _tag: "Effort", asked: "xhigh", used: "high" }, reason: "the nearest effort this model supports (minimal, low, medium, high)" },
    ],
  });
  expect(openAiSettings({ thinking: "between_tools" }).adjusted).toEqual([
    { adjusted: { _tag: "Thinking", asked: "between_tools" }, reason: "OpenAI has no between-tools thinking" },
  ]);
});

test("an effort the model does not take is sent as the nearest it takes, the higher of two as near", () => {
  expect(openAiSettings({ effort: "medium" }, taking(["low", "high"])).fields).toEqual({ reasoning: { effort: "high" } });
  expect(effortFor("high", [])).toEqual({ sent: undefined, adjusted: [{ adjusted: { _tag: "Effort", asked: "high" }, reason: "this model has no effort setting" }] });
  expect(effortFor("high", undefined)).toEqual({ sent: "high", adjusted: [] });
});

test("OpenAI: the adjustments are the cache's, then thinking's, then effort's", () => {
  const { adjusted } = openAiSettings({ cache: "off", thinking: "between_tools", effort: "max" }, taking(["low", "medium", "high"]));
  expect(adjusted.map((each) => each.adjusted._tag)).toEqual(["Cache", "Thinking", "Effort"]);
});

test("the cache: Anthropic marks the request for five minutes or an hour, OpenAI keeps it 24 hours when asked for an hour and cannot turn it off", () => {
  expect(anthropic("claude-sonnet-5-5", { cache: "off" }).fields).toEqual({});
  expect(anthropic("claude-sonnet-5-5", { cache: "5m" }).fields).toEqual({ cache_control: { type: "ephemeral" } });
  expect(anthropic("claude-sonnet-5-5", { cache: "1h" }).fields).toEqual({ cache_control: { type: "ephemeral", ttl: "1h" } });
  expect(openAiSettings({ cache: "5m" })).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(openAiSettings({ cache: "1h" })).toEqual({ fields: { prompt_cache_retention: "24h" }, headers: {}, adjusted: [] });
  expect(openAiSettings({ cache: "off" }).adjusted).toEqual([
    {
      adjusted: { _tag: "Cache", asked: "off", used: "5m" },
      reason: "OpenAI always caches long requests for a few minutes",
    },
  ]);
  expect(openAiCompatSettings({ cache: "1h" }).adjusted).toEqual([
    { adjusted: { _tag: "Cache", asked: "1h" }, reason: "Chat Completions has no field for this setting" },
  ]);
});

// grok-4.7 takes low to xhigh, as models.dev lists it.
const grok = known("xai", "grok-4.7");

test("xAI: effort goes into reasoning, max as xhigh, the nearest grok takes; the summary always comes back; the cache and its retention cannot be set", () => {
  expect(xAiSettings({}, grok)).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(xAiSettings({ observe: "all", effort: "high", maxOutputTokens: TokenCount.make(2000) }, grok)).toEqual({
    fields: { reasoning: { effort: "high" }, max_output_tokens: 2000 },
    headers: {},
    adjusted: [],
  });
  expect(xAiSettings({ effort: "max", observe: "off" }, grok)).toEqual({
    fields: { reasoning: { effort: "xhigh" } },
    headers: {},
    adjusted: [
      { adjusted: { _tag: "Observe", asked: "off", used: "all" }, reason: "xAI always returns the reasoning summary" },
      { adjusted: { _tag: "Effort", asked: "max", used: "xhigh" }, reason: "the nearest effort this model supports (low, medium, high, xhigh)" },
    ],
  });
  for (const cache of ["off", "5m", "1h"] as const)
    expect(xAiSettings({ cache }, grok)).toEqual({
      fields: {},
      headers: {},
      adjusted: [{ adjusted: { _tag: "Cache", asked: cache }, reason: "xAI always caches requests, and has no cache setting" }],
    });
});

test("xAI: grok lists no effort none, so disabled is not sent and recorded; an effort given beside it is sent", () => {
  expect(xAiSettings({ thinking: "disabled", effort: "high" }, grok)).toEqual({
    fields: { reasoning: { effort: "high" } },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Thinking", asked: "disabled" }, reason: "this model's reasoning cannot be disabled" }],
  });
});

test("OpenAI: an effort a model does not accept is sent as the nearest it does, the higher of two as near, and adjusted", () => {
  expect(openAiSettings({ effort: "xhigh" }, gpt("gpt-5")).fields).toEqual({ reasoning: { effort: "high" } });
  // gpt-5-pro takes only high; the 5.5 pro takes medium to xhigh, so low goes up to medium and max down to xhigh.
  expect(openAiSettings({ effort: "low" }, gpt("gpt-5-pro")).adjusted).toEqual([
    { adjusted: { _tag: "Effort", asked: "low", used: "high" }, reason: "the nearest effort this model supports (high)" },
  ]);
  expect(openAiSettings({ effort: "low" }, gpt("gpt-5.5-pro")).fields).toEqual({ reasoning: { effort: "medium" } });
  expect(openAiSettings({ effort: "max" }, gpt("gpt-5.5")).fields).toEqual({ reasoning: { effort: "xhigh" } });
  // What a model accepts is sent as asked; a model with no list is sent what was asked.
  expect(openAiSettings({ thinking: "disabled" }, gpt("gpt-5.5"))).toEqual({ fields: { reasoning: { effort: "none" } }, headers: {}, adjusted: [] });
  expect(openAiSettings({ effort: "max" }).fields).toEqual({ reasoning: { effort: "max" } });
});

test("Chat Completions: the effort is sent as reasoning_effort, none for thinking disabled, and the output limit as max_tokens; the other settings are adjusted as not sent", () => {
  expect(openAiCompatSettings({})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(openAiCompatSettings({ effort: "high" })).toEqual({ fields: { reasoning_effort: "high" }, headers: {}, adjusted: [] });
  expect(openAiCompatSettings({ thinking: "disabled", effort: "low" })).toEqual({
    fields: { reasoning_effort: "none" },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "low" }, reason: "not sent while thinking is disabled" }],
  });
  // A model with no list of efforts is sent what was asked; one with a list, the nearest it takes.
  expect(openAiCompatSettings({ effort: "max" }).fields).toEqual({ reasoning_effort: "max" });
  expect(openAiCompatSettings({ effort: "max" }, taking(["none", "low", "medium", "high", "xhigh"])).fields).toEqual({ reasoning_effort: "xhigh" });
  // The output limit is sent as max_tokens.
  expect(openAiCompatSettings({ observe: "all", maxOutputTokens: TokenCount.make(2000) }) as unknown).toEqual({
    fields: { max_tokens: 2000 },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Observe", asked: "all" }, reason: "Chat Completions has no field for this setting" }],
  });
});

test("a change of settings names each setting it changes: default removes one, and one not named keeps its value", () => {
  expect(changed({ effort: "high", observe: "all" }, { effort: "default", thinking: "disabled" })).toEqual({ observe: "all", thinking: "disabled" });
  expect(changed({ effort: "high" }, {})).toEqual({ effort: "high" });
});

test("a session's settings are each as last said: by its opening, or by a change of model taken", async () => {
  const session = open();
  observe(session, { ...opened, model: { ...opened.model, settings: { thinking: "disabled", observe: "all" } } });
  expect(await Effect.runPromise(modelOf(session.journal))).toEqual({
    provider: "boring",
    model: "boring-1",
    settings: { thinking: "disabled", observe: "all" },
  } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "other", model: "other-1", settings: { effort: "high", thinking: "default" } });
  observe(session, { _tag: "ModelChangeArrived", provider: "third", model: "third-1" });
  expect(await Effect.runPromise(modelOf(session.journal))).toEqual({
    provider: "third",
    model: "third-1",
    settings: { observe: "all", effort: "high" },
  } as never);
});

test("what a model adjusted is its setting from then on; what was said stands for another model, and saying it again puts the adjustment aside", async () => {
  const session = open();
  const settingsNow = async () => (await Effect.runPromise(modelOf(session.journal))).settings;
  observe(session, { ...opened, model: { provider: "openai", model: "gpt-5", settings: { effort: "max", observe: "all" } } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingAdjusted",
    turn: "turn-1",
    provider: "openai",
    model: "gpt-5",
    adjusted: { _tag: "Effort", asked: "max", used: "high" },
    reason: "the nearest effort this model supports (minimal, low, medium, high)",
  });
  expect(await settingsNow()).toEqual({ effort: "high", observe: "all" } as never);
  // Another model is asked what was said: max.
  observe(session, { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5.5" });
  observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "down", error: { mediaType: "text/plain", body: { _tag: "Text", text: "down" } } });
  expect(await settingsNow()).toEqual({ effort: "max", observe: "all" } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5" });
  expect(await settingsNow()).toEqual({ effort: "high", observe: "all" } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "openai", model: "gpt-5", settings: { effort: "max" } });
  expect(await settingsNow()).toEqual({ effort: "max", observe: "all" } as never);
});

test("a setting adjusted with nothing used in its place is no longer sent to that model", async () => {
  const session = open();
  observe(session, { ...opened, model: { ...opened.model, settings: { thinking: "disabled", effort: "high" } } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingAdjusted",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    adjusted: { _tag: "Effort", asked: "high" },
    reason: "not sent while thinking is disabled",
  });
  expect((await Effect.runPromise(modelOf(session.journal))).settings).toEqual({ thinking: "disabled" } as never);
});

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

test("settings carried over a change of model are translated for each model, recorded once for it, and sent as given again to a model that takes them", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      return anthropicStream({ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn" });
    },
  });
  stops.push(() => server.stop(true));
  const ask = (session: Session, text: string) =>
    session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text } as unknown as Observation).pipe(Effect.andThen(session.idle));
  const switchTo = (session: Session, model: string) =>
    session.observe({ _tag: "ModelChangeArrived", provider: "anthropic", model } as unknown as Observation).pipe(Effect.andThen(session.idle));
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
      yield* session.observe(
        openedWith({
          session: SessionId.make("s1"),
          model: {
            provider: ProviderName.make("anthropic"),
            model: ModelName.make("claude-opus-5-5"),
            settings: { thinking: "disabled", observe: "all", effort: "high", maxOutputTokens: TokenCount.make(128_000) },
          },
          system: undefined,
          tools: [],
        }),
      );
      yield* session.idle;
      yield* ask(session, "Hello");
      yield* ask(session, "Again");
      yield* switchTo(session, "claude-haiku-4-5");
      yield* ask(session, "Hello, Haiku");
      yield* ask(session, "Again, Haiku");
      yield* switchTo(session, "claude-opus-5-5");
      yield* ask(session, "Hello again, Opus");
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
          CountingTurns,
          SmolToolRunner,
        ),
      ),
    ),
  );
  // Opus cannot turn its thinking off, so it thinks as it does by default, with the effort and output limit given.
  const opus = { model: "claude-opus-5-5", max_tokens: 128_000, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } };
  // Haiku can: it is sent thinking off, no effort, and its own output limit.
  const haiku = { model: "claude-haiku-4-5", max_tokens: 64_000, thinking: { type: "disabled" } };
  expect(bodies).toHaveLength(5);
  expect(bodies.map((body) => body["model"])).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-haiku-4-5", "claude-opus-5-5"]);
  for (const at of [0, 1, 4]) expect(bodies[at]).toMatchObject(opus);
  for (const at of [2, 3]) {
    expect(bodies[at]).toMatchObject(haiku);
    expect(bodies[at]?.["output_config"]).toBeUndefined();
  }
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact] : []));
  // Each translation is recorded once, before the first request to the model it was made for, by the harness.
  const adjusted = observed.flatMap((fact) => (fact.observation._tag === "SettingAdjusted" ? [fact] : []));
  expect(adjusted.map(({ observation }) => (observation._tag === "SettingAdjusted" ? [observation.model, observation.adjusted] : [])) as unknown).toEqual([
    ["claude-opus-5-5", { _tag: "Thinking", asked: "disabled" }],
    ["claude-haiku-4-5", { _tag: "MaxOutputTokens", asked: 128_000, used: 64_000 }],
    ["claude-haiku-4-5", { _tag: "Effort", asked: "high" }],
  ]);
  expect(adjusted[0] as unknown).toMatchObject({ origin: { _tag: "Harness", part: "model settings" }, observation: { turn: "turn-1", reason: "this model's thinking cannot be disabled" } });
  const first = observed.findIndex((fact) => fact.observation._tag === "ModelRequestDispatched");
  expect(observed[first + 1]?.observation._tag).toBe("SettingAdjusted");
  // The request is recorded with what it carried.
  const dispatched = observed[first]?.observation;
  expect(dispatched?._tag === "ModelRequestDispatched" ? sentIn(dispatched.sent) : undefined).toEqual({
    system: undefined,
    tools: [],
    messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }],
  });
  expect(facts.some((fact) => fact._tag === "Decided" && fact.decision._tag === "ObservationNotExpected")).toBe(false);
});

test("the values offered for a setting are the ones the model takes, as the provider's adapter sends them", () => {
  const target = (provider: string, model: string, settings: ModelSettings = {}) => {
    const capabilities = known(provider, model);
    return { provider: ProviderName.make(provider), model: ModelName.make(model), settings, ...(capabilities === undefined ? {} : { capabilities }) };
  };
  // gpt-5.5 lists effort none, so it can turn its thinking off; OpenAI cannot be asked not to cache.
  expect(choicesFor(target("openai", "gpt-5.5"), openAiSettle)).toEqual({
    effort: ["low", "medium", "high", "xhigh"],
    thinking: ["disabled"],
    observe: ["all", "progress_only", "off"],
    cache: ["5m", "1h"],
    maxOutputTokens: true,
  });
  // xAI has no setting for the cache, always returns its reasoning's summary, and grok-4.7 lists no effort none.
  expect(choicesFor(target("xai", "grok-4.7"), xAiSettle)).toEqual({ effort: ["low", "medium", "high", "xhigh"], thinking: [], observe: ["all"], cache: [], maxOutputTokens: true });
  expect(choicesFor(target("anthropic", "claude-sonnet-5-5"), anthropicSettle)).toMatchObject({ thinking: ["between_tools"], cache: ["off", "5m", "1h"] });
  // Haiku 4.5 takes a budget, which each effort but minimal is sent as, and can turn its thinking off.
  expect(choicesFor(target("anthropic", "claude-haiku-4-5"), anthropicSettle)).toMatchObject({ effort: ["low", "medium", "high", "xhigh", "max"], thinking: ["disabled"] });
  // The Chat Completions adapter sends the effort and the output limit; a model nothing is known of is offered every effort.
  expect(choicesFor(target("localhost", "some-model"), openAiCompatSettle)).toEqual({
    effort: ["minimal", "low", "medium", "high", "xhigh", "max"],
    thinking: ["disabled"],
    observe: [],
    cache: [],
    maxOutputTokens: true,
  });
});

test("what is offered for one setting follows the others in force", () => {
  const target = (settings: ModelSettings) => ({ provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5"), settings });
  // Sonnet 5.5 does not think only between tool calls above high effort.
  expect(choicesFor(target({ effort: "max" }), anthropicSettle).thinking).toEqual([]);
  // With thinking disabled, the effort sent is `none`: an effort given beside it is not sent.
  const gpt = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5"), settings: { thinking: "disabled" as const } };
  expect(choicesFor(gpt, openAiSettle).effort).toEqual([]);
});
