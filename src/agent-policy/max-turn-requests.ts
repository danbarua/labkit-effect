/**
 * A limit on a turn's model requests, ACP's `max_turn_requests`: a model request beyond the
 * `limit`-th of its turn is vetoed, which ends the turn; the reason's JSON says
 * `{ "stop": "max_turn_requests", "limit": <limit> }`, which an ACP host answers as that stop
 * reason. Counted from the facts (`requestsIn`), where the decision to make the request is recorded
 * before it is reviewed, so the request reviewed is counted.
 *
 * The default limit, 1000, is about two and a half times the most requests one real turn made in
 * the sessions in `trajectories/` (392, over an hour; 7,456 turns of Claude Code and Codex), so it
 * stops a turn that runs away and no turn that works.
 */

import { MediaType, ReceivedText } from "../agent-machine/received.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { requestsIn } from "../agent-machine/turn-requests.ts";
import type { Policy } from "./policy.ts";

export const defaultMaxTurnRequests = 1000;

/** The model request policy: vetoes a turn's request beyond the `limit`-th. */
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
