/** A configuration as ACP's config options, and a client's `session/set_config_option` as the change it asks. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { test } from "../../tests/support/test.ts";
import type { SessionConfigOption } from "../acp/schema/v1.gen.ts";
import { ModelName, ProviderName, TokenCount } from "../agent-machine/names.ts";
import type { ModelSettings } from "../agent-machine/settings.ts";
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

test("AA1 AA2: an openai/gpt-5.5 configuration: the model, then each setting offered but observe and cache, each with its current value among its values", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium", cache: "1h", maxOutputTokens: TokenCount.make(32768) });
  const shownOptions = shown(configOptions(options, models, 128000));
  expect(shownOptions).toEqual([
    { id: "model", category: "model", values: ["openai/gpt-5.5", "anthropic/claude-haiku-4-5"], now: "openai/gpt-5.5" },
    { id: "effort", category: "thought_level", values: ["low", "medium", "high", "xhigh"], now: "medium" },
    { id: "thinking", category: "model_config", values: ["not_sent", "auto", "off"], now: "not_sent" },
    { id: "max_output_tokens", category: "model_config", values: ["4096", "8192", "16384", "32768", "65536", "128000"], now: "32768" },
  ] as never);
  for (const { values, now } of shownOptions) expect(values).toContain(now);
});

test("AA1: the model asked now is offered even when the catalog does not list it", async () => {
  const options = await optionsOf("localhost", "qwen/qwen3-8b", {});
  const [model] = shown(configOptions(options, models, undefined));
  expect(model).toEqual({ id: "model", category: "model", values: ["openai/gpt-5.5", "anthropic/claude-haiku-4-5", "localhost/qwen/qwen3-8b"], now: "localhost/qwen/qwen3-8b" } as never);
});

test("AA2: an effort beyond the model's highest shows the nearest the model takes as current, and is not offered itself", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "max" });
  const effort = shown(configOptions(options, models, 128000)).find((option) => option.id === "effort");
  expect(effort).toEqual({ id: "effort", category: "thought_level", values: ["low", "medium", "high", "xhigh"], now: "xhigh" } as never);
});

test("AA3: the output limit offers the presets up to the model's limit, the limit, and the value in force, least first", async () => {
  const outputOf = async (said: number | undefined, limit: number | undefined) => {
    const options = await optionsOf("openai", "gpt-5.5", said === undefined ? {} : { maxOutputTokens: TokenCount.make(said) });
    return shown(configOptions(options, models, limit)).find((option) => option.id === "max_output_tokens");
  };
  expect(await outputOf(50000, 20000)).toMatchObject({ values: ["4096", "8192", "16384", "20000", "50000"], now: "50000" });
  expect(await outputOf(10000, 64000)).toMatchObject({ values: ["4096", "8192", "10000", "16384", "32768", "64000"], now: "10000" });
  expect(await outputOf(undefined, undefined)).toMatchObject({ values: ["not_sent", "4096", "8192", "16384", "32768", "65536", "128000"], now: "not_sent" });
});

test("AA4: every value offered, taken as a change, gives a configuration whose option has that value now", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  for (const option of shown(configOptions(options, models, 128000)))
    for (const value of option.values) {
      if (value === "not_sent") continue;
      const change = changeOf(option.id, value, options, models, 128000);
      if (change instanceof InvalidChange) throw new Error(change.reason);
      // The configuration the change gives: its model, with the settings it names over those said before.
      const changed = await Effect.runPromise(optionsFor({ provider: change.provider, model: change.model, settings: { ...options.settings, ...change.settings } }));
      const now = shown(configOptions(changed, models, 128000)).find((each) => each.id === option.id)?.now;
      expect([option.id, now]).toEqual([option.id, value]);
    }
});

test("AA4: a change names only what was chosen: a setting alone, or the model alone; choosing not_sent while it is current changes nothing", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  expect(changeOf("thinking", "auto", options, models, 128000)).toEqual({ provider: "openai", model: "gpt-5.5", settings: { thinking: "auto" } } as never);
  expect(changeOf("max_output_tokens", "65536", options, models, 128000)).toEqual({ provider: "openai", model: "gpt-5.5", settings: { maxOutputTokens: 65536 } } as never);
  expect(changeOf("model", "anthropic/claude-haiku-4-5", options, models, 128000)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" } as never);
  expect(changeOf("thinking", "not_sent", options, models, 128000)).toEqual({ provider: "openai", model: "gpt-5.5" } as never);
  // observe and cache are not options.
  expect(changeOf("cache", "5m", options, models, 128000)).toBeInstanceOf(InvalidChange);
});

test("AA4: a model value is split at its first slash: a local model's name keeps its own slashes", async () => {
  const options = await optionsOf("openai", "gpt-5.5", {});
  const local = [...models, asked("localhost", "mlx-community/Qwen3-8B-4bit")];
  expect(changeOf("model", "localhost/mlx-community/Qwen3-8B-4bit", options, local, 128000)).toEqual({
    provider: "localhost",
    model: "mlx-community/Qwen3-8B-4bit",
  } as never);
});

test("AA5: a value the option does not offer, or an id no option has, is an invalid change saying why", async () => {
  const options = await optionsOf("openai", "gpt-5.5", { effort: "medium" });
  const invalid = (configId: string, value: string) => {
    const change = changeOf(configId, value, options, models, 64000);
    return change instanceof InvalidChange ? change.reason : "valid";
  };
  expect(invalid("effort", "max")).toBe("max is not a value offered for reasoning effort.");
  expect(invalid("max_output_tokens", "128000")).toBe("128000 is not a value offered for maximum output tokens.");
  expect(invalid("effort", "not_sent")).toBe("not_sent is not a value offered for reasoning effort.");
  expect(invalid("model", "openai/gpt-4o")).toBe("openai/gpt-4o is not a model offered.");
  expect(invalid("temperature", "1")).toBe("No option has the id temperature.");
});
