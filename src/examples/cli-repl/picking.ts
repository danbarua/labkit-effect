/** Picking a model, from the words of a command or from the models the catalog lists, and switching a session to it. */

import { Effect } from "effect";
import { Prompt } from "effect/cli";
import { type Asked, askable, ModelCatalog } from "../../agent-host/catalog.ts";
import type { Session } from "../../agent-session/loop.ts";
import { invalid } from "./invalid.ts";
import { unavailable } from "./models.ts";

/** The models the catalog lists (the known models whose provider has a key set, and the local server's), for picking. */
export const pickable = Effect.map(askable, (models) => models.map(({ provider, model }) => ({ title: `${provider}/${model}`, value: `${provider}/${model}` })));

/**
 * The model `/model` names: its first word, or with none, the one the user picks from the models the
 * catalog lists, asked with `message`; undefined when the user leaves the pick (Ctrl+C). When the
 * catalog lists no model, fails saying what would make one available.
 */
export const modelNamed = (words: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    if (words[0] !== undefined) return words[0];
    const choices = yield* pickable;
    if (choices.length === 0) return yield* invalid("No model can be asked.", ...unavailable(yield* (yield* ModelCatalog).sources));
    return yield* Prompt.Select({ message, choices }).pipe(Effect.catchTag("QuitError", () => Effect.undefined));
  });


/** Reports `target` to `session` as the model to ask from the next turn on (`ModelChangeArrived`), and waits until the session has taken it. */
export const switchTo = (session: Session, target: Asked) =>
  session.observe({ _tag: "ModelChangeArrived", provider: target.provider, model: target.model }).pipe(Effect.andThen(session.idle));
