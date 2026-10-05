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

/** Reasoning efforts in order, least first, as the Responses API names them. */
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const isEffort = (effort: string): effort is Effort => Effort.literals.some((each) => each === effort);

/**
 * Returns the reasoning effort to send for `settings` to a model that accepts `accepted`, and the
 * adjustments made.
 * - The effort sent is the effort asked, or `none` when thinking is `off`. When thinking is `off`
 *   and an effort was also given, that effort is returned as adjusted.
 * - An effort that the model does not accept is sent as the nearest accepted effort (the higher one
 *   when two are equally near), and returned as adjusted.
 * - With no `accepted` list, the effort asked is sent.
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
  // The nearest first; of two equally near, the higher.
  const nearest = Order.combine(Order.mapInput(Order.Number, distance), Order.mapInput(Order.flip(Order.Number), (effort: string) => efforts.indexOf(effort)));
  const sent = Arr.sort(accepted, nearest)[0];
  if (sent === undefined) return { sent: wanted, adjusted: [] };
  const reason = `this model's reasoning efforts are ${accepted.join(", ")}; it is sent ${sent}`;
  if (off) return { sent, adjusted: [{ adjusted: { _tag: "Thinking", asked: "off", used: "auto" }, reason }, ...set(sent)] };
  const asked = settings.effort;
  return { sent, adjusted: asked === undefined ? [] : [{ adjusted: { _tag: "Effort", asked, ...(isEffort(sent) ? { used: sent } : {}) }, reason }] };
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
