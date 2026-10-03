/**
 * How many model requests a turn has made, read from the facts: its steps, each asked for by a
 * decision (`AskModel`, `TellModel`) recorded before the request is made. A request a fallback
 * sends to another provider is the same request.
 */

import type { Fact } from "./fact.ts";
import type { TurnId } from "./names.ts";

/** How many model requests `turn` has made: its steps. */
export const requestsIn = (facts: ReadonlyArray<Fact>, turn: TurnId): number =>
  facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel") && fact.decision.turn === turn).length;
