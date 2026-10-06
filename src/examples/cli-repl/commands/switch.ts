/**
 * `/switch <name>` switches the model for this session only, from the next turn. The name is a
 * well-known model or `provider/model`. `/switch` alone shows the current model and a picker of
 * usable models; when there are none, it says how to make one available. Before a model is picked,
 * `/switch` picks the model the session opens with, unless it does not support the settings given
 * on the command line. `/model` also saves the model as the default.
 *
 * The change is reported to the session (`ModelChangeArrived`), which applies it between turns; a
 * setting the new model does not support is translated, and recorded, at its next request.
 */

import { Effect } from "effect";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { type DoneWithoutModel, type ReplCommand, said } from "../command.ts";
import { inForce, takenBy } from "../model-settings.ts";
import { targetOf } from "../models.ts";
import { modelNamed, switchTo } from "../picking.ts";

export const switchCommand: ReplCommand = {
  name: "/switch",
  args: "[name]",
  says: "Switch model for this session only; with no name, pick one",
  complete: (words, from) => (words.length === 2 ? from.models : []),
  inSession: (session, words) =>
    Effect.gen(function* () {
      const now = yield* modelOf(yield* session.facts);
      const chosen = yield* modelNamed(words, `Current model: ${now.provider}/${now.model}. Switch to which model for this session?`);
      if (chosen !== undefined) yield* switchTo(session, yield* targetOf(chosen, "/model"));
      return said(`${yield* inForce(session)}`);
    }),
  withoutModel: (words, context) =>
    Effect.gen(function* () {
      const chosen = yield* modelNamed(words, "Which model, for this session?");
      if (chosen === undefined) return { _tag: "Quiet" } as const;
      const target = yield* targetOf(chosen, "/model");
      // The session opens with the command-line settings, so a model that does not support them is refused.
      yield* takenBy(target, context.commandLine, "the command line", "Pick another model, or start the CLI again without that setting.");
      const done: DoneWithoutModel = { _tag: "Picked", target };
      return done;
    }),
};
