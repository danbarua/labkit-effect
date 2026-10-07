/**
 * The session's context gauge as ACP's `usage_update`: the tokens in context now, the context window
 * of the model the session asks now, and the cost so far (`contextGauge`). The model's window comes
 * from `KnownModels`, so a host that knows a local model's window gets a gauge for that model too.
 * A cost that is not known is not shown as nothing spent: while no response of the session was priced
 * (`responseCost`: a local model's responses are not), the update has no `cost`.
 */

import { Effect } from "effect";
import type { SessionUpdate } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import { contextGauge, responseCost } from "../agent-session/accounting.ts";
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
    if (gauge === undefined) return undefined;
    const priced = facts.some((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && responseCost(fact.observation) !== undefined);
    return { sessionUpdate: "usage_update", used: gauge.used, size: gauge.size, ...(priced ? { cost: gauge.cost } : {}) };
  });
