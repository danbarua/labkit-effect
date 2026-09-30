/**
 * Records an observation in the session at once, with its origin, while the loop carries out a
 * request: for what happens during a request besides its outcome, such as a failed attempt at it.
 * The loop sets it
 * around each request; `yield* Report` gives the function. An observation reported outside a
 * request the loop carries out has no session to be recorded in, which is a defect.
 */

import { Context, Effect } from "effect";
import type { Observation } from "../agent-core/observation.ts";
import type { Origin } from "../agent-core/origin.ts";

export const Report = Context.Reference<(observation: Observation, origin: Origin) => Effect.Effect<void>>("agent-effect/Report", {
  defaultValue: () => (observation) =>
    Effect.die(new Error(`${observation._tag} was reported outside a request the loop carries out`)),
});
