/**
 * What a provider's adapter makes of a session's settings for one model: the fields and headers it
 * adds to the request, and every setting it could not apply as asked, with the reason. The
 * function that makes it is pure; `reportAdjusted` records what was adjusted.
 */

import { Effect } from "effect";
import { AdjustmentReason, type TurnId } from "../agent-machine/names.ts";
import type { Effort, Adjusted, ModelSettings } from "../agent-machine/settings.ts";
import type { Target } from "./contracts.ts";
import { harnessParts } from "./origin.ts";
import { Report } from "./report.ts";
import type { Json } from "./shaping.ts";

export interface Adjustment {
  readonly adjusted: Adjusted;
  readonly reason: string;
}

export interface Settled {
  /** Fields added to the request body. */
  readonly fields: Readonly<Record<string, Json>>;
  /** Headers added to the request. */
  readonly headers: Readonly<Record<string, string>>;
  readonly adjusted: ReadonlyArray<Adjustment>;
}

/** Records each setting adjusted on the request the loop is carrying out for `turn`. */
export const reportAdjusted = (turn: TurnId, target: Target, settled: Settled): Effect.Effect<void> =>
  settled.adjusted.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const report = yield* Report;
        yield* Effect.forEach(
          settled.adjusted,
          ({ adjusted, reason }) =>
            report(
              {
                _tag: "SettingAdjusted",
                turn,
                provider: target.provider,
                model: target.model,
                adjusted,
                reason: AdjustmentReason.make(reason),
              },
              harnessParts.modelSettings,
            ),
          { discard: true },
        );
      });

/** Reasoning efforts in order, least first, as the Responses API names them. */
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const isEffort = (effort: string): effort is Effort => (["low", "medium", "high", "xhigh", "max"] as const).some((each) => each === effort);

/**
 * The reasoning effort to send for `settings` to a model that accepts `accepted`: the effort asked,
 * or `none` for thinking `off`, when an effort said beside it is returned as adjusted; one the model
 * does not accept is sent as the nearest it does, the higher of two as near, and that is returned as
 * adjusted. With no list, what was asked is sent.
 */
export function effortFor(
  settings: ModelSettings,
  accepted: ReadonlyArray<string> | undefined,
): { readonly sent: string | undefined; readonly adjusted: ReadonlyArray<Adjustment> } {
  const off = settings.thinking === "off";
  const wanted = off ? "none" : settings.effort;
  const set = (sent: string | undefined): ReadonlyArray<Adjustment> =>
    off && settings.effort !== undefined
      ? [{ adjusted: { _tag: "Effort", asked: settings.effort, ...(sent !== undefined && isEffort(sent) ? { used: sent } : {}) }, reason: `thinking is off, which is sent as reasoning effort ${sent ?? "none"}` }]
      : [];
  if (wanted === undefined || accepted === undefined || accepted.includes(wanted)) return { sent: wanted, adjusted: set(wanted) };
  const at = efforts.indexOf(wanted);
  const distance = (effort: string) => Math.abs(efforts.indexOf(effort) - at);
  const sent = [...accepted].sort((a, b) => distance(a) - distance(b) || efforts.indexOf(b) - efforts.indexOf(a))[0];
  if (sent === undefined) return { sent: wanted, adjusted: [] };
  const reason = `this model's reasoning efforts are ${accepted.join(", ")}; it is sent ${sent}`;
  if (off) return { sent, adjusted: [{ adjusted: { _tag: "Thinking", asked: "off", used: "auto" }, reason }, ...set(sent)] };
  const asked = settings.effort;
  return { sent, adjusted: asked === undefined ? [] : [{ adjusted: { _tag: "Effort", asked, ...(isEffort(sent) ? { used: sent } : {}) }, reason }] };
}
