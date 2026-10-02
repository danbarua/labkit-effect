/**
 * The model the CLI is told to ask (`--model`, `/model`), found in the host's catalog
 * (`agent-host/catalog.ts`), and what the catalog cannot find said in the CLI's words.
 */

import { Effect } from "effect";
import { targetOf as catalogTargetOf } from "../../agent-host/catalog.ts";
import { invalid } from "./invalid.ts";

/** How a model can be named, said wherever a name is not found. */
const howToName = "`bun cli models` lists the models you can use; name one as it lists it, or as provider/model (for example openai/gpt-5.5, or localhost/<a model the local server serves>).";

/** The provider and model `model` names (`catalogTargetOf`); none named, or one that cannot be asked, is a mistake in how the CLI was called. */
export const targetOf = (model: string | undefined) =>
  model === undefined
    ? Effect.fail(invalid(`No model given: pass --model. ${howToName}`))
    : catalogTargetOf(model).pipe(
        Effect.catchTags({
          ModelNotFound: ({ name, close }) =>
            Effect.fail(invalid(`No model named ${name}.${close.length === 0 ? "" : ` Did you mean ${close.join(" or ")}?`} ${howToName}`)),
          SourceNotAnswering: ({ provider, model, at }) =>
            Effect.fail(invalid(`The local server${at === undefined ? "" : ` at ${at}`} is not answering, so ${provider}/${model} cannot be asked.`)),
          KeyNotSet: ({ provider, variable }) => Effect.fail(invalid(`Set ${variable} before calling ${provider}/* models, or try a different model with --model provider/model.`)),
        }),
      );
