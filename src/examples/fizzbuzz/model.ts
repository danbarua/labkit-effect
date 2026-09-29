/**
 * A scripted FizzBuzz model: it answers from the context it is sent and nothing else, so what it
 * gets right or wrong is what the context carried.
 *
 * - To a whole number it calls `classify` when the number is a multiple of 3 or 5, and otherwise
 *   replies with the number plus one; after the tool's result it replies with the number plus one.
 * - When `report_error` is offered, it reports input that is not a number (`irrational_user`), a
 *   number that is not whole (`irrational_number`), and a number that does not follow the last one
 *   it returned (`number_out_of_sequence`); after the report's result it replies with the error
 *   code. The last number it returned is read from its own last reply, or from a summary's line
 *   "The last number you returned to the user was: N".
 * - Without `report_error`, input that is not a whole number fails the request with an `AiError`
 *   (`InvalidUserInputError`), as a provider would.
 *
 * It is a `ProviderRequest`, like an adapter's, and its model client is built with `modelClientOf`.
 * Every context it is sent is kept, in order, in `seen`.
 */

import { Effect, Layer } from "effect";
import * as AiError from "effect/ai/AiError";
import { CallId, ModelText, StopReason, ToolName, type TurnId } from "../../agent-core/names.ts";
import type { ModelPart, Observation } from "../../agent-core/observation.ts";
import {
  type ContextMessage,
  ModelClient,
  type ModelContext,
  type ProviderRequest,
  type Target,
} from "../../agent-effect/contracts.ts";
import { modelClientOf } from "../../agent-effect/provider-call.ts";
import { parseJson, receivedJson } from "../../agent-effect/received.ts";
import { isObject } from "../../agent-effect/shaping.ts";
import type { ErrorCode, Label } from "./tools.ts";

type Responded = Effect.Effect<Extract<Observation, { _tag: "ModelResponded" }>, AiError.AiError>;

export function labelOf(n: number): Label | undefined {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return undefined;
}

const texts = (message: ContextMessage): ReadonlyArray<string> =>
  message.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : []));

const summaryLine = /The last number you returned to the user was: (-?\d+)/;

/**
 * The last number the model returned before the latest text, which is the user's input. A summary
 * can share one message with that input, so texts are read one by one, not message by message.
 */
function lastReturned(messages: ReadonlyArray<ContextMessage>): number | undefined {
  const found = messages
    .flatMap((message) => texts(message).map((text) => ({ role: message.role, text })))
    .slice(0, -1)
    .reverse()
    .flatMap(({ role, text }) => {
      if (role === "assistant" && /^-?\d+$/.test(text)) return [Number(text)];
      const line = summaryLine.exec(text);
      return role === "user" && line !== null ? [Number(line[1])] : [];
    });
  return found[0];
}

/** What the model makes of the user's text. */
type Judged =
  | { readonly _tag: "Number"; readonly n: number }
  | { readonly _tag: "Problem"; readonly code: ErrorCode; readonly message: string };

function judged(text: string, returned: number | undefined): Judged {
  const n = Number(text.trim());
  if (text.trim() === "" || Number.isNaN(n))
    return { _tag: "Problem", code: "irrational_user", message: `"${text}" is not a number.` };
  if (!Number.isInteger(n)) return { _tag: "Problem", code: "irrational_number", message: `${text} is not a whole number.` };
  if (returned !== undefined && n !== returned + 1)
    return {
      _tag: "Problem",
      code: "number_out_of_sequence",
      message: `Expected ${returned + 1} after ${returned}, got ${n}.`,
    };
  return { _tag: "Number", n };
}

export function scriptedFizzBuzzModel(): {
  readonly layer: Layer.Layer<ModelClient>;
  readonly seen: ReadonlyArray<ModelContext>;
} {
  const seen: Array<ModelContext> = [];
  const calls = { count: 0 };

  const responded = (target: Target, turn: TurnId, parts: ReadonlyArray<ModelPart>): Responded =>
    Effect.succeed({
      _tag: "ModelResponded",
      turn,
      provider: target.provider,
      model: target.model,
      parts,
      stop: StopReason.make(parts.some((part) => part._tag === "ToolCall") ? "tool_use" : "end_turn"),
      ending: { _tag: "Complete" },
      metadata: receivedJson({}),
    });
  const failed = (reason: AiError.AiErrorReason): Responded =>
    Effect.fail(AiError.make({ module: "ScriptedFizzBuzzModel", method: "respond", reason }));
  const say = (text: string): ModelPart => ({ _tag: "Text", text: ModelText.make(text) });
  const call = (tool: string, input: Record<string, string>): ModelPart => {
    calls.count += 1;
    return { _tag: "ToolCall", call: CallId.make(`call-${calls.count}`), tool: ToolName.make(tool), input: receivedJson(input) };
  };

  function respond(target: Target, context: ModelContext, turn: TurnId): Responded {
    seen.push(context);
    const last = context.messages.at(-1);
    if (last === undefined || last.role !== "user")
      return failed(new AiError.InvalidRequestError({ description: "the scripted FizzBuzz model needs a user message last" }));

    const results = last.parts.flatMap((part) => (part._tag === "ToolResult" ? [part.call] : []));
    if (results.length > 0) {
      const asked = context.messages
        .flatMap((message) => message.parts)
        .flatMap((part) => (part._tag === "ToolCall" && results.includes(part.call) ? [part] : []));
      const report = asked.find((part) => part.tool === "report_error");
      if (report !== undefined) {
        const input = parseJson(report.input);
        const value = "value" in input ? input.value : null;
        const code = isObject(value) ? value["error_code"] : undefined;
        return responded(target, turn, [say(typeof code === "string" ? code : JSON.stringify(code ?? null))]);
      }
      const question = [...context.messages].reverse().find((message) => message.role === "user" && texts(message).length > 0);
      const n = question === undefined ? Number.NaN : Number(texts(question).at(-1));
      return responded(target, turn, [say(String(n + 1))]);
    }

    const text = texts(last).at(-1) ?? "";
    const reports = context.tools.some((tool) => tool.name === "report_error");
    const judgement = judged(text, reports ? lastReturned(context.messages) : undefined);
    if (judgement._tag === "Problem")
      return reports
        ? responded(target, turn, [call("report_error", { error_code: judgement.code, error_message: judgement.message })])
        : failed(
            new AiError.InvalidUserInputError({
              description: `the scripted FizzBuzz model reads only whole numbers: ${judgement.message}`,
            }),
          );
    const label = labelOf(judgement.n);
    return responded(target, turn, [label === undefined ? say(String(judgement.n + 1)) : call("classify", { label })]);
  }

  const request: ProviderRequest = (target, context, turn) => Effect.suspend(() => respond(target, context, turn));
  return { layer: Layer.succeed(ModelClient, modelClientOf(request)), seen };
}
