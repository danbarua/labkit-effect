/**
 * The session's context gauge as ACP's `usage_update`: the tokens in context now, the context window
 * of the model the session asks now, and the cost so far (`contextGauge`). The model's window comes
 * from `KnownModels`, so a host that knows a local model's window gets a gauge for that model too.
 */

import { Effect } from "effect";
import type { SessionUpdate } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import { contextGauge } from "../agent-session/accounting.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { knownCapabilities } from "../agent-session/configuration/well-known-models.ts";

export type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

/** Returns the `usage_update` of the session that `facts` record; undefined when the window of the model that the session asks now is not known. */
export const usageUpdate = (facts: ReadonlyArray<Fact>): Effect.Effect<UsageUpdate | undefined> =>
  Effect.gen(function* () {
    const target = yield* modelOf(facts);
    // `modelOf` returns no capabilities, so what is known of the model comes from `KnownModels`.
    const known = yield* knownCapabilities(target.provider, target.model);
    const gauge = contextGauge(facts, target.provider, target.model, known);
    return gauge === undefined ? undefined : { sessionUpdate: "usage_update", used: gauge.used, size: gauge.size, cost: gauge.cost };
  });
