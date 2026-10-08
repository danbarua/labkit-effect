/** A model's settings as a type, for the well-known models, and as choices, for one known at run time. */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect } from "effect";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import { capabilitiesOf, effortsTaken, knownCapabilities, KnownModels, type ModelOverride, type SettingsFor, turnsThinkingOff, catalogued, withOverrides } from "./well-known-models.ts";

test("a well-known model's settings type takes the efforts it takes, thinking disabled only where it can turn thinking off, and between_tools where it was measured", () => {
  // grok-4.7 takes low to xhigh, as models.dev lists it: no max, and no none, so thinking cannot be disabled.
  const grok: SettingsFor<"xai", "grok-4.7"> = { effort: "xhigh" };
  // @ts-expect-error grok-4.7 does not take max
  const tooHigh: SettingsFor<"xai", "grok-4.7"> = { effort: "max" };
  // @ts-expect-error grok-4.7 does not take none, so thinking cannot be disabled
  const noOff: SettingsFor<"xai", "grok-4.7"> = { thinking: "disabled" };
  // gpt-5.6-sol takes none to max.
  const sol: SettingsFor<"openai", "gpt-5.6-sol"> = { effort: "max", thinking: "disabled" };
  // gpt-5-pro takes only high.
  const pro: SettingsFor<"openai", "gpt-5-pro"> = { effort: "high" };
  // @ts-expect-error gpt-5-pro takes only high
  const proLow: SettingsFor<"openai", "gpt-5-pro"> = { effort: "low" };
  // claude-sonnet-5-5 was measured to think only between tool calls; claude-fable-5-1 was not.
  const sonnet: SettingsFor<"anthropic", "claude-sonnet-5-5"> = { effort: "max", thinking: "between_tools" };
  // @ts-expect-error claude-fable-5-1 does not take none, so thinking cannot be disabled
  const fableOff: SettingsFor<"anthropic", "claude-fable-5-1"> = { thinking: "disabled" };
  // claude-haiku-4-5 takes a budget, which each effort but minimal is sent as, and can turn its thinking off.
  const haiku: SettingsFor<"anthropic", "claude-haiku-4-5"> = { effort: "max", thinking: "disabled" };
  // @ts-expect-error claude-haiku-4-5 takes no minimal effort
  const haikuEffort: SettingsFor<"anthropic", "claude-haiku-4-5"> = { effort: "minimal" };
  // gpt-5.3-chat-latest does not reason: models.dev lists no efforts for it, so the type takes any.
  const chat: SettingsFor<"openai", "gpt-5.3-chat-latest"> = { effort: "low" };
  expect([grok, tooHigh, noOff, sol, pro, proLow, sonnet, fableOff, haiku, haikuEffort, chat]).toHaveLength(11);
});

test("what a model takes is read from what is known of it: its efforts other than none, and whether it can turn its thinking off", () => {
  expect(effortsTaken(capabilitiesOf("openai", "gpt-5.5"))).toEqual(["low", "medium", "high", "xhigh"]);
  expect(turnsThinkingOff(capabilitiesOf("openai", "gpt-5.5"))).toBe(true);
  expect(turnsThinkingOff(capabilitiesOf("openai", "gpt-5"))).toBe(false);
  // Haiku 4.5 takes a budget, which its adapter sends each effort but minimal as; its thinking is off unless an effort turns it on.
  expect(effortsTaken(capabilitiesOf("anthropic", "claude-haiku-4-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(turnsThinkingOff(capabilitiesOf("anthropic", "claude-haiku-4-5"))).toBe(true);
  // A model that does not reason takes no effort, and has no thinking to turn off.
  expect(effortsTaken(capabilitiesOf("openai", "gpt-5.3-chat-latest"))).toEqual([]);
  expect(turnsThinkingOff(capabilitiesOf("openai", "gpt-5.3-chat-latest"))).toBe(false);
  // Of a model nothing is known of, neither is known.
  expect(effortsTaken(undefined)).toBeUndefined();
  expect(turnsThinkingOff(undefined)).toBeUndefined();
});

test("a user's override of a model replaces the fields it gives and keeps the rest; a model no source knows takes the override alone; other models are as known", async () => {
  const overrides = new Map<string, ModelOverride>([
    ["xai/grok-4.7", { efforts: ["minimal", "low", "medium", "high", "xhigh"] }],
    ["localhost/qwen", { context: 32768, output: 8192 }],
  ]);
  const known = (provider: string, model: string) =>
    Effect.runPromise(knownCapabilities(ProviderName.make(provider), ModelName.make(model)).pipe(Effect.provideService(KnownModels, withOverrides(overrides, [catalogued]))));
  expect((await known("xai", "grok-4.7")) as unknown).toEqual({ ...capabilitiesOf("xai", "grok-4.7"), efforts: ["minimal", "low", "medium", "high", "xhigh"] });
  expect(await known("localhost", "qwen")).toEqual({ input: [], price: { input: 0, output: 0 }, context: 32768, output: 8192 });
  expect(await known("xai", "grok-4.6")).toEqual(capabilitiesOf("xai", "grok-4.6"));
  expect(await known("localhost", "other")).toBeUndefined();
});

test("a model that is not well-known is known by what models.dev's catalog says of it; a model that neither lists is not known", () => {
  expect(capabilitiesOf("anthropic", "claude-sonnet-4-5")).toMatchObject({ reasoning: true, budget: { min: 1024 }, output: 64000 });
  expect(effortsTaken(capabilitiesOf("anthropic", "claude-sonnet-4-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  // The catalog's toggle (reasoning switched off) is the effort none, so the model can turn its thinking off.
  expect(capabilitiesOf("anthropic", "claude-sonnet-5")?.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  expect(turnsThinkingOff(capabilitiesOf("anthropic", "claude-sonnet-5"))).toBe(true);
  expect(capabilitiesOf("anthropic", "claude-unknown-9")).toBeUndefined();
});
