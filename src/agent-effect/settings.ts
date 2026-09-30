/**
 * What a provider's adapter makes of a session's settings for one model: the fields and headers it
 * adds to the request, and every setting it could not apply as asked, with the reason. The
 * function that makes it is pure; `reportEnforced` records what was enforced.
 */

import { Effect } from "effect";
import { EnforcementReason, type TurnId } from "../agent-core/names.ts";
import type { Enforced } from "../agent-core/settings.ts";
import type { Target } from "./contracts.ts";
import { harnessParts } from "./origin.ts";
import { Report } from "./report.ts";
import type { Json } from "./shaping.ts";

export interface Enforcement {
  readonly enforced: Enforced;
  readonly reason: string;
}

export interface Settled {
  /** Fields added to the request body. */
  readonly fields: Readonly<Record<string, Json>>;
  /** Headers added to the request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly enforced: ReadonlyArray<Enforcement>;
}

/** Records each setting enforced on the request the loop is carrying out for `turn`. */
export const reportEnforced = (turn: TurnId, target: Target, settled: Settled): Effect.Effect<void> =>
  settled.enforced.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const report = yield* Report;
        yield* Effect.forEach(
          settled.enforced,
          ({ enforced, reason }) =>
            report(
              {
                _tag: "SettingEnforced",
                turn,
                provider: target.provider,
                model: target.model,
                enforced,
                reason: EnforcementReason.make(reason),
              },
              harnessParts.modelSettings,
            ),
          { discard: true },
        );
      });
