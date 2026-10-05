/** The model catalog: its sources, the models it offers, and the model a name gives. */

import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { ModelName, ProviderName } from "../agent-machine/names.ts";
import { askable, type CatalogSource, KeyedAndLocalCatalog, known, ModelCatalog, targetOf } from "./catalog.ts";
import { localServer } from "./local-server.ts";

const source = (provider: string, models: ReadonlyArray<string> | undefined, at?: string): CatalogSource => ({
  provider: ProviderName.make(provider),
  models: models?.map((model) => ModelName.make(model)),
  ...(at === undefined ? {} : { at }),
});

/** A catalog of `sources`, as a hand-written source would give them. */
const catalogOf = (sources: ReadonlyArray<CatalogSource>) => Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

/** The model `name` gives in a catalog of `sources`, as `provider/model`, or the error's tag and what it carries. */
const resolved = (name: string, sources: ReadonlyArray<CatalogSource>) =>
  runTest(
    targetOf(name).pipe(
      Effect.map(({ provider, model }): unknown => `${provider}/${model}`),
      Effect.catchTags({
        ModelNotFound: ({ close }) => Effect.succeed({ notFound: close }),
        SourceNotAnswering: ({ provider, model, at }) => Effect.succeed({ notAnswering: `${provider}/${model}`, at }),
        KeyNotSet: ({ provider, variable }) => Effect.succeed({ noKey: provider, variable }),
      }),
      Effect.provide(catalogOf(sources)),
    ),
  );

/** Runs `run` with the environment's provider keys set as `keys` gives them, and puts them back after. */
const withKeys = async <A>(keys: Readonly<Record<string, string | undefined>>, run: () => Promise<A>): Promise<A> => {
  const before = Object.fromEntries(Object.keys(keys).map((name) => [name, process.env[name]]));
  const set = (values: Readonly<Record<string, string | undefined>>) => {
    for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set(keys);
  try {
    return await run();
  } finally {
    set(before);
  }
};

test("the catalog's sources are the well-known models of each provider with a key set, then the local server's", async () => {
  const sources = await withKeys({ ANTHROPIC_API_KEY: "set", OPENAI_API_KEY: undefined, XAI_API_KEY: "" }, () =>
    runTest(Effect.gen(function* () { return yield* (yield* ModelCatalog).sources; }).pipe(Effect.provide(KeyedAndLocalCatalog))),
  );
  // An empty key is no key: xAI is left out, as OpenAI is.
  expect(sources.slice(0, -1)).toEqual([source("anthropic", Object.keys(known["anthropic"] ?? {}))]);
  const local = sources.at(-1);
  expect([local?.provider, local?.at]).toEqual(["localhost", localServer]);
});

test("the models offered are each source's in turn; a source that did not answer offers none", async () => {
  const offered = await runTest(
    askable.pipe(Effect.provide(catalogOf([source("anthropic", ["claude-a", "claude-b"]), source("lan", undefined, "http://lan"), source("localhost", ["qwen"])]))),
  );
  expect(offered.map(({ provider, model }) => `${provider}/${model}`)).toEqual(["anthropic/claude-a", "anthropic/claude-b", "localhost/qwen"]);
});

test("a name resolves to a well-known provider's model, as provider/model or by the model name alone, or to a model that another source lists", async () => {
  const sources = [source("openai", ["gpt-5.5"]), source("localhost", ["qwen", "org/model"])];
  expect(await resolved("gpt-5.5", sources)).toBe("openai/gpt-5.5");
  // A well-known provider takes a model it does not list, named with it.
  expect(await resolved("openai/gpt-unlisted", sources)).toBe("openai/gpt-unlisted");
  expect(await resolved("qwen", sources)).toBe("localhost/qwen");
  expect(await resolved("localhost/org/model", sources)).toBe("localhost/org/model");
});

test("a name that no source has fails with the names it is close to; another source accepts only the models it lists", async () => {
  const sources = [source("openai", ["gpt-5.5"]), source("localhost", ["qwen"])];
  expect(await resolved("GPT-5.5-PRO", sources)).toEqual({ notFound: ["openai/gpt-5.5-pro"] });
  expect(await resolved("localhost/QWEN", sources)).toEqual({ notFound: ["localhost/qwen"] });
  expect(await resolved("nothing-like-it", sources)).toEqual({ notFound: [] });
});

test("a model of a source that did not answer, or of a well-known provider with no key, cannot be asked", async () => {
  const sources = [source("openai", ["gpt-5.5"]), source("localhost", undefined, "http://localhost:8000/v1")];
  expect(await resolved("localhost/qwen", sources)).toEqual({ notAnswering: "localhost/qwen", at: "http://localhost:8000/v1" });
  // xAI is well known, and not in the catalog: its key is not set.
  expect(await resolved("grok-4.7", sources)).toEqual({ noKey: "xai", variable: "XAI_API_KEY" });
  expect(await resolved("xai/grok-unlisted", sources)).toEqual({ noKey: "xai", variable: "XAI_API_KEY" });
});
