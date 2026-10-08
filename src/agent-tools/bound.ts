/**
 * `bound(values)` supplies some of a tool's inputs itself. The model is not offered those inputs, and
 * a call runs with the values given to `bound`. A git tool bound to the working folder's repository
 * supplies `repository`, so the model never sees that input.
 */

import { type Schema, Struct } from "effect";
import type { Fields, Tool } from "./tool.ts";

/** The fields of `F` that a tool bound to `V` is still offered. */
export type Unbound<F extends Fields, V> = Struct.Simplify<Omit<F, Extract<keyof V & string, keyof F>>>;

/** Returns `tool` without the inputs that `values` names: a call runs with each of those inputs set to its value in `values`. */
export const bound =
  <V extends Readonly<Record<string, unknown>>>(values: V) =>
  <F extends Fields & { readonly [K in keyof V]: { readonly Type: V[K] } }, R>(tool: Tool<F, R>): Tool<Unbound<F, V>, R> => ({
    ...tool,
    // The keys of `values` are inputs of `tool`, as its type requires.
    input: tool.input.mapFields(Struct.omit(Object.keys(values) as Array<Extract<keyof V & string, keyof F>>)),
    run: (input) => tool.run({ ...input, ...values } as Schema.Struct<F>["Type"]),
  });
