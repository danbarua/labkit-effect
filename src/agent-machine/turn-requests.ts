/**
 * How many model requests a turn has made, read from the facts. Each step's request follows its
 * decision (`AskModel` or `TellModel`), so the count is the number of those decisions for the turn.
 * A request that a fallback sends to another provider counts as the same request.
 */

import type { Fact } from "./fact.ts";
import type { TurnId } from "./names.ts";

/** Returns how many model requests `turn` has made: the number of its steps. */
export const requestsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel") && fact.decision.turn === turn).length;
