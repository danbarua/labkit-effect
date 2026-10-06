/**
 * The session's model and its settings as the CLI reads them (`--effort`, `--thinking`, `/settings`)
 * and shows them (`inForce`).
 */

import { Effect, Schema } from "effect";
import { ModelSettings } from "../../agent-machine/settings.ts";
import type { Session } from "../../agent-session/loop.ts";
import { modelOf } from "../../agent-session/configuration/session-setup.ts";
import { knownCapabilities } from "../../agent-session/configuration/well-known-models.ts";
import { invalid } from "./invalid.ts";

/** The settings said after the model's name: those sent; when none are, saying so unless some were not sent to this model. */
const settingsSaid = (sent: ReadonlyArray<string>, notSent: number): string => {
  if (sent.length > 0) return ` ${sent.join(" ")}`;
  return notSent === 0 ? " (no settings said)" : "";
};

/**
 * The model and settings the session's next request goes with, in a line; then the settings that
 * were said and that this model was not sent, with the adapter's reason, so they are not taken for
 * never said.
 */
export const inForce = (session: Session) =>
  Effect.gen(function* () {
    const facts = yield* session.facts;
    const target = yield* modelOf(facts);
    const sent = Object.entries(target.settings ?? {}).map(([name, value]) => `${name}=${String(value)}`);
    const notSent = new Map(
      facts.flatMap((fact) => {
        if (fact._tag !== "Observed" || fact.observation._tag !== "SettingAdjusted") return [];
        const { provider, model, adjusted, reason } = fact.observation;
        const name = adjusted._tag.charAt(0).toLowerCase() + adjusted._tag.slice(1);
        return provider === target.provider && model === target.model && adjusted.used === undefined && adjusted.asked !== undefined && !(name in (target.settings ?? {}))
          ? [[name, `${name}=${String(adjusted.asked)} (${reason})`] as const]
          : [];
      }),
    );
    const known = yield* knownCapabilities(target.provider, target.model);
    return [
      `${target.provider}/${target.model}${settingsSaid(sent, notSent.size)}`,
      ...(notSent.size === 0 ? [] : [`not sent to this model: ${[...notSent.values()].join(", ")}`]),
      ...(known?.efforts === undefined ? [] : [`this model takes effort: ${known.efforts.join(", ")}`]),
    ].join("\n");
  });

/** The settings `name=value …` names, as `settingsGiven` reads them. */
export const settingsFrom = (words: ReadonlyArray<string>) =>
  settingsGiven(
    Object.fromEntries(
      words.map((word) => {
        const [name = "", value = ""] = word.split("=");
        return [name, /^\d+$/.test(value) ? Number(value) : value];
      }),
    ),
  );

/**
 * Settings as the CLI takes them (`/settings`, `--effort`, `--thinking`), read by the core's grammar
 * (`ModelSettings`); a name or value the grammar does not know is refused, saying why. The CLI
 * also takes `effort=none`, which is `thinking=off`: the core has no effort `none`, and a provider's
 * adapter sends thinking off as that provider says it (effort `none` to OpenAI and xAI, `thinking:
 * disabled` to Anthropic). `effort=none` with a thinking mode other than `off` is refused.
 */
export const settingsGiven = (given: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const { effort, ...rest } = given;
    const thinking = rest["thinking"];
    if (effort === "none" && thinking !== undefined && thinking !== "off")
      return yield* invalid(`effort=none is thinking=off, and thinking=${typeof thinking === "string" ? thinking : JSON.stringify(thinking)} says otherwise.`);
    const said = effort === "none" ? { ...rest, thinking: "off" } : given;
    return yield* Schema.decodeEffect(ModelSettings)(said, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => invalid(`Not settings the session takes: ${error.message}`)),
    );
  });

