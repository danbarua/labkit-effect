/**
 * `inWorkspace(root)` binds a tool's path inputs (`paths.ts`) to the folder `root`, the working
 * folder. The model is offered each path input as relative to the working folder, or absolute
 * inside it (`workspaceInput`). A call's path is resolved against the root, and the tool runs with
 * the absolute path. A path outside the root is refused before the tool runs (`inside`).
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { type PathOf, pathOf } from "./paths.ts";
import { type Fields, Rejected, type Tool } from "./tool.ts";

/** What the model is told of each kind of path input. */
const pathDescriptions: Readonly<Record<PathOf, string>> = {
  file: "The file's path: relative to the working folder, or absolute inside it.",
  folder: 'The folder\'s path: relative to the working folder, or absolute inside it. "." is the working folder.',
};

/** Returns the names of the path inputs among `fields`. */
const pathInputsOf = (fields: Fields): ReadonlyArray<readonly [string, PathOf]> =>
  Object.entries(fields).flatMap(([name, field]) => {
    const of = pathOf(field);
    return of === undefined ? [] : [[name, of] as const];
  });

/** Returns `input` with each path input described as relative to the working folder, or absolute inside it. */
export const workspaceInput = <F extends Fields>(input: Schema.Struct<F>): Schema.Struct<F> =>
  input.mapFields(
    (fields) =>
      // Each field keeps its schema; only a path input's description changes.
      ({ ...fields, ...Object.fromEntries(pathInputsOf(fields).map(([name, of]) => [name, fields[name]?.annotate({ description: pathDescriptions[of] })])) }) as F,
  );

/** Returns the absolute path of `path` resolved against `root` (`full`), or why it is refused: it is outside `root` (`problem`). */
export const inside = (root: string, path: string): { readonly full: string } | { readonly problem: string } => {
  const full = resolve(root, path);
  const from = relative(root, full);
  return from.startsWith("..") || isAbsolute(from) ? { problem: `${path} is not inside the working folder, ${root}.` } : { full };
};

/** Returns `tool` bound to the folder `root`: its path inputs resolved against `root`, and refused outside it. */
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
            const at = inside(root, path);
            return "problem" in at ? Effect.fail(new Rejected({ problem: at.problem })) : Effect.succeed([[name, at.full] as const]);
          });
          // The input with each path made absolute has the fields of `tool`'s input.
          return yield* tool.run({ ...given, ...Object.fromEntries(resolved.flat()) } as Schema.Struct<F>["Type"]);
        }),
    };
  };
