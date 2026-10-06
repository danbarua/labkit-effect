/**
 * `/switch <name>` asks another model from the next turn on, in this session only: a well-known
 * model, or `provider/model`. `/switch` alone shows the model being asked and offers the models that
 * can be asked to pick; when there are none, it says what would make one available. Before a model
 * is picked, the model named or picked is the one the session opens with, unless it does not take
 * the settings the command line names. `/model` does the same and also makes the model the one new
 * sessions ask.
 *
 * The change is reported to the session (`ModelChangeArrived`), which takes it between turns; what a
 * model does not allow is adjusted, and recorded, when it is next asked.
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
  says: "Ask another model in this session only; with no name, pick one",
  complete: (words, from) => (words.length === 2 ? from.models : []),
  inSession: (session, words) =>
    Effect.gen(function* () {
      const now = yield* modelOf(yield* session.facts);
      const chosen = yield* modelNamed(words, `Asking ${now.provider}/${now.model}. Ask which model in this session?`);
      if (chosen !== undefined) yield* switchTo(session, yield* targetOf(chosen, "/model"));
      return said(`Asking ${yield* inForce(session)}`);
    }),
  withoutModel: (words, context) =>
    Effect.gen(function* () {
      const chosen = yield* modelNamed(words, "Ask which model in this session?");
      if (chosen === undefined) return { _tag: "Quiet" } as const;
      const target = yield* targetOf(chosen, "/model");
      // The session opens with the command line's settings: a model that does not take them is not picked.
      yield* takenBy(target, context.commandLine, "the command line", "Pick another model, or start the CLI again without that setting.");
      const done: DoneWithoutModel = { _tag: "Picked", target };
      return done;
    }),
};
