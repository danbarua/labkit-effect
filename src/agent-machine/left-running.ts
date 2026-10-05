/**
 * What facts that stop while a turn runs leave under way: the turn, and each request it made that
 * has no outcome in the facts. The process that carried out the requests ended; whoever continues
 * from the facts decides what becomes of them.
 *
 * A request has its outcome when the facts hold the observation that answers it:
 *
 * - a model request: `ModelResponded`, `ModelFailed` or `ModelVetoed` for its turn;
 * - a tool run: `ToolEnded` for its call;
 * - a turn-end review: `TurnEndReviewed` for its turn.
 *
 * `StopTurnWork` has no outcome of its own: `stopping` reports it, and each request that it stops
 * reports its own outcome.
 */

import type { Fact } from "./fact.ts";
import type { CallId, TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";
import type { EffectRequest } from "./request.ts";
import { deliver, emptyWorld, type World } from "./router.ts";

export interface LeftRunning {
  readonly turn: TurnId;
  /** The requests with no outcome, in the order they were made. */
  readonly requests: ReadonlyArray<Exclude<EffectRequest, { _tag: "StopTurnWork" }>>;
  /** Whether the turn requested `StopTurnWork`: it was interrupted. */
  readonly stopping: boolean;
  /** The calls among the requests whose tool began to run (`ToolCallDispatched`). */
  readonly began: ReadonlySet<CallId>;
}

/** Whether `observation` is the outcome of `request`. */
function answers(observation: Observation, request: EffectRequest): boolean {
  switch (request._tag) {
    case "RequestModelResponse":
      return (
        (observation._tag === "ModelResponded" || observation._tag === "ModelFailed" || observation._tag === "ModelVetoed") &&
        observation.turn === request.turn
      );
    case "RunTool":
      return observation._tag === "ToolEnded" && observation.call === request.call;
    case "BeforeTurnEnded":
      return observation._tag === "TurnEndReviewed" && observation.turn === request.turn;
    case "StopTurnWork":
      return true;
    default:
      return request satisfies never;
  }
}

/**
 * Returns the machines as `facts` leave them, and the requests in the facts that have no outcome.
 * Only the facts after the last turn's end are delivered, because between turns the machines hold
 * nothing that a later turn reads. The machines returned have none for a turn that ended before, so
 * an observation later addressed to such a turn is recorded as `ObservationUndelivered`.
 */
export function worldAndRequestsOf(facts: ReadonlyArray<Fact>): { readonly world: World; readonly requests: ReadonlyArray<EffectRequest> } {
  const ended = facts.reduce((last, fact, index) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? index : last), -1);
  return facts.slice(ended + 1).reduce<{ world: World; requests: ReadonlyArray<EffectRequest> }>(
    (replayed, fact) => {
      if (fact._tag !== "Observed") return replayed;
      const outcome = deliver(replayed.world, fact.seq, fact.observation);
      const unanswered = replayed.requests.filter((request) => request._tag === "StopTurnWork" || !answers(fact.observation, request));
      return { world: outcome.world, requests: [...unanswered, ...outcome.requests] };
    },
    { world: emptyWorld, requests: [] },
  );
}

/** Returns the turn that `facts` leave running, and the requests it left under way; undefined when the facts stop between turns. */
export function leftRunning(facts: ReadonlyArray<Fact>): LeftRunning | undefined {
  const { world, requests } = worldAndRequestsOf(facts);
  const agent = world.agent.state;
  if (agent._tag !== "Running") return undefined;
  const ofTurn = requests.filter((request) => request._tag === "RunTool" || request.turn === agent.turn);
  const began = new Set(
    ofTurn.flatMap((request) => {
      if (request._tag !== "RunTool") return [];
      const call = world.calls.get(request.call)?.state;
      return call?._tag === "Running" && call.began ? [request.call] : [];
    }),
  );
  return {
    turn: agent.turn,
    requests: ofTurn.flatMap((request) => (request._tag === "StopTurnWork" ? [] : [request])),
    stopping: ofTurn.some((request) => request._tag === "StopTurnWork"),
    began,
  };
}
