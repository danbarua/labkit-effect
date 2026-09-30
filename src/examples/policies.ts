/**
 * Example policies for the gate in `src/agent-policy`: a deny list of tool names, asking a person
 * before a tool runs, holding model requests until a time, and a spent budget. They show the shape
 * a policy takes; none is part of the policy layer, and none is wired into the loop.
 */

import type { Policy } from "../agent-policy/policy.ts";
import { asText, receivedJson } from "../agent-session/received.ts";

/** Vetoes running any tool named in `denied`. */
export const denyTools = (denied: ReadonlyArray<string>): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RunTool" && denied.includes(request.tool)
      ? { _tag: "Decided", verdict: { _tag: "Veto", reason: receivedJson({ denied: request.tool }) } }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
});

/** Asks a person before any tool runs; continues on "yes", vetoes on anything else. */
export const askPerson: Policy<unknown> = {
  start: (request) =>
    request._tag === "RunTool"
      ? { _tag: "Waiting", state: request.call, asks: receivedJson({ question: "run?", tool: request.tool }) }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: (_state, message) =>
    message._tag === "Answered" && asText(message.answer) === "yes"
      ? { _tag: "Decided", verdict: { _tag: "Continue" } }
      : message._tag === "Answered"
        ? { _tag: "Decided", verdict: { _tag: "Veto", reason: receivedJson({ person: asText(message.answer) }) } }
        : { _tag: "Waiting", state: _state, asks: undefined },
};

/** Holds every model request until the clock reaches `at`: a rate limit, a budget window. */
export const notBefore = (at: number): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RequestModelResponse"
      ? { _tag: "Waiting", state: at, asks: undefined }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: (state, message) =>
    message._tag === "Tick" && message.at >= (state as number)
      ? { _tag: "Decided", verdict: { _tag: "Continue" } }
      : { _tag: "Waiting", state, asks: undefined },
});

/** Vetoes every request, with the reason that the month's budget is used. */
export const budgetSpent: Policy<unknown> = {
  start: () => ({ _tag: "Decided", verdict: { _tag: "Veto", reason: receivedJson({ budget: "80% of the month used" }) } }),
  receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
};
