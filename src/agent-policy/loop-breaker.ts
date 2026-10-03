/**
 * The loop breaker: a model that makes the same tool call again and again in a row is told so, then
 * stopped. It is two policies, one on tool calls and one on model requests, and both count from the
 * session's facts, so a session that goes on from its facts counts the same.
 *
 * - `repeatedCalls` vetoes a call that is the `nudgeAt`-th identical call in a row, or later, and
 *   the reason, which the model reads as the call's result, says so.
 * - `repeatingTurns` vetoes a turn's model request once its last `stopAt` calls are identical; the
 *   turn ends `Vetoed`.
 *
 * Calls are identical when `key` gives them the same key: by default, the same tool and the same
 * input as received. Calls are in a row when no other call of their turn came between them, in the
 * order they are first recorded: a model that runs the tests, edits a file and runs them again has
 * made two calls to run the tests, not two in a row.
 */

import { Schema } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import { type CallId, FailureText, type ToolName, type TurnId } from "../agent-machine/names.ts";
import { MediaType, type Received, ReceivedText } from "../agent-machine/received.ts";
import type { Policy, PolicyStep } from "./policy.ts";

/** What a call is known by when calls are compared: two calls with the same key are identical. */
export const CallKey = Schema.String.pipe(Schema.brand("agent-policy/CallKey"));
export type CallKey = typeof CallKey.Type;

export interface LoopBreakerSettings {
  /** The identical call in a row that is vetoed, and each after it: 3 vetoes the third. */
  readonly nudgeAt: number;
  /** How many identical calls in a row end a turn: its next model request is vetoed. */
  readonly stopAt: number;
  /** What makes two calls identical: the same key. */
  readonly key: (tool: ToolName, input: Received) => CallKey;
}

/** The same tool, and the same input as received. */
export const sameToolAndInput = (tool: ToolName, input: Received): CallKey => {
  const body = input.body;
  switch (body._tag) {
    case "Text":
      return CallKey.make(JSON.stringify([tool, input.mediaType, "text", body.text]));
    case "Bytes":
      return CallKey.make(JSON.stringify([tool, input.mediaType, "bytes", Array.from(body.bytes)]));
    case "Stored":
      return CallKey.make(JSON.stringify([tool, input.mediaType, "stored", body.id]));
    default:
      return body satisfies never;
  }
};

export const loopBreakerDefaults: LoopBreakerSettings = { nudgeAt: 3, stopAt: 5, key: sameToolAndInput };

interface Call {
  readonly turn: TurnId;
  readonly call: CallId;
  readonly tool: ToolName;
  readonly input: Received;
}

/**
 * The tool calls the model made, each once, in the order each is first recorded: as it arrived
 * (`ToolCallArrived`) or in its response (`ModelResponded`), in the response's order.
 */
const callsIn = (facts: ReadonlyArray<Fact>): ReadonlyArray<Call> => {
  const made = facts.flatMap((fact): ReadonlyArray<Call> => {
    if (fact._tag !== "Observed") return [];
    const observation = fact.observation;
    if (observation._tag === "ToolCallArrived") return [observation];
    if (observation._tag === "ModelResponded")
      return observation.parts.flatMap((part) => (part._tag === "ToolCall" ? [{ turn: observation.turn, call: part.call, tool: part.tool, input: part.input }] : []));
    return [];
  });
  return made.filter((call, index) => made.findIndex((other) => other.turn === call.turn && other.call === call.call) === index);
};

/** How many identical calls in a row end with the call at `index`: it, and those of its turn before it with no other between. */
const inARow = (calls: ReadonlyArray<Call>, index: number, key: LoopBreakerSettings["key"]): number => {
  const call = calls[index];
  if (call === undefined) return 0;
  const same = key(call.tool, call.input);
  const differs = calls
    .slice(0, index + 1)
    .filter((other) => other.turn === call.turn)
    .map((other) => key(other.tool, other.input) !== same);
  return differs.length - 1 - differs.lastIndexOf(true);
};

const proceed: PolicyStep<unknown> = { _tag: "Decided", verdict: { _tag: "Continue" } };
const veto = (reason: FailureText): PolicyStep<unknown> => ({
  _tag: "Decided",
  verdict: { _tag: "Veto", reason: { mediaType: MediaType.make("text/plain"), body: { _tag: "Text", text: ReceivedText.make(reason) } } },
});

/** The tool call policy: vetoes the `nudgeAt`-th identical call in a row, and each after it. */
export const repeatedCalls = (facts: ReadonlyArray<Fact>, settings: LoopBreakerSettings = loopBreakerDefaults): Policy<unknown> => ({
  start: (request) => {
    if (request._tag !== "RunTool") return proceed;
    const calls = callsIn(facts);
    // The call as last recorded: a call id can be used again in a later turn.
    const index = calls.map((call) => call.call).lastIndexOf(request.call);
    const count = inARow(calls, index, settings.key);
    return count < settings.nudgeAt
      ? proceed
      : veto(
          FailureText.make(
            `Not run: ${request.tool} has been called with this same input ${count} times in a row. ` +
              `Do something else, or answer with what you have. After ${settings.stopAt} such calls in a row the turn ends.`,
          ),
        );
  },
  receive: () => proceed,
});

/** The model request policy: vetoes a turn's request once its last `stopAt` calls are identical. */
export const repeatingTurns = (facts: ReadonlyArray<Fact>, settings: LoopBreakerSettings = loopBreakerDefaults): Policy<unknown> => ({
  start: (request) => {
    if (request._tag !== "RequestModelResponse") return proceed;
    const calls = callsIn(facts);
    const last = calls.map((call) => call.turn).lastIndexOf(request.turn);
    const call = calls[last];
    const count = inARow(calls, last, settings.key);
    return call === undefined || count < settings.stopAt
      ? proceed
      : veto(FailureText.make(`Stopped: ${call.tool} was called with the same input ${count} times in a row.`));
  },
  receive: () => proceed,
});
