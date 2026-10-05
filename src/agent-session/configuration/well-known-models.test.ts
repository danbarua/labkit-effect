/** A model's settings as a type, for the well-known models, and as choices, for one known at run time. */

import { expect } from "bun:test";
import { test } from "../../../tests/support/test.ts";
import { Effect } from "effect";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import { capabilitiesOf, knownCapabilities, KnownModels, type SettingsFor, wellKnown, withOverrides } from "./well-known-models.ts";

test("a well-known model's settings type takes the efforts it takes, and thinking off only with effort none", () => {
  // grok-4.7 takes low to xhigh, as models.dev lists it: no max, and no none, so thinking cannot be off.
  const grok: SettingsFor<"xai", "grok-4.7"> = { effort: "xhigh", thinking: "auto" };
  // @ts-expect-error grok-4.7 does not take max
  const tooHigh: SettingsFor<"xai", "grok-4.7"> = { effort: "max" };
  // @ts-expect-error grok-4.7 does not take none, so thinking cannot be off
  const noOff: SettingsFor<"xai", "grok-4.7"> = { thinking: "off" };
  // gpt-5.6-sol takes none to max.
  const sol: SettingsFor<"openai", "gpt-5.6-sol"> = { effort: "max", thinking: "off" };
  // gpt-5-pro takes only high.
  const pro: SettingsFor<"openai", "gpt-5-pro"> = { effort: "high" };
  // @ts-expect-error gpt-5-pro takes only high
  const proLow: SettingsFor<"openai", "gpt-5-pro"> = { effort: "low" };
  // claude-fable-5-1 takes low to max, as models.dev lists it, and no none, so thinking cannot be off.
  const fable: SettingsFor<"anthropic", "claude-fable-5-1"> = { effort: "max", thinking: "auto", maxOutputTokens: undefined as never };
  // @ts-expect-error claude-fable-5-1 does not take none, so thinking cannot be off
  const fableOff: SettingsFor<"anthropic", "claude-fable-5-1"> = { thinking: "off" };
  // gpt-5.3-chat-latest does not reason: models.dev lists no efforts for it, so the type takes any.
  const chat: SettingsFor<"openai", "gpt-5.3-chat-latest"> = { effort: "low" };
  expect([grok, tooHigh, noOff, sol, pro, proLow, fable, fableOff, chat]).toHaveLength(9);
});

test("a user's override of a model replaces the fields it gives and keeps the rest; a model no source knows takes the override alone; other models are as known", async () => {
  const overrides = new Map([
    ["xai/grok-4.7", { efforts: ["minimal", "low", "medium", "high", "xhigh"] }],
    ["localhost/qwen", { context: 32768, output: 8192 }],
  ]);
  const known = (provider: string, model: string) =>
    Effect.runPromise(knownCapabilities(ProviderName.make(provider), ModelName.make(model)).pipe(Effect.provideService(KnownModels, withOverrides(overrides, [wellKnown]))));
  expect((await known("xai", "grok-4.7")) as unknown).toEqual({ ...capabilitiesOf("xai", "grok-4.7"), efforts: ["minimal", "low", "medium", "high", "xhigh"] });
  expect(await known("localhost", "qwen")).toEqual({ input: [], price: { input: 0, output: 0 }, context: 32768, output: 8192 });
  expect(await known("xai", "grok-4.6")).toEqual(capabilitiesOf("xai", "grok-4.6"));
  expect(await known("localhost", "other")).toBeUndefined();
});
