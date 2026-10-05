/**
 * A turn-end hook that asks the model again for its answer when its last response had none: a whole
 * response with no tool calls and no answer text, only thinking or commentary (`TurnIncomplete`).
 * Some local models put the whole answer in their reasoning.
 */

import { Effect } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import type { TurnEndHook } from "../agent-session/contracts.ts";
import { harnessParts } from "../agent-session/origin.ts";

/** The input that the model receives when its last response had thinking but no answer. */
export const answerNow = "Your last response had thinking but no answer. Give your answer now.";

/** Returns the tag of the latest decision that the facts record about `turn`. */
const latestDecision = (facts: ReadonlyArray<Fact>, turn: TurnId): string | undefined =>
  facts.flatMap((fact) => (fact._tag === "Decided" && "turn" in fact.decision && fact.decision.turn === turn ? [fact.decision._tag] : [])).at(-1);

/** Returns how many times the turn-end hooks have given `turn` feedback: their inputs since the turn started. */
const holdsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.reduce((holds, fact) => {
    if (fact._tag !== "Observed") return holds;
    if (fact.observation._tag === "TurnStarted" && fact.observation.turn === turn) return 0;
    const fromHooks = fact.origin._tag === "Harness" && fact.origin.part === harnessParts.turnEndHooks.part;
    return fromHooks && fact.observation._tag === "InputArrived" ? holds + 1 : holds;
  }, 0);

/**
 * The hook: returns `answerNow` when the latest decision about the turn is `TurnIncomplete` and the
 * hooks have not held the turn open `retries` times; returns nothing otherwise. An answered turn's
 * latest decision is `TurnCompleted`; a response cut short has neither, so its latest decision is the
 * request that asked for it. A turn still without an answer after its retries ends `Incomplete`.
 *
 * The hook counts every input that the turn-end hooks gave the turn, because the facts do not record
 * which hook gave it. With other hooks in the list, their holds count against its retries.
 */
export const retryIncomplete =
  (retries = 1): TurnEndHook =>
  (facts, turn) =>
    Effect.succeed(latestDecision(facts, turn) === "TurnIncomplete" && holdsIn(facts, turn) < retries ? [answerNow] : []);
