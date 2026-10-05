/**
 * A limit on the number of model requests in one turn (ACP's `max_turn_requests`). A model request
 * beyond the turn's `limit`-th is vetoed, which ends the turn. The veto's reason is the JSON
 * `{ "stop": "max_turn_requests", "limit": <limit> }`, which an ACP host reports as that stop
 * reason. The count comes from the facts (`requestsIn`). The decision to make a request is recorded
 * before the request is reviewed, so the count includes the request under review.
 *
 * The default limit, 1000, is about two and a half times the most requests that one real turn made
 * in the sessions in `trajectories/` (392, over an hour, among 7,456 turns of Claude Code and
 * Codex). It stops a turn that runs away and no turn that works.
 */

import { MediaType, ReceivedText } from "../agent-machine/received.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { requestsIn } from "../agent-machine/turn-requests.ts";
import type { Policy } from "./policy.ts";

export const defaultMaxTurnRequests = 1000;

/** The model request policy: vetoes a turn's model request beyond the `limit`-th. */
export const maxTurnRequests = (facts: ReadonlyArray<Fact>, limit: number = defaultMaxTurnRequests): Policy<unknown> => ({
  start: (request) =>
    request._tag === "RequestModelResponse" && requestsIn(facts, request.turn) > limit
      ? {
          _tag: "Decided",
          verdict: {
            _tag: "Veto",
            reason: { mediaType: MediaType.make("application/json"), body: { _tag: "Text", text: ReceivedText.make(JSON.stringify({ stop: "max_turn_requests", limit })) } },
          },
        }
      : { _tag: "Decided", verdict: { _tag: "Continue" } },
  receive: () => ({ _tag: "Decided", verdict: { _tag: "Continue" } }),
});
