/** Picking a model, by name or from a list of usable models, and switching a session to it. */

import { Effect } from "effect";
import { Prompt } from "effect/cli";
import { type Asked, askable, ModelCatalog } from "../../agent-host/catalog.ts";
import type { Session } from "../../agent-session/loop.ts";
import { invalid } from "./invalid.ts";
import { unavailable } from "./models.ts";

/** The usable models (well-known models whose provider has an API key, and the local server's), as picker choices. */
export const pickable = Effect.map(askable, (models) => models.map(({ provider, model }) => ({ title: `${provider}/${model}`, value: `${provider}/${model}` })));

/**
 * Returns the model named by the command's first word, or with none, the one the user picks from the
 * usable models (prompting with `message`); undefined when the user cancels (Ctrl+C). With no usable
 * models, fails with hints for making one available.
 */
export const modelNamed = (words: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    if (words[0] !== undefined) return words[0];
    const choices = yield* pickable;
    if (choices.length === 0) return yield* invalid("No models available.", ...unavailable(yield* (yield* ModelCatalog).sources));
    return yield* Prompt.Select({ message, choices }).pipe(Effect.catchTag("QuitError", () => Effect.undefined));
  });


/** Switches `session` to `target` from the next turn (`ModelChangeArrived`), and waits until the session is idle. */
export const switchTo = (session: Session, target: Asked) =>
  session.observe({ _tag: "ModelChangeArrived", provider: target.provider, model: target.model }).pipe(Effect.andThen(session.idle));
