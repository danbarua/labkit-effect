/**
 * Example policies for the gate in `src/agent-policy`: a deny list of tool names, asking a person
 * before a tool runs, holding model requests until a time, a spent budget, and a limit on a turn's
 * model requests. They show the shape
 * a policy takes; none is part of the policy layer, and none is wired into the loop.
 */

import type { Fact } from "../agent-machine/fact.ts";
import type { Policy } from "../agent-policy/policy.ts";
import { requestsIn } from "../agent-session/accounting.ts";
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

/**
 * Vetoes a turn's model request beyond the `limit`-th: ACP's `max_turn_requests`. `facts` are the
 * session's as recorded; the decision to make the request (`AskModel`, `TellModel`) is recorded
 * before it is asked for, so it is counted. The veto ends the turn; the host answers its prompt
 * with the stop reason `max_turn_requests`.
 */
export const maxTurnRequests = (limit: number, facts: () => ReadonlyArray<Fact>): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RequestModelResponse" && requestsIn(facts(), request.turn) > limit
      ? { _tag: "Decided", verdict: { _tag: "Veto", reason: receivedJson({ stop: "max_turn_requests", limit }) } }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
});
