/**
 * A session's settings: how each provider's adapter puts them into a request for a model, what it
 * adjusts where the model does not allow what was asked, and how a session's facts give them.
 */

import { capabilitiesOf } from "./well-known-models.ts";
import { afterAll, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ModelName, ProviderName, SessionId, TokenCount } from "../../agent-machine/names.ts";
import type { Observation } from "../../agent-machine/observation.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { openSession } from "../loop.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { AnthropicModelClient } from "../providers/anthropic-client.ts";
import { anthropicSettings, anthropicSettle } from "../providers/anthropic-settings.ts";
import { openAiCompatSettings, openAiCompatSettle } from "../providers/openai-compat-settings.ts";
import { openAiSettings, openAiSettle } from "../providers/openai-settings.ts";
import { xAiSettings, xAiSettle } from "../providers/xai-settings.ts";
import { choicesFor } from "./settings.ts";
import { sentIn } from "../sent.ts";
import { modelOf, openedWith } from "./session-setup.ts";
import { TurnContextAssembler } from "../turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "../turns.ts";
import { observe, open, opened } from "../../../tests/support/drive.ts";
import { anthropicAt } from "../../../tests/support/providers.ts";
import { anthropicStream } from "../../../tests/support/streams.ts";
import { runTest } from "../../../tests/support/run.ts";
import { SmolToolRunner } from "../../../tests/support/smol-tools.ts";
import { test } from "../../../tests/support/test.ts";

const anthropic = (model: string, settings: ModelSettings) => anthropicSettings(ModelName.make(model), settings);

test("Anthropic: nothing said sends nothing; what is said goes into thinking and output_config", () => {
  expect(anthropic("claude-opus-5-5", {})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(anthropic("claude-opus-5-5", { thinking: "auto", observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } },
    headers: {},
    adjusted: [],
  });
  // Asking to observe says nothing of when to think: the model thinks as it sees fit.
  expect(anthropic("claude-opus-5-5", { observe: "off" }).fields).toEqual({ thinking: { type: "adaptive", display: "omitted" } });
});

test("Anthropic: observing progress only needs the display-updates beta", () => {
  expect(anthropic("claude-fable-5-1", { observe: "progress_only" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "updates" } },
    headers: { "anthropic-beta": "thinking-display-updates-2026-08-18" },
    adjusted: [],
  });
});

test("Anthropic: a model that cannot turn thinking off thinks as it sees fit, and that is adjusted", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    expect(anthropic(model, { thinking: "off" })).toEqual({
      fields: { thinking: { type: "adaptive" } },
      headers: {},
      adjusted: [
        { adjusted: { _tag: "Thinking", asked: "off", used: "auto" }, reason: "this model does not allow thinking to be turned off" },
      ],
    });
    expect(anthropic(model, { thinking: "between_tools" }).adjusted).toEqual([
      { adjusted: { _tag: "Thinking", asked: "between_tools", used: "auto" }, reason: "this model has no between-tools thinking" },
    ]);
  }
});

test("Anthropic: Sonnet 5.5's lowest setting is between tools, which takes no display and not above high effort", () => {
  expect(anthropic("claude-sonnet-5-5", { thinking: "off", observe: "off" })).toEqual({
    fields: { thinking: { type: "between_tools" } },
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Thinking", asked: "off", used: "between_tools" },
        reason: "this model does not allow thinking to be turned off; between tools is its lowest setting",
      },
      {
        adjusted: { _tag: "Observe", asked: "off", used: "progress_only" },
        reason: "between-tools thinking returns its progress updates as text",
      },
    ],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "between_tools" }, output_config: { effort: "high" } },
    headers: {},
    adjusted: [],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", effort: "max" })).toEqual({
    fields: { thinking: { type: "adaptive" }, output_config: { effort: "max" } },
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Thinking", asked: "between_tools", used: "auto" },
        reason: "between-tools thinking is not accepted at max effort",
      },
    ],
  });
});

test("Anthropic: no model is made to think before every answer; a model in no class is sent what was asked", () => {
  expect(anthropic("claude-opus-5", { thinking: "before_answer" })).toEqual({
    fields: { thinking: { type: "adaptive" } },
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Thinking", asked: "before_answer", used: "auto" },
        reason: "the Messages API has no setting for thinking before every answer",
      },
    ],
  });
  expect(anthropic("claude-opus-5", { thinking: "off", observe: "all" })).toEqual({
    fields: { thinking: { type: "disabled" } },
    headers: {},
    adjusted: [],
  });
});

test("OpenAI: effort and a summary go into reasoning; off is effort none; when to think cannot be said", () => {
  expect(openAiSettings({})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(openAiSettings({ thinking: "auto", observe: "all", effort: "xhigh" })).toEqual({
    fields: { reasoning: { effort: "xhigh", summary: "auto" } },
    headers: {},
    adjusted: [],
  });
  expect(openAiSettings({ thinking: "off", effort: "high" })).toEqual({
    fields: { reasoning: { effort: "none" } },
    headers: {},
    adjusted: [
      { adjusted: { _tag: "Effort", asked: "high" }, reason: "thinking is off, which is sent as reasoning effort none" },
    ],
  });
  expect(openAiSettings({ thinking: "between_tools", observe: "progress_only" })).toEqual({
    fields: {},
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Thinking", asked: "between_tools", used: "auto" },
        reason: "the Responses API has no setting for when the model thinks",
      },
    ],
  });
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
      reason: "the Responses API caches every long enough request for minutes, and cannot be asked not to",
    },
  ]);
  expect(openAiCompatSettings({ cache: "1h" }).adjusted).toEqual([
    { adjusted: { _tag: "Cache", asked: "1h" }, reason: "the Chat Completions adapter does not send this setting" },
  ]);
});

const grok = capabilitiesOf("xai", "grok-4.7")?.efforts;

test("xAI: effort goes into reasoning, max as xhigh, the nearest grok takes; the summary always comes back; the cache and its retention cannot be set", () => {
  expect(xAiSettings({}, grok)).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(xAiSettings({ thinking: "auto", observe: "all", effort: "high", maxOutputTokens: TokenCount.make(2000) }, grok)).toEqual({
    fields: { reasoning: { effort: "high" }, max_output_tokens: 2000 },
    headers: {},
    adjusted: [],
  });
  expect(xAiSettings({ effort: "max", observe: "off" }, grok)).toEqual({
    fields: { reasoning: { effort: "xhigh" } },
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Observe", asked: "off", used: "all" },
        reason: "xAI returns the reasoning's summary with every response, and cannot be asked not to",
      },
      {
        adjusted: { _tag: "Effort", asked: "max", used: "xhigh" },
        reason: "this model's reasoning efforts are minimal, low, medium, high, xhigh; it is sent xhigh",
      },
    ],
  });
  for (const cache of ["off", "5m", "1h"] as const)
    expect(xAiSettings({ cache }, grok)).toEqual({
      fields: {},
      headers: {},
      adjusted: [
        {
          adjusted: { _tag: "Cache", asked: cache },
          reason: "xAI caches every request for as long as the server keeps it, and has no setting for how long",
        },
      ],
    });
});

test("xAI: thinking off is grok's least effort, minimal, adjusted; an effort said beside it is not sent", () => {
  expect(xAiSettings({ thinking: "off" }, grok)).toEqual({
    fields: { reasoning: { effort: "minimal" } },
    headers: {},
    adjusted: [
      {
        adjusted: { _tag: "Thinking", asked: "off", used: "auto" },
        reason: "this model's reasoning efforts are minimal, low, medium, high, xhigh; it is sent minimal",
      },
    ],
  });
  expect(xAiSettings({ thinking: "off", effort: "high" }, grok)).toMatchObject({
    fields: { reasoning: { effort: "minimal" } },
    adjusted: [{ adjusted: { _tag: "Thinking" } }, { adjusted: { _tag: "Effort", asked: "high" }, reason: "thinking is off, which is sent as reasoning effort minimal" }],
  });
});

test("OpenAI: an effort a model does not accept is sent as the nearest it does, the higher of two as near, and adjusted", () => {
  const efforts = (model: string) => capabilitiesOf("openai", model)?.efforts;
  // gpt-5 takes minimal to high: thinking off is sent as minimal, xhigh as high.
  expect(openAiSettings({ thinking: "off" }, efforts("gpt-5"))).toMatchObject({
    fields: { reasoning: { effort: "minimal" } },
    adjusted: [{ adjusted: { _tag: "Thinking", asked: "off", used: "auto" }, reason: "this model's reasoning efforts are minimal, low, medium, high; it is sent minimal" }],
  });
  expect(openAiSettings({ effort: "xhigh" }, efforts("gpt-5")).fields).toEqual({ reasoning: { effort: "high" } });
  // gpt-5-pro takes only high; the 5.5 pro takes medium to xhigh, so low goes up to medium and max down to xhigh.
  expect(openAiSettings({ effort: "low" }, efforts("gpt-5-pro")).adjusted).toEqual([
    { adjusted: { _tag: "Effort", asked: "low", used: "high" }, reason: "this model's reasoning efforts are high; it is sent high" },
  ]);
  expect(openAiSettings({ effort: "low" }, efforts("gpt-5.5-pro")).fields).toEqual({ reasoning: { effort: "medium" } });
  expect(openAiSettings({ effort: "max" }, efforts("gpt-5.5")).fields).toEqual({ reasoning: { effort: "xhigh" } });
  // gpt-6.1-sol takes no none: thinking off is its least effort, low.
  expect(openAiSettings({ thinking: "off" }, efforts("gpt-6.1-sol")).fields).toEqual({ reasoning: { effort: "low" } });
  // What a model accepts is sent as asked; a model with no list is sent what was asked.
  expect(openAiSettings({ thinking: "off" }, efforts("gpt-5.5"))).toEqual({ fields: { reasoning: { effort: "none" } }, headers: {}, adjusted: [] });
  expect(openAiSettings({ effort: "max" }).fields).toEqual({ reasoning: { effort: "max" } });
});

test("Chat Completions: the effort is sent as reasoning_effort, none for thinking off; the other settings are adjusted as not sent", () => {
  expect(openAiCompatSettings({})).toEqual({ fields: {}, headers: {}, adjusted: [] });
  expect(openAiCompatSettings({ effort: "high", thinking: "auto" })).toEqual({ fields: { reasoning_effort: "high" }, headers: {}, adjusted: [] });
  expect(openAiCompatSettings({ thinking: "off", effort: "low" })).toEqual({
    fields: { reasoning_effort: "none" },
    headers: {},
    adjusted: [{ adjusted: { _tag: "Effort", asked: "low" }, reason: "thinking is off, which is sent as reasoning effort none" }],
  });
  // A model with no list of efforts is sent what was asked; one with a list, the nearest it takes.
  expect(openAiCompatSettings({ effort: "max" }).fields).toEqual({ reasoning_effort: "max" });
  expect(openAiCompatSettings({ effort: "max" }, ["none", "low", "medium", "high", "xhigh"]).fields).toEqual({ reasoning_effort: "xhigh" });
  expect(openAiCompatSettings({ observe: "all", maxOutputTokens: TokenCount.make(2000) }) as unknown).toEqual({
    fields: {},
    headers: {},
    adjusted: [
      { adjusted: { _tag: "Observe", asked: "all" }, reason: "the Chat Completions adapter does not send this setting" },
      { adjusted: { _tag: "MaxOutputTokens", asked: 2000 }, reason: "the Chat Completions adapter does not send this setting" },
    ],
  });
});

test("M2: a session's settings are each as last said: by its opening, or by a change of model taken", async () => {
  const session = open();
  observe(session, { ...opened, model: { ...opened.model, settings: { thinking: "auto", observe: "all" } } });
  expect(await Effect.runPromise(modelOf(session.journal))).toEqual({
    provider: "boring",
    model: "boring-1",
    settings: { thinking: "auto", observe: "all" },
  } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "other", model: "other-1", settings: { effort: "high" } });
  observe(session, { _tag: "ModelChangeArrived", provider: "third", model: "third-1" });
  expect(await Effect.runPromise(modelOf(session.journal))).toEqual({
    provider: "third",
    model: "third-1",
    settings: { thinking: "auto", observe: "all", effort: "high" },
  } as never);
});

test("M3: what a model adjusted is its setting from then on; what was said stands for another model, and saying it again puts the adjustment aside", async () => {
  const session = open();
  const settingsNow = async () => (await Effect.runPromise(modelOf(session.journal))).settings;
  observe(session, {
    ...opened,
    model: { provider: "anthropic", model: "claude-opus-5-5", settings: { thinking: "off", effort: "high" } },
  });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingAdjusted",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-opus-5-5",
    adjusted: { _tag: "Thinking", asked: "off", used: "auto" },
    reason: "this model does not allow thinking to be turned off",
  });
  expect(await settingsNow()).toEqual({ thinking: "auto", effort: "high" } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "anthropic", model: "claude-opus-5" });
  observe(session, { _tag: "ModelFailed", turn: "turn-1", failure: "down", error: { mediaType: "text/plain", body: { _tag: "Text", text: "down" } } });
  expect(await settingsNow()).toEqual({ thinking: "off", effort: "high" } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "anthropic", model: "claude-opus-5-5" });
  expect(await settingsNow()).toEqual({ thinking: "auto", effort: "high" } as never);
  observe(session, { _tag: "ModelChangeArrived", provider: "anthropic", model: "claude-opus-5-5", settings: { thinking: "off" } });
  expect(await settingsNow()).toEqual({ thinking: "off", effort: "high" } as never);
});

test("M3: a setting adjusted with nothing used in its place is no longer sent to that model", async () => {
  const session = open();
  observe(session, { ...opened, model: { ...opened.model, settings: { thinking: "off", effort: "high" } } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingAdjusted",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    adjusted: { _tag: "Effort", asked: "high" },
    reason: "thinking is off",
  });
  expect((await Effect.runPromise(modelOf(session.journal))).settings).toEqual({ thinking: "off" } as never);
});

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

test("M3: a request carries the settings the model allows; what was adjusted is recorded before the first response, and once", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      return anthropicStream({ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn" });
    },
  });
  stops.push(() => server.stop(true));
  const facts = await runTest(
    Effect.gen(function* () {
      const session = yield* openSession;
      yield* session.observe(
        openedWith({
          session: SessionId.make("s1"),
          model: {
            provider: ProviderName.make("anthropic"),
            model: ModelName.make("claude-opus-5-5"),
            settings: { thinking: "off", observe: "all", effort: "high" },
          },
          system: undefined,
          tools: [],
        }),
      );
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "Hello" } as unknown as Observation);
      yield* session.idle;
      yield* session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: "Again" } as unknown as Observation);
      yield* session.idle;
      return yield* session.facts;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ModelFromFacts,
          TurnContextAssembler,
          AnthropicModelClient.pipe(Layer.provide(anthropicAt(new URL("/v1/messages", server.url)))),
          CountingTurns,
          NoTurnEndHooks,
          SmolToolRunner,
        ),
      ),
    ),
  );
  const sent = { model: "claude-opus-5-5", thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } };
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject(sent);
  expect(bodies[1]).toMatchObject(sent);
  const observed = facts.flatMap((fact) => (fact._tag === "Observed" ? [fact] : []));
  expect(observed.map((fact) => fact.observation._tag).slice(3)).toEqual([
    "ModelRequestDispatched",
    "SettingAdjusted",
    "ModelResponded",
    "TurnEndReviewed",
    "InputArrived",
    "TurnStarted",
    "ModelRequestDispatched",
    "ModelResponded",
    "TurnEndReviewed",
  ]);
  const dispatched = observed[3]?.observation;
  expect(dispatched as unknown).toMatchObject({
    _tag: "ModelRequestDispatched",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  // The request is recorded with what it carried.
  expect(dispatched?._tag === "ModelRequestDispatched" ? sentIn(dispatched.sent) : undefined).toEqual({
    system: undefined,
    tools: [],
    messages: [{ role: "user", parts: [{ _tag: "Text", text: "Hello" }] }],
  });
  expect(observed[4] as unknown).toMatchObject({
    origin: { _tag: "Harness", part: "model settings" },
    observation: {
      turn: "turn-1",
      provider: "anthropic",
      model: "claude-opus-5-5",
      adjusted: { _tag: "Thinking", asked: "off", used: "auto" },
      reason: "this model does not allow thinking to be turned off",
    },
  });
  expect(facts.some((fact) => fact._tag === "Decided" && fact.decision._tag === "ObservationNotExpected")).toBe(false);
});

test("the values offered for a setting are the ones the provider's adapter applies as asked", () => {
  const target = (provider: string, model: string, settings: ModelSettings = {}) => {
    const capabilities = capabilitiesOf(provider, model);
    return { provider: ProviderName.make(provider), model: ModelName.make(model), settings, ...(capabilities === undefined ? {} : { capabilities }) };
  };
  // OpenAI cannot be asked not to cache, and has no setting for when a model thinks.
  expect(choicesFor(target("openai", "gpt-5.5"), openAiSettle)).toEqual({
    effort: ["low", "medium", "high", "xhigh"],
    thinking: ["auto", "off"],
    observe: ["all", "progress_only", "off"],
    cache: ["5m", "1h"],
    maxOutputTokens: true,
  });
  // xAI has no setting for the cache, always returns its reasoning's summary, and grok-4.7 takes no effort `none`.
  expect(choicesFor(target("xai", "grok-4.7"), xAiSettle)).toEqual({
    effort: ["low", "medium", "high", "xhigh"],
    thinking: ["auto"],
    observe: ["all"],
    cache: [],
    maxOutputTokens: true,
  });
  expect(choicesFor(target("anthropic", "claude-sonnet-5-5"), anthropicSettle)).toMatchObject({ thinking: ["auto", "between_tools"], cache: ["off", "5m", "1h"] });
  // The Chat Completions adapter sends the effort alone; a model nothing is known of is offered every effort.
  expect(choicesFor(target("localhost", "some-model"), openAiCompatSettle)).toEqual({
    effort: ["low", "medium", "high", "xhigh", "max"],
    thinking: ["auto", "off"],
    observe: [],
    cache: [],
    maxOutputTokens: false,
  });
});

test("what is offered for one setting follows the others in force", () => {
  const target = (settings: ModelSettings) => ({ provider: ProviderName.make("anthropic"), model: ModelName.make("claude-sonnet-5-5"), settings });
  // Sonnet 5.5 does not accept between-tools thinking above high effort.
  expect(choicesFor(target({ effort: "max" }), anthropicSettle).thinking).toEqual(["auto"]);
  // With thinking off, the effort sent is `none`: an effort said beside it would be adjusted.
  const gpt = { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5"), settings: { thinking: "off" as const } };
  expect(choicesFor(gpt, openAiSettle).effort).toEqual([]);
});
