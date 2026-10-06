/**
 * `/model <name>` asks another model from the next turn on, and makes it the model new sessions ask:
 * a well-known model, or `provider/model`. `/model` alone shows the model being asked and offers the
 * models that can be asked to pick; when there are none, it says what would make one available.
 * Before a model is picked, the model named or picked is the one the session opens with, and the one
 * new sessions ask; a model that does not take the settings the command line names is not picked, and
 * nothing is written. `/switch` changes the model of this session only.
 *
 * The model new sessions ask is written as `model` into the user's configuration folder
 * (`agent-config` `write.ts`): into the file that sets it, else `models.yml`. A layer read after the
 * user's folder (a project's file, `--settings`) that sets `model` decides it for the sessions that
 * read that layer, and `/model` says so. When the file cannot be written, `/model` says so, and the
 * session still asks the model.
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
 * Writes `target` as the model new sessions ask, and returns what to say of it: the file written,
 * and a layer read after the user's folder that sets `model` too; or the error, when it could not be
 * written.
 */
const madeDefault = (target: Asked, { configFolder, layers }: CommandContext) => {
  const name = `${target.provider}/${target.model}`;
  return writeSetting(configFolder, ["model"], name, "models.yml").pipe(
    Effect.map((file) => {
      const last = Arr.findLast(layers, (layer) => isMapping(layer.value) && layer.value["model"] !== undefined && layer.value["model"] !== null).pipe(Option.getOrUndefined);
      const later = last !== undefined && !last.name.startsWith(configFolder + sep) ? last : undefined;
      const value = later !== undefined && isMapping(later.value) ? String(later.value["model"]) : undefined;
      return [`New sessions ask ${name}: written to ${file}.`, ...(later === undefined ? [] : [`${later.name} sets model too, and is read after ${configFolder}: new sessions that read it ask ${value}.`])].join("\n");
    }),
    Effect.catch((error) => Effect.succeed(String(invalid(`${name} was not written as the model new sessions ask: ${error.message}`).userMessage))),
  );
};

export const model: ReplCommand = {
  name: "/model",
  args: "[name]",
  says: "Ask another model, in this session and new ones; with no name, pick one",
  complete: (words, from) => (words.length === 2 ? from.models : []),
  inSession: (session, words, context) =>
    Effect.gen(function* () {
      const now = yield* modelOf(yield* session.facts);
      const chosen = yield* modelNamed(words, `Asking ${now.provider}/${now.model}. Ask which model, in this session and new ones?`);
      if (chosen === undefined) return said(`Asking ${yield* inForce(session)}`);
      const target = yield* targetOf(chosen, "/model");
      yield* switchTo(session, target);
      return said(`Asking ${yield* inForce(session)}\n${yield* madeDefault(target, context)}`);
    }),
  withoutModel: (words, context) =>
    Effect.gen(function* () {
      const chosen = yield* modelNamed(words, "Ask which model, in this session and new ones?");
      if (chosen === undefined) return { _tag: "Quiet" } as const;
      const target = yield* targetOf(chosen, "/model");
      // The session opens with the command line's settings: a model that does not take them is not picked, and nothing is written.
      yield* takenBy(target, context.commandLine, "the command line", "Pick another model, or start the CLI again without that setting.");
      const done: DoneWithoutModel = { _tag: "Picked", target, text: yield* madeDefault(target, context) };
      return done;
    }),
};
