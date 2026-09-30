/**
 * A session's settings: how each provider's adapter puts them into a request for a model, what it
 * enforces where the model does not allow what was asked, and how a session's facts give them.
 */

import { afterAll, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { ModelName, ProviderName, SessionId } from "../agent-core/names.ts";
import type { Observation } from "../agent-core/observation.ts";
import type { ModelSettings } from "../agent-core/settings.ts";
import { openSession } from "./loop.ts";
import { ModelFromFacts } from "./model-choice.ts";
import { AnthropicModelClient } from "./providers/anthropic-client.ts";
import { anthropicSettings } from "./providers/anthropic-settings.ts";
import { openAiCompatSettings } from "./providers/openai-compat-settings.ts";
import { openAiSettings } from "./providers/openai-settings.ts";
import { modelOf, openedWith } from "./session-setup.ts";
import { TurnContextAssembler } from "./turn-context.ts";
import { CountingTurns, NoTurnEndHooks } from "./turns.ts";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { anthropicAt } from "../../tests/support/providers.ts";
import { anthropicStream } from "../../tests/support/streams.ts";
import { runTest } from "../../tests/support/run.ts";
import { SmolToolRunner } from "../../tests/support/smol-tools.ts";
import { test } from "../../tests/support/test.ts";

const anthropic = (model: string, settings: ModelSettings) => anthropicSettings(ModelName.make(model), settings);

test("Anthropic: nothing said sends nothing; what is said goes into thinking and output_config", () => {
  expect(anthropic("claude-opus-5-5", {})).toEqual({ fields: {}, headers: {}, enforced: [] });
  expect(anthropic("claude-opus-5-5", { thinking: "auto", observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } },
    headers: {},
    enforced: [],
  });
  // Asking to observe says nothing of when to think: the model thinks as it sees fit.
  expect(anthropic("claude-opus-5-5", { observe: "off" }).fields).toEqual({ thinking: { type: "adaptive", display: "omitted" } });
});

test("Anthropic: observing progress only needs the display-updates beta", () => {
  expect(anthropic("claude-fable-5-1", { observe: "progress_only" })).toEqual({
    fields: { thinking: { type: "adaptive", display: "updates" } },
    headers: { "anthropic-beta": "thinking-display-updates-2026-08-18" },
    enforced: [],
  });
});

test("Anthropic: a model that cannot turn thinking off thinks as it sees fit, and that is enforced", () => {
  for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    expect(anthropic(model, { thinking: "off" })).toEqual({
      fields: { thinking: { type: "adaptive" } },
      headers: {},
      enforced: [
        { enforced: { _tag: "Thinking", asked: "off", used: "auto" }, reason: "this model does not allow thinking to be turned off" },
      ],
    });
    expect(anthropic(model, { thinking: "between_tools" }).enforced).toEqual([
      { enforced: { _tag: "Thinking", asked: "between_tools", used: "auto" }, reason: "this model has no between-tools thinking" },
    ]);
  }
});

test("Anthropic: Sonnet 5.5's lowest setting is between tools, which takes no display and not above high effort", () => {
  expect(anthropic("claude-sonnet-5-5", { thinking: "off", observe: "off" })).toEqual({
    fields: { thinking: { type: "between_tools" } },
    headers: {},
    enforced: [
      {
        enforced: { _tag: "Thinking", asked: "off", used: "between_tools" },
        reason: "this model does not allow thinking to be turned off; between tools is its lowest setting",
      },
      {
        enforced: { _tag: "Observe", asked: "off", used: "progress_only" },
        reason: "between-tools thinking returns its progress updates as text",
      },
    ],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", observe: "all", effort: "high" })).toEqual({
    fields: { thinking: { type: "between_tools" }, output_config: { effort: "high" } },
    headers: {},
    enforced: [],
  });
  expect(anthropic("claude-sonnet-5-5", { thinking: "between_tools", effort: "max" })).toEqual({
    fields: { thinking: { type: "adaptive" }, output_config: { effort: "max" } },
    headers: {},
    enforced: [
      {
        enforced: { _tag: "Thinking", asked: "between_tools", used: "auto" },
        reason: "between-tools thinking is not accepted at max effort",
      },
    ],
  });
});

test("Anthropic: no model is made to think before every answer; a model in no class is sent what was asked", () => {
  expect(anthropic("claude-opus-5", { thinking: "before_answer" })).toEqual({
    fields: { thinking: { type: "adaptive" } },
    headers: {},
    enforced: [
      {
        enforced: { _tag: "Thinking", asked: "before_answer", used: "auto" },
        reason: "the Messages API has no setting for thinking before every answer",
      },
    ],
  });
  expect(anthropic("claude-opus-5", { thinking: "off", observe: "all" })).toEqual({
    fields: { thinking: { type: "disabled" } },
    headers: {},
    enforced: [],
  });
});

test("OpenAI: effort and a summary go into reasoning; off is effort none; when to think cannot be said", () => {
  expect(openAiSettings({})).toEqual({ fields: {}, headers: {}, enforced: [] });
  expect(openAiSettings({ thinking: "auto", observe: "all", effort: "xhigh" })).toEqual({
    fields: { reasoning: { effort: "xhigh", summary: "auto" } },
    headers: {},
    enforced: [],
  });
  expect(openAiSettings({ thinking: "off", effort: "high" })).toEqual({
    fields: { reasoning: { effort: "none" } },
    headers: {},
    enforced: [
      { enforced: { _tag: "Effort", asked: "high" }, reason: "thinking is off, which the Responses API takes as reasoning effort none" },
    ],
  });
  expect(openAiSettings({ thinking: "between_tools", observe: "progress_only" })).toEqual({
    fields: {},
    headers: {},
    enforced: [
      {
        enforced: { _tag: "Thinking", asked: "between_tools", used: "auto" },
        reason: "the Responses API has no setting for when the model thinks",
      },
    ],
  });
});

test("Chat Completions: no setting is sent, and each one asked for is enforced", () => {
  expect(openAiCompatSettings({ thinking: "off", effort: "low" })).toEqual({
    fields: {},
    headers: {},
    enforced: [
      { enforced: { _tag: "Thinking", asked: "off" }, reason: "the Chat Completions adapter sends no settings" },
      { enforced: { _tag: "Effort", asked: "low" }, reason: "the Chat Completions adapter sends no settings" },
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

test("M3: what a model enforced is its setting from then on; what was said stands for another model, and saying it again puts the enforcement aside", async () => {
  const session = open();
  const settingsNow = async () => (await Effect.runPromise(modelOf(session.journal))).settings;
  observe(session, {
    ...opened,
    model: { provider: "anthropic", model: "claude-opus-5-5", settings: { thinking: "off", effort: "high" } },
  });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingEnforced",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-opus-5-5",
    enforced: { _tag: "Thinking", asked: "off", used: "auto" },
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

test("M3: a setting enforced with nothing used in its place is no longer sent to that model", async () => {
  const session = open();
  observe(session, { ...opened, model: { ...opened.model, settings: { thinking: "off", effort: "high" } } });
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "hello" });
  observe(session, {
    _tag: "SettingEnforced",
    turn: "turn-1",
    provider: "boring",
    model: "boring-1",
    enforced: { _tag: "Effort", asked: "high" },
    reason: "thinking is off",
  });
  expect((await Effect.runPromise(modelOf(session.journal))).settings).toEqual({ thinking: "off" } as never);
});

const stops: Array<() => unknown> = [];
afterAll(() => {
  for (const stop of stops) stop();
});

test("M3: a request carries the settings the model allows; what was enforced is recorded before the first response, and once", async () => {
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
    "SettingEnforced",
    "ModelResponded",
    "TurnEndReviewed",
    "InputArrived",
    "TurnStarted",
    "ModelRequestDispatched",
    "ModelResponded",
    "TurnEndReviewed",
  ]);
  expect(observed[3]?.observation as unknown).toEqual({
    _tag: "ModelRequestDispatched",
    turn: "turn-1",
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  expect(observed[4] as unknown).toMatchObject({
    origin: { _tag: "Harness", part: "model settings" },
    observation: {
      turn: "turn-1",
      provider: "anthropic",
      model: "claude-opus-5-5",
      enforced: { _tag: "Thinking", asked: "off", used: "auto" },
      reason: "this model does not allow thinking to be turned off",
    },
  });
  expect(facts.some((fact) => fact._tag === "Decided" && fact.decision._tag === "ObservationNotExpected")).toBe(false);
});
