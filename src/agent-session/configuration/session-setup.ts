/**
 * A session's set-up, recorded and read back.
 * - `openedWith` makes the `SessionOpened` observation from the model, system prompt and tools that
 *   a session starts with.
 * - The readers return, from a session's facts: the model that it asks now (the latest change of
 *   model taken, or the model it opened with), its settings, and the system prompt and tools that it
 *   opened with.
 *
 * Every request reads these from the facts, so the facts are the one place where they are held.
 */

import { Effect, Schema } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import type { SessionId } from "../../agent-machine/names.ts";
import type { ModelTarget, Observation } from "../../agent-machine/observation.ts";
import { changed, type ModelSettings } from "../../agent-machine/settings.ts";
import { type Target, ToolSpec } from "../contracts.ts";
import { asText, parseJson, receivedJson, receivedText } from "../received.ts";
import { settingOf } from "./settings.ts";

/** Tools as they are recorded: each tool's name, description, and the JSON Schema of its input. */
export const ToolSpecs = Schema.Array(ToolSpec);

type Opened = Extract<Observation, { _tag: "SessionOpened" }>;

export function openedWith(opening: {
  readonly session: SessionId;
  readonly model: ModelTarget;
  readonly system: string | undefined;
  readonly tools: ReadonlyArray<ToolSpec>;
}): Opened {
  return {
    _tag: "SessionOpened",
    session: opening.session,
    model: opening.model,
    ...(opening.system === undefined ? {} : { system: receivedText(opening.system) }),
    ...(opening.tools.length === 0 ? {} : { tools: receivedJson(Schema.encodeSync(ToolSpecs)(opening.tools) as Schema.Json) }),
  };
}

/**
 * Returns the session's opening, if its facts hold one. It is not exported, because the opening names
 * the model that the session started with, which is not the model it asks after a change has been
 * taken. `modelOf` is the one reader of the model.
 */
function openingOf(facts: ReadonlyArray<Fact>): Opened | undefined {
  const found = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "SessionOpened");
  return found?._tag === "Observed" && found.observation._tag === "SessionOpened" ? found.observation : undefined;
}

type Adjustment = Extract<Observation, { _tag: "SettingAdjusted" }>;

/** Returns `settings` with each adjusted setting replaced by the value that the model used. */
function withAdjusted(settings: ModelSettings, adjusted: ReadonlyArray<Adjustment>): ModelSettings {
  return adjusted.reduce<ModelSettings>((now, { adjusted: each }) => {
    const { [settingOf[each._tag]]: _asked, ...rest } = now;
    return each.used === undefined ? rest : { ...rest, [settingOf[each._tag]]: each.used };
  }, settings);
}

/**
 * Returns the model that the session asks now (the one named by the latest change taken, or the one
 * it opened with) and its settings.
 * - Each setting has the value last given, by the opening or by a change taken.
 * - When the model does not allow a value, the first request to it records the value used instead
 *   (`SettingAdjusted`). From then on that is the setting for that model, so later requests send
 *   what the model allows and nothing more is adjusted.
 * - For any other model, the value given still applies. Giving a setting again discards its
 *   adjustment.
 *
 * Facts without an opening belong to a session that was never opened: asking for its model is a
 * defect.
 */
export const modelOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> => {
  const opened = openingOf(facts)?.model;
  if (opened === undefined) return Effect.die(new Error("A model was asked for in a session that was never opened"));
  const changes = new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelChangeArrived" ? [[fact.seq, fact.observation] as const] : [],
    ),
  );
  const start = { provider: opened.provider, model: opened.model, requested: { ...opened.settings }, adjusted: [] as ReadonlyArray<Adjustment> };
  const now = facts.reduce((state, fact) => {
    if (fact._tag === "Observed")
      return fact.observation._tag === "SettingAdjusted" ? { ...state, adjusted: [...state.adjusted, fact.observation] } : state;
    const change = fact.decision._tag === "ModelChangeTaken" ? changes.get(fact.decision.change) : undefined;
    if (change === undefined) return state;
    const restated = new Set(Object.keys(change.settings ?? {}));
    return {
      provider: change.provider,
      model: change.model,
      requested: changed(state.requested, change.settings ?? {}),
      adjusted: state.adjusted.filter((each) => !restated.has(settingOf[each.adjusted._tag])),
    };
  }, start);
  const settings = withAdjusted(
    now.requested,
    now.adjusted.filter((each) => each.provider === now.provider && each.model === now.model),
  );
  return Effect.succeed({
    provider: now.provider,
    model: now.model,
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  });
};

/**
 * ImmutableSystemPrompt: returns the system prompt that the session opened with, if any. Every
 * request uses it; nothing records a system prompt after the opening.
 */
export const immutableSystemPromptOf = (facts: ReadonlyArray<Fact>): string | undefined => {
  const system = openingOf(facts)?.system;
  return system === undefined ? undefined : asText(system);
};

/**
 * ImmutableToolCatalog: returns the tools that the session opened with. Every request uses them;
 * nothing records tools after the opening. Tools recorded in a shape that does not decode are a
 * defect.
 */
export const immutableToolCatalogOf = (facts: ReadonlyArray<Fact>): Effect.Effect<ReadonlyArray<ToolSpec>> => {
  const tools = openingOf(facts)?.tools;
  if (tools === undefined) return Effect.succeed([]);
  const parsed = parseJson(tools);
  return "reason" in parsed
    ? Effect.die(new Error(`The session's recorded tools cannot be read: ${parsed.reason}`))
    : Schema.decodeUnknownEffect(ToolSpecs)(parsed.value).pipe(Effect.orDie);
};
