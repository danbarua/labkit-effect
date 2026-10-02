/**
 * What facts that stop while a turn runs leave under way: the turn, and each request it made that
 * has no outcome in the facts. The process that was carrying them out ended; whoever goes on from
 * the facts decides what becomes of them.
 *
 * A request has its outcome when the facts hold the observation that answers it: a model response
 * (`ModelResponded`, `ModelFailed`, `ModelVetoed`) for its turn; `ToolEnded` for a call;
 * `TurnEndReviewed` for a turn-end review. `StopTurnWork` has none of its own: it is the turn being
 * stopped, which `stopping` says, and the requests it stops answer for themselves.
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
  /** Whether the turn was asked to stop its work: it was interrupted. */
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
 * The machines as `facts` leave them, and the requests the facts made with no outcome in them. Between
 * turns the machines hold nothing, so only the facts after the last turn's end are delivered.
 */
export function worldAndRequestsOf(facts: ReadonlyArray<Fact>): { readonly world: World; readonly requests: ReadonlyArray<EffectRequest> } {
  const ended = facts.reduce((last, fact, index) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? index : last), -1);
  return facts.slice(ended + 1).reduce<{ world: World; requests: ReadonlyArray<EffectRequest> }>(
    (so, fact) => {
      if (fact._tag !== "Observed") return so;
      const outcome = deliver(so.world, fact.seq, fact.observation);
      const open = so.requests.filter((request) => request._tag === "StopTurnWork" || !answers(fact.observation, request));
      return { world: outcome.world, requests: [...open, ...outcome.requests] };
    },
    { world: emptyWorld, requests: [] },
  );
}

/** The turn `facts` leave running, and what it left under way; nothing when they stop between turns. */
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
