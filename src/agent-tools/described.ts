/**
 * `described` adds a required `intent` input to a tool: one sentence, written by the model, that
 * says what the call is for. The input stays in the call as recorded, and a host shows it as the
 * call's title (`intentOf`). The tool that `described` wraps runs without it.
 */

import { Predicate, Schema, Struct } from "effect";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import type { Fields, Tool } from "./tool.ts";

/** The input that `described` adds. */
export const callIntent = Schema.NonEmptyString.annotate({ description: "What this call is for, in one sentence. The user sees it as the call's title." });

/** The fields of a tool that `described` wraps: its own, and `intent`. */
export type Described<F extends Fields> = Struct.Simplify<Struct.Assign<F, { readonly intent: typeof callIntent }>>;

/** Returns `tool` with a required `intent` input, which it removes from a call's input before `tool` runs. `tool` must not have an input of that name. */
export const described = <F extends Fields & { readonly intent?: never }, R>(tool: Tool<F, R>): Tool<Described<F>, R> => ({
  ...tool,
  input: tool.input.mapFields(Struct.assign({ intent: callIntent })),
  run: (input) => {
    const given: Readonly<Record<string, unknown>> = input;
    // The input without `intent` is the input of `tool`.
    return tool.run(Object.fromEntries(Object.entries(given).filter(([name]) => name !== "intent")) as Schema.Struct<F>["Type"]);
  },
});

/** The `intent` input as the model is offered it. */
const offered = JSON.stringify(jsonSchemaOf(callIntent));

/**
 * Whether `spec`, a tool as the model is offered it, has the `intent` input that `described` adds.
 * Another tool's input of that name is not it.
 */
export const isDescribed = (spec: ToolSpec): boolean => {
  const properties = Predicate.isReadonlyObject(spec.input) ? spec.input["properties"] : undefined;
  const added = Predicate.isReadonlyObject(properties) ? properties["intent"] : undefined;
  return added !== undefined && JSON.stringify(added) === offered;
};

/** Returns the intent that a call's `input` gives, when it gives one. */
export const intentOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("intent" in input)) return undefined;
  const { intent } = input;
  return typeof intent === "string" && intent !== "" ? intent : undefined;
};
