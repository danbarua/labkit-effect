/**
 * Records an observation in the session at once, with its origin, while the loop carries out a
 * request. It is for what happens during a request besides its outcome, such as a failed attempt.
 * The loop sets it around each request; `yield* Report` returns the function. An observation
 * reported outside a request has no session to be recorded in, which is a defect.
 */

import { Context, Effect } from "effect";
import type { Observation } from "../agent-machine/observation.ts";
import type { Origin } from "../agent-machine/origin.ts";

export const Report = Context.Reference<(observation: Observation, origin: Origin) => Effect.Effect<void>>("agent-session/Report", {
  defaultValue: () => (observation) =>
    Effect.die(new Error(`${observation._tag} was reported outside a request the loop carries out`)),
});
