/**
 * A tool as a value: what the model is offered (its name, its description and its input schema,
 * with its kind and replay, which the loop reads) and how a call runs. A primitive tool does one
 * thing and checks nothing beyond its input. A wrapper is a function from a tool to a tool, which
 * changes what the model is offered, what a call does, or both (`in-workspace.ts`, `described.ts`).
 *
 * `sourceOf` turns tools into the tool source that a session runs calls with. It decodes a call's
 * input once, with the schema of the outermost wrapper, and runs the tool. A wrapper is given the
 * decoded input, and gives the tool it wraps a decoded input in turn.
 */

import { Context, Data, Effect, Schema } from "effect";
import { type CallId, FailureText, type ToolName } from "../agent-machine/names.ts";
import type { ToolDetail, ToolOutcome } from "../agent-machine/observation.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { parseJson, receivedText } from "../agent-session/received.ts";
import type { ToolSource } from "../agent-session/tool-sources.ts";
import { type Decoded, decoderOf, ignoredNote, jsonSchemaOf } from "../agent-session/tool-input.ts";
import { pathInputsOf } from "./paths.ts";

/** The call's input does not fit, or names a path that the tool does not accept: the model reads the problem. */
export class Rejected extends Data.TaggedError("Rejected")<{ readonly problem: string }> {}

/** The tool ran and failed, for example with an error the file system reported: the model reads the message. */
export class Reported extends Data.TaggedError("Reported")<{ readonly message: string }> {}

/**
 * The call that a tool runs for. `sourceOf` provides it to each call. A tool that reports on its
 * call while it runs asks for it: the editor's `run_command` shows its terminal in the call.
 */
export class CurrentCall extends Context.Service<CurrentCall, CallId>()("agent-tools/CurrentCall") {}

/** What a call returns: the text the model is sent, or that text and the details of what the call did (`ToolDetail`), which the model is never sent. */
export type ToolOutput = string | { readonly text: string; readonly details: ReadonlyArray<ToolDetail> };

/** Returns `output` with `note` appended to its text. */
export const withNote = (output: ToolOutput, note: string): ToolOutput => (typeof output === "string" ? `${output}${note}` : { ...output, text: `${output.text}${note}` });

/** The fields of a tool's input: each decodes and encodes without services. */
export type Fields = { readonly [name: string]: Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never } };

/** A tool whose input has the fields `F`, and whose calls need the services `R`. */
export interface Tool<F extends Fields, R = never> {
  readonly name: ToolName;
  readonly description: string;
  readonly input: Schema.Struct<F>;
  readonly kind: ToolSpec["kind"];
  readonly replay: ToolSpec["replay"];
  readonly run: (input: Schema.Struct<F>["Type"]) => Effect.Effect<ToolOutput, Rejected | Reported, R>;
}

/** A tool of any input, as a list of tools holds it. */
export interface AnyTool<R> {
  readonly spec: ToolSpec;
  readonly decode: (input: unknown, strict: boolean) => Effect.Effect<Decoded<unknown>, Schema.SchemaError>;
  readonly run: (input: unknown) => Effect.Effect<ToolOutput, Rejected | Reported, R>;
}

/** The names of `input`'s path inputs (`paths.ts`), for the spec, when it has any. */
const pathsOf = (input: Schema.Struct<Fields>): { readonly paths?: ReadonlyArray<string> } => {
  const names = pathInputsOf(input.fields).map(([name]) => name);
  return names.length === 0 ? {} : { paths: names };
};

/** Returns `tool` as a list of tools holds it: what the model is offered, how its input is decoded, and how it runs. */
export const anyTool = <F extends Fields, R>(tool: Tool<F, R>): AnyTool<R> => ({
  spec: { name: tool.name, description: tool.description, input: jsonSchemaOf(tool.input), kind: tool.kind, replay: tool.replay, ...pathsOf(tool.input) },
  decode: (input, strict) => decoderOf(tool.input, strict)(input),
  // The input is what `decode` returned, so it has the tool's type.
  run: (input) => tool.run(input as Schema.Struct<F>["Type"]),
});

const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });

/**
 * Returns the tool source (the host's own tools, with no namespace) that runs calls to `tools`, with
 * the services `R` that it is built with, and the call (`CurrentCall`).
 * - With `strictInput`, a call whose input has properties that its tool does not take is refused.
 *   Without it, the call runs without them, a WARN is logged, and the result says which were ignored.
 * - A call to a name that no tool has ends `NotFound`.
 */
export const sourceOf = <R>(tools: ReadonlyArray<AnyTool<R>>, options: { readonly strictInput?: boolean } = {}): Effect.Effect<ToolSource, never, Exclude<R, CurrentCall>> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Exclude<R, CurrentCall>>();
    const strict = options.strictInput ?? false;
    return {
      tools: tools.map((tool) => tool.spec),
      run: (name, input, call) => {
        const found = tools.find((tool) => tool.spec.name === name);
        if (found === undefined) return Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } });
        const parsed = parseJson(input);
        if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
        return found.decode(parsed.value, strict).pipe(
          Effect.mapError((error) => new Rejected({ problem: `${name} does not take this input: ${error.message}` })),
          Effect.flatMap(({ value, ignored }) => {
            const note = ignoredNote(name, ignored);
            const logged = ignored.length === 0 ? Effect.void : Effect.logWarning(logKeys.tools.inputIgnored, { tool: name, ignored });
            return logged.pipe(
              Effect.andThen(found.run(value)),
              Effect.map((output): ToolOutcome => {
                const ran = withNote(output, note);
                if (typeof ran === "string") return { _tag: "Succeeded", output: receivedText(ran) };
                return { _tag: "Succeeded", output: receivedText(ran.text), ...(ran.details.length === 0 ? {} : { details: ran.details }) };
              }),
              Effect.catchTag("Reported", (error) => Effect.fail(new Reported({ message: `${error.message}${note}` }))),
            );
          }),
          Effect.catchTags({
            Rejected: (error) => Effect.succeed(rejected(error.problem)),
            Reported: (error) => Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "Reported", error: receivedText(error.message) } }),
          }),
          Effect.provideService(CurrentCall, call),
          Effect.provideContext(services),
        );
      },
    };
  });
