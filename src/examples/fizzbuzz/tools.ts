/**
 * The FizzBuzz tools, as tool sources: `classify` alone, or with `report_error`. Each tool's input is
 * one `Schema`: the model is offered its JSON Schema, and a call's input is decoded with it, so what
 * is offered is what runs. A call that does not decode fails with `InputRejected` and the decoder's
 * message; a tool the source does not offer fails with `NotFound`.
 */

import { Effect, Schema } from "effect";
import { FailureText, ToolName } from "../../agent-machine/names.ts";
import type { ToolOutcome } from "../../agent-machine/observation.ts";
import type { Received } from "../../agent-machine/received.ts";
import type { ToolSpec } from "../../agent-session/contracts.ts";
import type { ToolSource } from "../../agent-session/tool-sources.ts";
import { parseJson, receivedJson } from "../../agent-session/received.ts";

export const Label = Schema.Literals(["Fizz", "Buzz", "FizzBuzz"]);
export type Label = typeof Label.Type;

export const ErrorCode = Schema.Literals(["number_out_of_sequence", "irrational_number", "irrational_user", "i_am_bored"]);
export type ErrorCode = typeof ErrorCode.Type;

/** The model's description of a problem, for the system administrators. */
export const ErrorMessage = Schema.String.pipe(Schema.brand("examples/fizzbuzz/ErrorMessage"));
export type ErrorMessage = typeof ErrorMessage.Type;

/** A tool: what the model is offered, and how a call runs. */
interface FizzBuzzTool {
  readonly spec: ToolSpec;
  readonly run: (input: Received) => ToolOutcome;
}

const rejected = (problem: string): ToolOutcome => ({
  _tag: "Failed",
  reason: { _tag: "InputRejected", problem: FailureText.make(problem) },
});

function tool<A>(
  name: string,
  description: string,
  input: Schema.Codec<A, unknown>,
  run: (decoded: A) => Schema.Json,
): FizzBuzzTool {
  const decode = Schema.decodeUnknownResult(input);
  return {
    spec: { name: ToolName.make(name), description, input: Schema.toJsonSchemaDocument(input).schema as Schema.Json, kind: "other", replay: "safe" },
    run: (received) => {
      const parsed = parseJson(received);
      if ("reason" in parsed) return rejected(`The input could not be read: ${parsed.reason}.`);
      const decoded = decode(parsed.value);
      return decoded._tag === "Success"
        ? { _tag: "Succeeded", output: receivedJson(run(decoded.success)) }
        : rejected(decoded.failure.message);
    },
  };
}

export const classify = tool(
  "classify",
  "Records the classification of the number the user sent.",
  Schema.Struct({
    label: Label.annotate({
      description: "Fizz for a multiple of 3, Buzz for a multiple of 5, FizzBuzz for a multiple of both.",
    }),
  }),
  ({ label }) => ({ classified: label }),
);

export const reportError = tool(
  "report_error",
  "Reports a problem with the user's message to the system administrators.",
  Schema.Struct({
    error_code: ErrorCode.annotate({ description: "Select the appropriate error for the problem." }),
    error_message: ErrorMessage.annotate({
      description:
        "Provide a helpful description of the error to assist the system administrators in diagnosing the problem.",
    }),
  }),
  ({ error_code }) => ({ reported: error_code }),
);

const sourceOf = (tools: ReadonlyArray<typeof classify>): ToolSource => ({
  tools: tools.map((each) => each.spec),
  run: (name, input) => {
    const found = tools.find((candidate) => candidate.spec.name === name);
    return Effect.succeed(found === undefined ? { _tag: "Failed", reason: { _tag: "NotFound" } } : found.run(input));
  },
});

/** `classify` only. */
export const FizzBuzzTools: ToolSource = sourceOf([classify]);

/** `classify` and `report_error`. */
export const AdvancedFizzBuzzTools: ToolSource = sourceOf([classify, reportError]);
