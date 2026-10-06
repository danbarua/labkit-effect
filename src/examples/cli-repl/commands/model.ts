/**
 * `/model <name>` switches the session's model from the next turn and saves it as the default for new
 * sessions. The name is a well-known model or `provider/model`. `/model` alone shows the current
 * model and a picker of usable models; when there are none, it says how to make one available.
 * Before a model is picked, `/model` picks the model the session opens with; a model that does not
 * support the settings given on the command line is refused, and nothing is saved. `/switch` changes
 * the model of this session only.
 *
 * The default is saved as `model` in the user's configuration folder (`agent-config` `write.ts`): in
 * the file that sets it, else in `models.yml`. If a layer read after the user's folder (a project
 * file, `--settings`) also sets `model`, it wins wherever it is read, and `/model` says so. If the
 * file cannot be written, `/model` says so and still switches the session's model.
 */

import { sep } from "node:path";
import { Array as Arr, Effect, Option } from "effect";
import type { Asked } from "../../../agent-host/catalog.ts";
import { modelOf } from "../../../agent-session/configuration/session-setup.ts";
import { writeSetting } from "../../../agent-config/write.ts";
import { type CommandContext, type DoneWithoutModel, type ReplCommand, said } from "../command.ts";
import { invalid } from "../invalid.ts";
import { inForce, takenBy } from "../model-settings.ts";
import { targetOf } from "../models.ts";
import { modelNamed, switchTo } from "../picking.ts";

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Saves `target` as the default model and returns what to print: the file written, and a hint when a
 * later layer also sets `model`; or the error when the file could not be written.
 */
const madeDefault = (target: Asked, { configFolder, layers }: CommandContext) => {
  const name = `${target.provider}/${target.model}`;
  return writeSetting(configFolder, ["model"], name, "models.yml").pipe(
    Effect.map((file) => {
      const last = Arr.findLast(layers, (layer) => isMapping(layer.value) && layer.value["model"] !== undefined && layer.value["model"] !== null).pipe(Option.getOrUndefined);
      const later = last !== undefined && !last.name.startsWith(configFolder + sep) ? last : undefined;
      const value = later !== undefined && isMapping(later.value) ? String(later.value["model"]) : undefined;
      return [`Default model: ${name} (saved to ${file})`, ...(later === undefined ? [] : [`HINT: ${later.name} sets model: ${value}, which overrides this default where that file is read.`])].join("\n");
    }),
    Effect.catch((error) => Effect.succeed(String(invalid(`Could not save ${name} as the default model: ${error.message}`).userMessage))),
  );
};

export const model: ReplCommand = {
  name: "/model",
  args: "[name]",
  says: "Switch model and make it the default; with no name, pick one",
  complete: (words, from) => (words.length === 2 ? from.models : []),
  inSession: (session, words, context) =>
    Effect.gen(function* () {
      const now = yield* modelOf(yield* session.facts);
      const chosen = yield* modelNamed(words, `Current model: ${now.provider}/${now.model}. Switch to which model? It becomes the default.`);
      if (chosen === undefined) return said(`${yield* inForce(session)}`);
      const target = yield* targetOf(chosen, "/model");
      yield* switchTo(session, target);
      return said(`${yield* inForce(session)}\n${yield* madeDefault(target, context)}`);
    }),
  withoutModel: (words, context) =>
    Effect.gen(function* () {
      const chosen = yield* modelNamed(words, "Which model? It becomes the default.");
      if (chosen === undefined) return { _tag: "Quiet" } as const;
      const target = yield* targetOf(chosen, "/model");
      // The session opens with the command-line settings, so a model that does not support them is refused before anything is saved.
      yield* takenBy(target, context.commandLine, "the command line", "Pick another model, or start the CLI again without that setting.");
      const done: DoneWithoutModel = { _tag: "Picked", target, text: yield* madeDefault(target, context) };
      return done;
    }),
};
