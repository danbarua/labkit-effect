/** A configuration as ACP's config options, and a client's `session/set_config_option` as the change it asks. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { test } from "../../tests/support/test.ts";
import type { SessionConfigOption } from "effective-acp/schema/v1";
import { ModelName, ProviderName, TokenCount } from "../agent-machine/names.ts";
import { changed as applied, type ModelSettings } from "../agent-machine/settings.ts";
import type { Asked } from "../agent-host/catalog.ts";
import { optionsFor } from "../agent-session/configuration/options.ts";
import { changeOf, configOptions, InvalidChange } from "./config-options.ts";

const asked = (provider: string, model: string): Asked => ({ provider: ProviderName.make(provider), model: ModelName.make(model) });
const models = [asked("openai", "gpt-5.5"), asked("anthropic", "claude-haiku-4-5")];

const optionsOf = (provider: string, model: string, settings: ModelSettings) => Effect.runPromise(optionsFor({ ...asked(provider, model), settings }));

/** Each option as its id, its category, its values and the value now. */
const shown = (options: ReadonlyArray<SessionConfigOption>) =>
  options.map((option) => ({
    id: option.id,
    category: option.category,
    values: option.type === "select" ? option.options.flatMap((each): ReadonlyArray<string> => ("value" in each ? [each.value] : [])) : [],
    now: String(option.currentValue),
  }));

test("an openai/gpt-5.5 configuration: the model, then each setting offered but observe and cache, each with its current value among its values", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium", cache: "1h", maxOutputTokens: TokenCount.make(32768) });
  const shownOptions = shown(configOptions(options, models, 128000));
  expect(shownOptions as unknown).toEqual([
    { id: "model", category: "model", values: ["openai/gpt-5.5", "anthropic/claude-haiku-4-5"], now: "openai/gpt-5.5" },
    { id: "effort", category: "thought_level", values: ["default", "low", "medium", "high", "xhigh"], now: "medium" },
    { id: "thinking", category: "model_config", values: ["default", "disabled"], now: "default" },
    { id: "max_output_tokens", category: "model_config", values: ["default", "4096", "8192", "16384", "32768", "65536", "128000"], now: "32768" },
  ]);
  for (const { values, now } of shownOptions) expect(values).toContain(now);
});

test("the model asked now is offered even when the catalog does not list it", async () => {
  const options = await optionsOf("localhost", "qwen/qwen3-8b", {});
  const [model] = shown(configOptions(options, models, undefined));
  expect(model as unknown).toEqual({ id: "model", category: "model", values: ["openai/gpt-5.5", "anthropic/claude-haiku-4-5", "localhost/qwen/qwen3-8b"], now: "localhost/qwen/qwen3-8b" });
});

test("an effort beyond the model's highest shows the nearest the model takes as current, and is not offered itself", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "max" });
  const effort = shown(configOptions(options, models, 128000)).find((option) => option.id === "effort");
  expect(effort as unknown).toEqual({ id: "effort", category: "thought_level", values: ["default", "low", "medium", "high", "xhigh"], now: "xhigh" });
});

test("a model that takes a thinking budget is offered efforts, as any other model is: its adapter sends each as a budget", async () => {
  const options = await optionsOf("anthropic", "claude-haiku-4-5", { effort: "medium" });
  const thought = shown(configOptions(options, models, 64000)).filter((option) => option.category === "thought_level");
  expect(thought as unknown).toEqual([{ id: "effort", category: "thought_level", values: ["default", "low", "medium", "high", "xhigh", "max"], now: "medium" }]);
});

test("the output limit offers the presets up to the model's limit, the limit, and the value in force, least first", async () => {
  const outputOf = async (said: number | undefined, limit: number | undefined) => {
    const options = await optionsOf("openai", "gpt-5.5", said === undefined ? {} : { maxOutputTokens: TokenCount.make(said) });
    return shown(configOptions(options, models, limit)).find((option) => option.id === "max_output_tokens");
  };
  expect(await outputOf(50000, 20000)).toMatchObject({ values: ["default", "4096", "8192", "16384", "20000", "50000"], now: "50000" });
  expect(await outputOf(10000, 64000)).toMatchObject({ values: ["default", "4096", "8192", "10000", "16384", "32768", "64000"], now: "10000" });
  expect(await outputOf(undefined, undefined)).toMatchObject({ values: ["default", "4096", "8192", "16384", "32768", "65536", "128000"], now: "default" });
});

test("every value offered, taken as a change, gives a configuration whose option has that value now", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  for (const option of shown(configOptions(options, models, 128000)))
    for (const value of option.values) {
      const change = changeOf(option.id, value, options, models, 128000);
      if (change instanceof InvalidChange) throw new Error(change.reason);
      // The configuration the change gives: its model, with the settings it names over those said before; default removes one.
      const changed = await Effect.runPromise(optionsFor({ provider: change.provider, model: change.model, settings: applied(options.settings, change.settings ?? {}) }));
      const now = shown(configOptions(changed, models, 128000)).find((each) => each.id === option.id)?.now;
      expect([option.id, now]).toEqual([option.id, value]);
    }
});

test("a change names only what was chosen: a setting alone, or the model alone; choosing default returns the setting to the provider's default", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  expect(changeOf("thinking", "disabled", options, models, 128000) as unknown).toEqual({ provider: "openai", model: "gpt-5.5", settings: { thinking: "disabled" } });
  expect(changeOf("max_output_tokens", "65536", options, models, 128000) as unknown).toEqual({ provider: "openai", model: "gpt-5.5", settings: { maxOutputTokens: 65536 } });
  expect(changeOf("model", "anthropic/claude-haiku-4-5", options, models, 128000) as unknown).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  expect(changeOf("effort", "default", options, models, 128000) as unknown).toEqual({ provider: "openai", model: "gpt-5.5", settings: { effort: "default" } });
  // observe and cache are not options.
  expect(changeOf("cache", "5m", options, models, 128000)).toBeInstanceOf(InvalidChange);
});

test("a model value is found among the models offered, not split: a local model's name keeps its own slashes", async () => {
  const options = await optionsOf("openai", "gpt-5.5", {});
  const local = [...models, asked("localhost", "mlx-community/Qwen3-8B-4bit")];
  expect(changeOf("model", "localhost/mlx-community/Qwen3-8B-4bit", options, local, 128000) as unknown).toEqual({
    provider: "localhost",
    model: "mlx-community/Qwen3-8B-4bit",
  });
});

test("a value the option does not offer, or an id no option has, is an invalid change saying why", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  const invalid = (configId: string, value: string) => {
    const change = changeOf(configId, value, options, models, 64000);
    return change instanceof InvalidChange ? change.reason : "valid";
  };
  expect(invalid("effort", "max")).toBe("max is not a value offered for reasoning effort.");
  expect(invalid("max_output_tokens", "128000")).toBe("128000 is not a value offered for maximum output tokens.");
  expect(invalid("effort", "none")).toBe("none is not a value offered for reasoning effort.");
  expect(invalid("model", "openai/gpt-4o")).toBe("openai/gpt-4o is not a model offered.");
  expect(invalid("temperature", "1")).toBe("No option has the id temperature.");
});

test("a setting's current value that its values do not list is offered beside them", () => {
  const options = {
    provider: ProviderName.make("openai"),
    model: ModelName.make("gpt-5.5"),
    settings: {},
    offered: [{ _tag: "OneOf" as const, name: "effort" as const, values: ["low", "high"], now: "medium" }],
  };
  const effort = shown(configOptions(options, models, undefined)).find((option) => option.id === "effort");
  expect(effort as unknown).toEqual({ id: "effort", category: "thought_level", values: ["low", "high", "medium"], now: "medium" });
});
