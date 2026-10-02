/** What the local server's model list says of its models. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { localCapabilities } from "./local-server.ts";

test("H3: what the local server lists of a model is what is known of it: its context window, input and reasoning efforts", () => {
  const listed = {
    data: [{ id: "qwen3.5-9b-8bit", context_window: null, capabilities: ["text", "tools"] }],
    models: [
      {
        slug: "qwen3.5-9b-8bit",
        context_window: 262144,
        input_modalities: ["text"],
        default_reasoning_level: "none",
        supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "medium" }, { effort: "high" }],
      },
      { slug: "bare" },
    ],
  };
  expect([...localCapabilities(listed)]).toEqual([
    ["qwen3.5-9b-8bit", { context: 262144, input: ["text"], efforts: ["none", "low", "medium", "high"], price: { input: 0, output: 0 } }],
    ["bare", { input: ["text"], price: { input: 0, output: 0 } }],
  ]);
  expect(localCapabilities("not a list").size).toBe(0);
});

test("H3: an entry written some other way drops only itself, and so does a value in it", () => {
  const listed = {
    models: [
      { name: "no slug" },
      { slug: "odd", context_window: "large", input_modalities: ["text", 3, "image"], supported_reasoning_levels: [{ effort: "low" }, "high", { level: "max" }] },
    ],
  };
  expect([...localCapabilities(listed)]).toEqual([["odd", { input: ["text", "image"], efforts: ["low"], price: { input: 0, output: 0 } }]]);
});
