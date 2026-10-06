/**
 * What a provider's adapter makes of a session's settings for one model: the fields and headers that
 * it adds to the request, and every setting that it could not apply as asked, with the reason. The
 * function that makes it is pure; `reportAdjusted` records what was adjusted.
 *
 * What each provider does with `cache`, in its own terms:
 *
 * | provider  | its setting                          | values             | `off`        | `5m`             | `1h`                 |
 * | --------- | ------------------------------------ | ------------------ | ------------ | ---------------- | -------------------- |
 * | anthropic | `cache_control` (`ttl`)              | absent, 5m, 1h     | nothing sent | `ephemeral`      | `ephemeral`, ttl 1h  |
 * | openai    | `prompt_cache_retention`             | no (minutes), yes (24h) | adjusted to `5m` | nothing sent | `"24h"`              |
 * | xai       | none: it always caches               | always             | not sent     | not sent         | not sent             |
 */

import { Array as Arr, Effect, Order } from "effect";
import { AdjustmentReason, TokenCount, type TurnId } from "../../agent-machine/names.ts";
import { CacheFor, Effort, type Adjusted, type ModelSettings, Observe, ThinkingMode } from "../../agent-machine/settings.ts";
import { type Capabilities, effortsTaken, turnsThinkingOff } from "./well-known-models.ts";
import type { Target } from "../contracts.ts";
import { harnessParts } from "../origin.ts";
import { Report } from "../report.ts";
import type { Json } from "../shaping.ts";

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

/** Records each setting adjusted on the request that the loop is carrying out for `turn`. */
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

/**
 * Returns the effort to send for `asked` to a model that takes the efforts `taken` (least first, from
 * `effortsTaken`), and what was adjusted:
 *
 * - With no `taken` (not known), the effort asked is sent.
 * - An effort that the model takes is sent as asked.
 * - An effort that it does not take is sent as the nearest effort that it takes (the higher one when
 *   two are equally near), and returned as adjusted.
 * - To a model that takes no effort (it takes a thinking budget, or does not reason), nothing is
 *   sent, and the effort is returned as adjusted.
 */
export function effortFor(
  asked: Effort | undefined,
  taken: ReadonlyArray<Effort> | undefined,
): { readonly sent: Effort | undefined; readonly adjusted: ReadonlyArray<Adjustment> } {
  if (asked === undefined || taken === undefined || taken.includes(asked)) return { sent: asked, adjusted: [] };
  if (taken.length === 0) return { sent: undefined, adjusted: [{ adjusted: { _tag: "Effort", asked }, reason: "this model takes no reasoning effort" }] };
  const at = Effort.literals.indexOf(asked);
  const distance = (effort: Effort) => Math.abs(Effort.literals.indexOf(effort) - at);
  // The nearest first; of two equally near, the higher.
  const nearest = Order.combine(Order.mapInput(Order.Number, distance), Order.mapInput(Order.flip(Order.Number), (effort: Effort) => Effort.literals.indexOf(effort)));
  const sent = Arr.sort(taken, nearest)[0] ?? asked;
  return { sent, adjusted: [{ adjusted: { _tag: "Effort", asked, used: sent }, reason: `this model's reasoning efforts are ${taken.join(", ")}; it is sent ${sent}` }] };
}

/**
 * Returns the reasoning effort to send, as the Responses and Chat Completions APIs take it, for
 * `settings` to a model with `capabilities`, and what was adjusted:
 *
 * - `thinking: disabled` is sent as effort `none` to a model that can turn its reasoning off
 *   (`turnsThinkingOff`: its efforts list `none`), or of which that is not known. An effort given
 *   with it is not sent, and is returned as adjusted. To a model that cannot (one that does not
 *   reason, or lists no `none`), nothing is sent for thinking, the thinking is returned as adjusted,
 *   and the effort given is sent as `effortFor` says.
 * - Otherwise the effort is sent as `effortFor` says, from the efforts the model takes
 *   (`effortsTaken`): none to a model that does not reason.
 */
export function reasoningEffortFor(
  settings: ModelSettings,
  capabilities: Capabilities | undefined,
): { readonly sent: string | undefined; readonly adjusted: ReadonlyArray<Adjustment> } {
  const taken = effortsTaken(capabilities);
  if (settings.thinking === "disabled") {
    if (turnsThinkingOff(capabilities) !== false) {
      const unsent: ReadonlyArray<Adjustment> =
        settings.effort === undefined ? [] : [{ adjusted: { _tag: "Effort", asked: settings.effort }, reason: "thinking is disabled, which is sent as reasoning effort none" }];
      return { sent: "none", adjusted: unsent };
    }
    const { sent, adjusted } = effortFor(settings.effort, taken);
    const reason = capabilities?.reasoning === false ? "this model does not reason" : "this model cannot turn its reasoning off";
    return { sent, adjusted: [{ adjusted: { _tag: "Thinking", asked: "disabled" }, reason }, ...adjusted] };
  }
  return effortFor(settings.effort, taken);
}

/** The setting an adjustment is about. */
export const settingOf = {
  Thinking: "thinking",
  Observe: "observe",
  Effort: "effort",
  MaxOutputTokens: "maxOutputTokens",
  Cache: "cache",
} as const satisfies Record<Adjusted["_tag"], keyof ModelSettings>;

/** The values to offer for each setting; for `maxOutputTokens`, which takes a number, whether to offer it. */
export interface SettingChoices {
  readonly effort: ReadonlyArray<Effort>;
  readonly thinking: ReadonlyArray<ThinkingMode>;
  readonly observe: ReadonlyArray<Observe>;
  readonly cache: ReadonlyArray<CacheFor>;
  readonly maxOutputTokens: boolean;
}

/**
 * Returns the values to offer for each setting of `target`, as it is set now: the values that the
 * provider's adapter (`settle`) applies as asked, together with the target's other settings. A value
 * that the adapter would adjust is not offered. A setting that the provider has no field for is
 * therefore offered no values, and what is offered for one setting depends on the others (no effort
 * while thinking is off).
 */
export function choicesFor(target: Target, settle: (target: Target) => Settled): SettingChoices {
  const applied = <K extends keyof ModelSettings>(name: K, value: NonNullable<ModelSettings[K]>): boolean =>
    !settle({ ...target, settings: { ...target.settings, [name]: value } }).adjusted.some(({ adjusted }) => settingOf[adjusted._tag] === name);
  return {
    effort: Effort.literals.filter((value) => applied("effort", value)),
    thinking: ThinkingMode.literals.filter((value) => applied("thinking", value)),
    observe: Observe.literals.filter((value) => applied("observe", value)),
    cache: CacheFor.literals.filter((value) => applied("cache", value)),
    maxOutputTokens: applied("maxOutputTokens", TokenCount.make(1)),
  };
}
