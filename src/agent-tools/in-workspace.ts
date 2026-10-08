/**
 * `inWorkspace(root)` binds a tool's path inputs (`paths.ts`) to the folder `root`, the working
 * folder. The model is offered
 * each path input as relative to the working folder, or absolute (`workspaceInput`). A call's path is
 * resolved against the root, and the tool runs with the absolute path. A path outside the folders is
 * not refused here: the permission policy judges it (`agent-policy/permissions.ts`), as it judges a
 * command's paths. A tool without the policy runs as the user, anywhere, as a bare tool does.
 */

import { Effect, Schema } from "effect";
import { fullPathIn, type PathOf, pathInputsOf } from "./paths.ts";
import type { Fields, Tool } from "./tool.ts";

/** What the model is told of each kind of path input. */
export const pathDescriptions: Readonly<Record<PathOf, string>> = {
  file: "The file's path: relative to the working folder, or absolute.",
  folder: 'The folder\'s path: relative to the working folder, or absolute. "." is the working folder.',
};

/** Returns the names of the path inputs among `fields`. */

/** Returns `input` with each path input described as relative to the working folder, or absolute. */
export const workspaceInput = <F extends Fields>(input: Schema.Struct<F>): Schema.Struct<F> =>
  input.mapFields(
    (fields) =>
      // Each field keeps its schema; only a path input's description changes.
      ({ ...fields, ...Object.fromEntries(pathInputsOf(fields).map(([name, of]) => [name, fields[name]?.annotate({ description: pathDescriptions[of] })])) }) as F,
  );

export const inWorkspace =
  (root: string) =>
  <F extends Fields, R>(tool: Tool<F, R>): Tool<F, R> => {
    const paths = pathInputsOf(tool.input.fields);
    return {
      ...tool,
      input: workspaceInput(tool.input),
      run: (input) =>
        Effect.gen(function* () {
          const given: Readonly<Record<string, unknown>> = input;
          const resolved = yield* Effect.forEach(paths, ([name]) => {
            const path = given[name];
            if (typeof path !== "string") return Effect.succeed([]);
            return Effect.succeed([[name, fullPathIn(root, path)] as const]);
          });
          // The input with each path made absolute has the fields of `tool`'s input.
          return yield* tool.run({ ...given, ...Object.fromEntries(resolved.flat()) } as Schema.Struct<F>["Type"]);
        }),
    };
  };
