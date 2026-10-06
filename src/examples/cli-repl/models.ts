/**
 * The model the CLI is told to ask (`--model`, `/model`), found in the host's catalog
 * (`agent-host/catalog.ts`), and what the catalog cannot find said in the CLI's words.
 */

import { Data, Effect } from "effect";
import { type CatalogSource, known, keyVariables, targetOf as catalogTargetOf } from "../../agent-host/catalog.ts";
import { invalid } from "./invalid.ts";

/** Where the user names a model: on the command line (`--model`), or in the REPL (`/model`). */
export type NamedBy = "--model" | "/model";

/** Why the model named cannot be asked, and what the user can do about it. */
export class CannotAsk extends Data.TaggedError("CannotAsk")<{
  readonly message: string;
  readonly hint: string;
}> {}

/** The mistake `problem` is, as the CLI prints it: an `ERROR:` line and a `HINT:` line. */
export const saidOf = (problem: CannotAsk) => invalid(problem.message, problem.hint);

/** Names in a sentence: `a`, `a or b`, `a, b or c`. */
const either = (names: ReadonlyArray<string>): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** How to name another model, from where the user is. */
const another = (by: NamedBy): string => (by === "--model" ? "name another model with --model" : "pick another model with /model");

/**
 * Returns the provider and model that `model` names (`catalogTargetOf`), or fails with why it cannot
 * be asked, with a hint that says what to do from where the user named it (`by`): a hint for the
 * command line names no slash command.
 */
export const askedOf = (model: string | undefined, by: NamedBy) =>
  model === undefined
    ? Effect.fail(
        by === "--model"
          ? new CannotAsk({ message: "--model is required.", hint: "bun cli models shows available models discovered from the environment." })
          : new CannotAsk({ message: "No model is set.", hint: "Pick one with /model." }),
      )
    : catalogTargetOf(model).pipe(
        Effect.catchTags({
          ModelNotFound: ({ name, close }) =>
            Effect.fail(
              new CannotAsk({
                message: `No model is named ${name}.`,
                // At most three names: the rest are listed where the hint points.
                hint: `${close.length === 0 ? "" : `Did you mean ${either(close.slice(0, 3))}? `}${by === "--model" ? "bun cli models shows available models." : "Pick one with /model."}`,
              }),
            ),
          SourceNotAnswering: ({ provider, model: asked, at }) =>
            Effect.fail(new CannotAsk({ message: `The local server${at === undefined ? "" : ` at ${at}`} is not answering, so ${provider}/${asked} cannot be asked.`, hint: `Start it, or ${another(by)}.` })),
          KeyNotSet: ({ provider, variable }) =>
            Effect.fail(
              new CannotAsk({
                message: `${variable} is not set, so ${provider} models cannot be asked.`,
                hint: by === "--model" ? `Set ${variable}, or ${another(by)}.` : `Pick another model with /model, or restart with ${variable} set.`,
              }),
            ),
        }),
      );

/** Returns the provider and model that `model` names, or the mistake as the CLI prints it (`saidOf`). */
export const targetOf = (model: string | undefined, by: NamedBy) => askedOf(model, by).pipe(Effect.mapError(saidOf));

/**
 * What would make more models available, given the catalog's `sources`: one line for each well-known
 * provider whose key is not set, naming its variable, and one for each server that is not answering or
 * lists no models.
 */
export const unavailable = (sources: ReadonlyArray<CatalogSource>): ReadonlyArray<string> => [
  ...Object.keys(known).flatMap((provider) => (sources.some((source) => source.provider === provider) ? [] : [`Set ${keyVariables[provider] ?? `${provider}'s key`} to use ${provider} models.`])),
  ...sources.flatMap(({ provider, models, at }) => {
    const server = at === undefined ? `The ${provider} server` : `The local server at ${at}`;
    if (models === undefined) return [`${server} is not answering; start it to use ${provider} models.`];
    return models.length === 0 ? [`${server} lists no models.`] : [];
  }),
];
