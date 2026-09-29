/**
 * The model a session asks, from its facts: the one named by the latest change of model taken
 * (`ModelChangeTaken`), or `initial` when none has been. A session resumed from its facts therefore
 * asks the model it had switched to.
 */

import { Effect, Layer } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { ModelProvider, type Target } from "./contracts.ts";

/** The target of the latest change of model taken in `facts`, if any has been. */
export function currentModel(facts: ReadonlyArray<Fact>): Target | undefined {
  const taken = facts.flatMap((fact) =>
    fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : [],
  );
  const change = taken.at(-1);
  const arrived = facts.find(
    (fact) => fact.seq === change && fact._tag === "Observed" && fact.observation._tag === "ModelChangeArrived",
  );
  return arrived?._tag === "Observed" && arrived.observation._tag === "ModelChangeArrived"
    ? { provider: arrived.observation.provider, model: arrived.observation.model }
    : undefined;
}

export const ModelFromFacts = (initial: Target) =>
  Layer.succeed(ModelProvider, {
    select: (facts) => Effect.succeed(currentModel(facts) ?? initial),
  });
