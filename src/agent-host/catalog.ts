/**
 * The models a host can ask: the well-known models, each provider's key from the environment, and
 * the models of the local server (`local-server.ts`). The catalog is a service, so a source can be
 * added beside these; `KeyedAndLocalCatalog` has the two there are.
 */

import { Context, Data, Effect, Layer } from "effect";
import { ModelName, ProviderName } from "../agent-machine/names.ts";
import { wellKnownModels } from "../agent-session/configuration/well-known-models.gen.ts";
import { localModels, localServer } from "./local-server.ts";

/** The well-known models, by provider. */
export const known: Readonly<Record<string, Readonly<Record<string, unknown>>>> = wellKnownModels;

/** The environment variable that holds each provider's key; a local server needs none. */
export const keyVariables: Readonly<Record<string, string>> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY" };

/** The key the environment holds for `provider`; an empty one is none. */
export const keyOf = (provider: string): string | undefined => {
  const variable = keyVariables[provider];
  const key = variable === undefined ? undefined : process.env[variable];
  return key === undefined || key === "" ? undefined : key;
};

/** A model to ask, by its provider and its name. */
export interface Asked {
  readonly provider: ProviderName;
  readonly model: ModelName;
}

/** One provider's models in the catalog. */
export interface CatalogSource {
  readonly provider: ProviderName;
  /** The models it lists, by the names it takes; undefined when it was asked for them and did not answer. */
  readonly models: ReadonlyArray<ModelName> | undefined;
  /** Where it is, when it is a server that is asked for its models. */
  readonly at?: string;
}

/**
 * The models that can be asked, by source. A well-known provider in it takes any model named as
 * `provider/model`; any other takes only the models it lists.
 */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /** Each source and its models, asked for anew each time: a server's may change while a host runs. */
    readonly sources: Effect.Effect<ReadonlyArray<CatalogSource>>;
  }
>()("agent-host/ModelCatalog") {}

/**
 * The well-known models of each provider whose key the environment holds, in the order `known` has
 * them, then the local server's. The keys are read when the layer is built.
 */
export const KeyedAndLocalCatalog = Layer.effect(
  ModelCatalog,
  Effect.sync(() => {
    const keyed: ReadonlyArray<CatalogSource> = Object.entries(known).flatMap(([provider, models]) =>
      keyOf(provider) === undefined ? [] : [{ provider: ProviderName.make(provider), models: Object.keys(models).map((model) => ModelName.make(model)) }],
    );
    const local = ProviderName.make("localhost");
    return {
      sources: Effect.map(localModels, (listed): ReadonlyArray<CatalogSource> => [
        ...keyed,
        { provider: local, models: listed?.map((model) => ModelName.make(model)), at: localServer },
      ]),
    };
  }),
);

/** The models the catalog lists, each source's in turn: the ones a host offers to pick. */
export const askable: Effect.Effect<ReadonlyArray<Asked>, never, ModelCatalog> = Effect.gen(function* () {
  const sources = yield* (yield* ModelCatalog).sources;
  return sources.flatMap(({ provider, models }) => (models ?? []).map((model) => ({ provider, model })));
});

/** No model has the name asked for; `close` are the names it is close to. */
export class ModelNotFound extends Data.TaggedError("ModelNotFound")<{
  readonly name: string;
  readonly close: ReadonlyArray<string>;
}> {}

/** The model named is its source's, and the source (a server, at `at`) did not answer. */
export class SourceNotAnswering extends Data.TaggedError("SourceNotAnswering")<{
  readonly provider: ProviderName;
  readonly model: ModelName;
  readonly at: string | undefined;
}> {}

/** The model named is a well-known provider's, and the environment holds no key for it in `variable`. */
export class KeyNotSet extends Data.TaggedError("KeyNotSet")<{
  readonly provider: ProviderName;
  readonly variable: string;
}> {}

/** The names among `names` that `wanted` is close to: the same apart from case, or containing it. */
const closeTo = (wanted: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const lower = wanted.toLowerCase();
  return names.filter((name) => name.toLowerCase() === lower || name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
};

/**
 * The provider and model a name gives:
 *
 * - `<well-known provider>/…`: that provider's model, as named.
 * - `<other source>/…`: a model that source lists (`localhost/…`: the local server's).
 * - A name alone: the model of that name among the well-known ones, or else among the other
 *   sources'.
 *
 * A name not found fails with the names it is close to. A source that did not answer cannot be
 * asked; nor can a well-known provider whose key is not set, and the variable is named.
 */
export const targetOf = (name: string) =>
  Effect.gen(function* () {
    const sources = yield* (yield* ModelCatalog).sources;
    const listing = sources.filter((source) => !(source.provider in known));
    const slash = name.indexOf("/");
    const prefix = slash > 0 ? name.slice(0, slash) : undefined;
    const named = listing.find((source) => source.provider === prefix);
    const found = ((): { readonly provider: string; readonly model: string; readonly source?: CatalogSource } | undefined => {
      if (prefix !== undefined && prefix in known) return { provider: prefix, model: name.slice(slash + 1) };
      if (named !== undefined) {
        const model = name.slice(slash + 1);
        // A source that did not answer is found here, and said below not to answer.
        return named.models === undefined || named.models.some((each) => each === model) ? { provider: named.provider, model, source: named } : undefined;
      }
      const wellKnown = Object.keys(known).find((each) => name in (known[each] ?? {}));
      if (wellKnown !== undefined) return { provider: wellKnown, model: name };
      const source = listing.find((each) => each.models?.some((model) => model === name) === true);
      return source === undefined ? undefined : { provider: source.provider, model: name, source };
    })();
    if (found === undefined) {
      const names = [
        ...Object.entries(known).flatMap(([provider, models]) => Object.keys(models).map((each) => `${provider}/${each}`)),
        ...listing.flatMap(({ provider, models }) => (models ?? []).map((each) => `${provider}/${each}`)),
      ];
      return yield* new ModelNotFound({ name, close: closeTo(named === undefined ? name : name.slice(slash + 1), names) });
    }
    const asked: Asked = { provider: ProviderName.make(found.provider), model: ModelName.make(found.model) };
    if (found.source !== undefined && found.source.models === undefined) return yield* new SourceNotAnswering({ ...asked, at: found.source.at });
    const variable = keyVariables[found.provider];
    if (variable !== undefined && !sources.some((source) => source.provider === found.provider)) return yield* new KeyNotSet({ provider: asked.provider, variable });
    return asked;
  });
