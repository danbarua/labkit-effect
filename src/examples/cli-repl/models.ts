/**
 * Looks up the model the user names (`--model`, `/model`) in the host's catalog
 * (`agent-host/catalog.ts`), and turns a failed lookup into a CLI error.
 */

import { Data, Effect } from "effect";
import { type CatalogSource, known, keyVariables, targetOf as catalogTargetOf } from "../../agent-host/catalog.ts";
import { invalid } from "./invalid.ts";

/** Where the user named a model: on the command line (`--model`) or in the REPL (`/model`). */
export type NamedBy = "--model" | "/model";

/** Why the named model cannot be used, and what the user can do about it. */
export class CannotAsk extends Data.TaggedError("CannotAsk")<{
  readonly message: string;
  readonly hint: string;
}> {}

/** Returns `problem` as a CLI error: an `ERROR:` line and a `HINT:` line. */
export const saidOf = (problem: CannotAsk) => invalid(problem.message, problem.hint);

/** Joins names for a sentence: `a`, `a or b`, `a, b or c`. */
const either = (names: ReadonlyArray<string>): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** How to choose another model, for where the user named this one. */
const another = (by: NamedBy): string => (by === "--model" ? "choose another model with --model" : "pick another model with /model");

/**
 * Returns the provider and model `model` names (`catalogTargetOf`), or fails with why it cannot be
 * used and a hint suited to where it was named (`by`); a hint for the command line names no slash
 * command.
 */
export const askedOf = (model: string | undefined, by: NamedBy) =>
  model === undefined
    ? Effect.fail(
        by === "--model"
          ? new CannotAsk({ message: "--model is required.", hint: "bun cli models shows available models discovered from the environment." })
          : new CannotAsk({ message: "No model selected.", hint: "Pick one with /model." }),
      )
    : catalogTargetOf(model).pipe(
        Effect.catchTags({
          ModelNotFound: ({ name, close }) =>
            Effect.fail(
              new CannotAsk({
                message: `Unknown model: ${name}.`,
                // At most three names; the hint says where to see the rest.
                hint: `${close.length === 0 ? "" : `Did you mean ${either(close.slice(0, 3))}? `}${by === "--model" ? "bun cli models lists the models you can use." : "Pick one with /model."}`,
              }),
            ),
          SourceNotAnswering: ({ provider, model: asked, at }) =>
            Effect.fail(new CannotAsk({ message: `${provider}/${asked} is unavailable: the local server${at === undefined ? "" : ` at ${at}`} is not responding.`, hint: `Start the server, or ${another(by)}.` })),
          KeyNotSet: ({ provider, variable }) =>
            Effect.fail(
              new CannotAsk({
                message: `${provider} models are unavailable: ${variable} is not set.`,
                hint: by === "--model" ? `Set ${variable}, or ${another(by)}.` : `Pick another model with /model, or set ${variable} and restart.`,
              }),
            ),
        }),
      );

/** Returns the provider and model `model` names, or fails with the CLI error (`saidOf`). */
export const targetOf = (model: string | undefined, by: NamedBy) => askedOf(model, by).pipe(Effect.mapError(saidOf));

/**
 * Returns hints for making more models available, given the catalog's `sources`: one per well-known
 * provider without an API key, naming its variable, and one per server that does not respond or
 * serves no models.
 */
export const unavailable = (sources: ReadonlyArray<CatalogSource>): ReadonlyArray<string> => [
  ...Object.keys(known).flatMap((provider) => (sources.some((source) => source.provider === provider) ? [] : [`Set ${keyVariables[provider] ?? `${provider}'s key`} to use ${provider} models.`])),
  ...sources.flatMap(({ provider, models, at }) => {
    const server = at === undefined ? `the ${provider} server` : `the local server at ${at}`;
    if (models === undefined) return [`Start ${server} to use its models: it is not responding.`];
    return models.length === 0 ? [`${server.charAt(0).toUpperCase()}${server.slice(1)} serves no models.`] : [];
  }),
];
