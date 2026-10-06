/** How many times the turn-end hooks have held a turn open, read from the facts. */

import type { Fact } from "../agent-machine/fact.ts";
import type { TurnId } from "../agent-machine/names.ts";
import { harnessParts } from "./origin.ts";

/**
 * Returns how many times the turn-end hooks have held `turn` open: the reviews of the turn in which
 * the hooks gave feedback. Each hold is recorded as the hooks' feedback (input from the hooks)
 * followed by the review.
 */
export const holdsOf = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.reduce(
    (state, fact) => {
      if (fact._tag !== "Observed") return state;
      const fromHooks = fact.origin._tag === "Harness" && fact.origin.part === harnessParts.turnEndHooks.part;
      if (fact.observation._tag === "InputArrived" && fromHooks) return { ...state, feedback: true };
      if (fact.observation._tag !== "TurnEndReviewed" || fact.observation.turn !== turn) return state;
      return { holds: state.feedback ? state.holds + 1 : state.holds, feedback: false };
    },
    { holds: 0, feedback: false },
  ).holds;
