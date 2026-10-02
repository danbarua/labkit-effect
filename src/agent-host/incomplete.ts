/**
 * A turn-end hook that asks the model again for its answer when its last response held none: a
 * whole response with no tool calls and no answer text, only thinking or commentary
 * (`TurnIncomplete`, agent-machine I4). Some local models put the whole answer in their reasoning.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import { TurnEndHooks } from "../agent-session/contracts.ts";
import { harnessParts } from "../agent-session/origin.ts";
import { SessionStore } from "../agent-session/session-store.ts";

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
 * One hook: `answerNow` when the latest decision about the turn is `TurnIncomplete` and the hooks
 * have not held the turn open `retries` times, nothing otherwise. A turn answered has
 * `TurnCompleted` there; a response cut short has neither, so the latest is the request that asked
 * for it. A turn still without an answer after its retries ends `Incomplete`. The hook reads the
 * session's facts from the `SessionStore` the layer is built with: a hook's own type requires
 * nothing.
 *
 * The loop's own bound on holds is one above `retries`. The loop warns (`holds_exhausted`) when a
 * turn has used all its holds, without asking the hooks, and a retry that answered would then
 * warn though nothing was left unanswered; the hook counts its retries itself so that the bound is
 * never what stops it.
 */
export const RetryIncomplete = (retries = 1): Layer.Layer<TurnEndHooks, never, SessionStore> =>
  Layer.effect(
    TurnEndHooks,
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const hook = (turn: TurnId) =>
        Effect.map(store.facts, (facts) => (latestDecision(facts, turn) === "TurnIncomplete" && holdsIn(facts, turn) < retries ? [answerNow] : []));
      return { hooks: [hook], maxHolds: retries + 1 };
    }),
  );
