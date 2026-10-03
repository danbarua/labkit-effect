/**
 * A turn-end hook that asks the model again for its answer when its last response held none: a
 * whole response with no tool calls and no answer text, only thinking or commentary
 * (`TurnIncomplete`, agent-machine I4). Some local models put the whole answer in their reasoning.
 */

import { Effect } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import type { TurnEndHook } from "../agent-session/contracts.ts";
import { harnessParts } from "../agent-session/origin.ts";

/** What the model is told when its last response had thinking but no answer. */
export const answerNow = "Your last response had thinking but no answer. Give your answer now.";

/** The latest decision the facts record about `turn`. */
const latestDecision = (facts: ReadonlyArray<Fact>, turn: TurnId): string | undefined =>
  facts.flatMap((fact) => (fact._tag === "Decided" && "turn" in fact.decision && fact.decision.turn === turn ? [fact.decision._tag] : [])).at(-1);

/** How many times the turn-end hooks have given `turn` feedback: their inputs since the turn started. */
const holdsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.reduce((holds, fact) => {
    if (fact._tag !== "Observed") return holds;
    if (fact.observation._tag === "TurnStarted" && fact.observation.turn === turn) return 0;
    const fromHooks = fact.origin._tag === "Harness" && fact.origin.part === harnessParts.turnEndHooks.part;
    return fromHooks && fact.observation._tag === "InputArrived" ? holds + 1 : holds;
  }, 0);

/**
 * The hook: `answerNow` when the latest decision about the turn is `TurnIncomplete` and the hooks
 * have not held the turn open `retries` times, nothing otherwise. A turn answered has
 * `TurnCompleted` there; a response cut short has neither, so the latest is the request that asked
 * for it. A turn still without an answer after its retries ends `Incomplete`.
 *
 * It counts the inputs the turn-end hooks have given the turn, whichever hook gave them: the facts
 * do not say which. With other hooks in the list, their holds count against its retries.
 */
export const retryIncomplete =
  (retries = 1): TurnEndHook =>
  (facts, turn) =>
    Effect.succeed(latestDecision(facts, turn) === "TurnIncomplete" && holdsIn(facts, turn) < retries ? [answerNow] : []);
