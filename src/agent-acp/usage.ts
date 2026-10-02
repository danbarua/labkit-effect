/**
 * The session's context gauge as ACP's `usage_update`: the tokens in context now, the context window
 * of the model the session asks now, and the cost so far (`contextGauge`). What is known of the
 * model is `KnownModels`', so a host that knows a local model's window gives a gauge for it too.
 */

import { Effect } from "effect";
import type { SessionUpdate } from "../acp/schema/v1.gen.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { contextGauge } from "../agent-session/accounting.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { KnownModels } from "../agent-session/configuration/well-known-models.ts";

export type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

/** The `usage_update` of a session as `facts` have it; none when the window of the model it asks now is not known. */
export const usageUpdate = (facts: ReadonlyArray<Fact>): Effect.Effect<UsageUpdate | undefined> =>
  Effect.gen(function* () {
    const target = yield* modelOf(facts);
    const known = target.capabilities ?? (yield* (yield* KnownModels)(target.provider, target.model));
    const gauge = contextGauge(facts, target.provider, target.model, known);
    return gauge === undefined ? undefined : { sessionUpdate: "usage_update", used: gauge.used, size: gauge.size, cost: gauge.cost };
  });
