/** What the local server's model list says of its models. */

import { expect } from "bun:test";
import { Effect, Layer, Logger } from "effect";
import { test } from "../../tests/support/test.ts";
import { ModelName, ProviderName } from "../agent-machine/names.ts";
import { capabilitiesOf, knownCapabilities } from "../agent-session/configuration/well-known-models.ts";
import { logKeys } from "./log-keys.ts";
import { KnownWithLocalServer, localCapabilities, localModels } from "./local-server.ts";

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

/** Runs `use` with `fetch` replaced by `stub`, and restores it afterwards. */
const withFetch = async <A>(stub: (url: unknown, init?: RequestInit) => Promise<Response>, use: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    return await use();
  } finally {
    globalThis.fetch = original;
  }
};

test("a local server that does not answer the model list within one second lists no models", async () => {
  const hanging = (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const started = Date.now();
  const models = await withFetch(hanging, () => Effect.runPromise(localModels));
  expect(models).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(3000);
});

test("KnownWithLocalServer logs a warning when the local server does not answer, and then knows no localhost model", async () => {
  const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logging = Logger.layer([Logger.make((options) => logged.push({ level: options.logLevel, message: options.message }))]);
  const known = await withFetch(
    () => Promise.reject(new Error("connection refused")),
    () => Effect.runPromise(knownCapabilities(ProviderName.make("localhost"), ModelName.make("qwen")).pipe(Effect.provide(Layer.mergeAll(KnownWithLocalServer, logging)))),
  );
  expect(known).toBeUndefined();
  const warned = logged.filter((each) => each.level === "Warn" && Array.isArray(each.message) && each.message[0] === logKeys.localServer.modelsNotListed);
  expect(warned).toHaveLength(1);
});

test("KnownWithLocalServer applies the local server's list to localhost models only", async () => {
  const listed = { models: [{ slug: "gpt-5", context_window: 999 }] };
  const known = await withFetch(
    () => Promise.resolve(new Response(JSON.stringify(listed))),
    () =>
      Effect.runPromise(
        Effect.all([knownCapabilities(ProviderName.make("localhost"), ModelName.make("gpt-5")), knownCapabilities(ProviderName.make("openai"), ModelName.make("gpt-5"))]).pipe(
          Effect.provide(KnownWithLocalServer),
        ),
      ),
  );
  expect(known[0]?.context).toBe(999);
  expect(known[1]).toEqual(capabilitiesOf("openai", "gpt-5"));
});
