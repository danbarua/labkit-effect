/**
 * `described` adds a required `description` input to a tool: one sentence, written by the model,
 * that says what the call is for. The input stays in the call as recorded, and a host shows it as
 * the call's title (`callDescriptionOf`). The tool that `described` wraps runs without it.
 */

import { Predicate, Schema, Struct } from "effect";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { jsonSchemaOf } from "../agent-session/tool-input.ts";
import type { Fields, Tool } from "./tool.ts";

/** The input that `described` adds. */
export const callDescription = Schema.NonEmptyString.annotate({ description: "What this call is for, in one sentence. The user sees it as the call's title." });

/** The fields of a tool that `described` wraps: its own, and `description`. */
export type Described<F extends Fields> = Struct.Simplify<Struct.Assign<F, { readonly description: typeof callDescription }>>;

/** Returns `tool` with a required `description` input, which it removes from a call's input before `tool` runs. `tool` must not have an input of that name. */
export const described = <F extends Fields & { readonly description?: never }, R>(tool: Tool<F, R>): Tool<Described<F>, R> => ({
  ...tool,
  input: tool.input.mapFields(Struct.assign({ description: callDescription })),
  run: (input) => {
    const given: Readonly<Record<string, unknown>> = input;
    // The input without `description` is the input of `tool`.
    return tool.run(Object.fromEntries(Object.entries(given).filter(([name]) => name !== "description")) as Schema.Struct<F>["Type"]);
  },
});

/** The `description` input as the model is offered it. */
const offered = JSON.stringify(jsonSchemaOf(callDescription));

/**
 * Whether `spec`, a tool as the model is offered it, has the `description` input that `described`
 * adds. Another tool's input named `description` (an MCP tool's issue body, for example) is not it.
 */
export const isDescribed = (spec: ToolSpec): boolean => {
  const properties = Predicate.isReadonlyObject(spec.input) ? spec.input["properties"] : undefined;
  const added = Predicate.isReadonlyObject(properties) ? properties["description"] : undefined;
  return added !== undefined && JSON.stringify(added) === offered;
};

/** Returns the description that a call's `input` gives, when it gives one. */
export const callDescriptionOf = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("description" in input)) return undefined;
  const { description } = input;
  return typeof description === "string" && description !== "" ? description : undefined;
};
