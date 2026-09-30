/**
 * A session's set-up, recorded and read back: `openedWith` makes the `SessionOpened` observation
 * from the model, system prompt and tools a session starts with; the readers give, from a session's
 * facts, the model it asks now (the latest change of model taken, or the one it opened with), its
 * settings, and the system prompt and tools it opened with. What a request is sent comes from these, so the
 * facts are the one place they are held.
 */

import { Effect, Schema } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import type { SessionId } from "../agent-core/names.ts";
import type { ModelTarget, Observation } from "../agent-core/observation.ts";
import type { Enforced, ModelSettings } from "../agent-core/settings.ts";
import { type Target, ToolSpec } from "./contracts.ts";
import { asText, parseJson, receivedJson, receivedText } from "./received.ts";

/** Tools as they are recorded: each one's name, description, and the JSON Schema of its input. */
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
 * The session's opening, if its facts hold one. It is not exported: the opening names the model the
 * session started with, which is not the model it asks once a change has been taken. `modelOf` is
 * the one reader of the model.
 */
function openingOf(facts: ReadonlyArray<Fact>): Opened | undefined {
  const found = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "SessionOpened");
  return found?._tag === "Observed" && found.observation._tag === "SessionOpened" ? found.observation : undefined;
}

/** The setting an enforcement is about. */
const settingOf = {
  Thinking: "thinking",
  Observe: "observe",
  Effort: "effort",
  MaxOutputTokens: "maxOutputTokens",
} as const satisfies Record<Enforced["_tag"], keyof ModelSettings>;

type Enforcement = Extract<Observation, { _tag: "SettingEnforced" }>;

/** `settings` with what was enforced for a model in place of what was asked. */
function withEnforced(settings: ModelSettings, enforced: ReadonlyArray<Enforcement>): ModelSettings {
  return enforced.reduce<ModelSettings>((now, { enforced: each }) => {
    const { [settingOf[each._tag]]: _asked, ...rest } = now;
    return each.used === undefined ? rest : { ...rest, [settingOf[each._tag]]: each.used };
  }, settings);
}

/**
 * The model the session asks now: the one named by the latest change taken, or the one it opened
 * with; and its settings. Each setting is as last said, by the opening or a change taken. Where
 * that model does not allow what was said, the first request to it records what it used instead
 * (`SettingEnforced`), and from then on that is the setting for that model: the requests after it
 * are sent what the model allows, and nothing more is enforced. What was said stands for any other
 * model, and saying a setting again puts what was enforced for it aside.
 *
 * A session's facts without its opening is a session that was never opened: asking for its model
 * is a defect.
 */
export const modelOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> => {
  const opened = openingOf(facts)?.model;
  if (opened === undefined) return Effect.die(new Error("A model was asked for in a session that was never opened"));
  const changes = new Map(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelChangeArrived" ? [[fact.seq, fact.observation] as const] : [],
    ),
  );
  const start = { provider: opened.provider, model: opened.model, said: { ...opened.settings }, enforced: [] as ReadonlyArray<Enforcement> };
  const now = facts.reduce((state, fact) => {
    if (fact._tag === "Observed")
      return fact.observation._tag === "SettingEnforced" ? { ...state, enforced: [...state.enforced, fact.observation] } : state;
    const change = fact.decision._tag === "ModelChangeTaken" ? changes.get(fact.decision.change) : undefined;
    if (change === undefined) return state;
    const restated = new Set(Object.keys(change.settings ?? {}));
    return {
      provider: change.provider,
      model: change.model,
      said: { ...state.said, ...change.settings },
      enforced: state.enforced.filter((each) => !restated.has(settingOf[each.enforced._tag])),
    };
  }, start);
  const settings = withEnforced(
    now.said,
    now.enforced.filter((each) => each.provider === now.provider && each.model === now.model),
  );
  return Effect.succeed({
    provider: now.provider,
    model: now.model,
    ...(Object.keys(settings).length === 0 ? {} : { settings }),
  });
};

/** The system prompt the session opened with, if it has one. */
export const systemOf = (facts: ReadonlyArray<Fact>): string | undefined => {
  const system = openingOf(facts)?.system;
  return system === undefined ? undefined : asText(system);
};

/** The tools the session opened with. Tools recorded in a shape they do not decode from are a defect. */
export const toolsOf = (facts: ReadonlyArray<Fact>): Effect.Effect<ReadonlyArray<ToolSpec>> => {
  const tools = openingOf(facts)?.tools;
  if (tools === undefined) return Effect.succeed([]);
  const parsed = parseJson(tools);
  return "reason" in parsed
    ? Effect.die(new Error(`The session's recorded tools cannot be read: ${parsed.reason}`))
    : Schema.decodeUnknownEffect(ToolSpecs)(parsed.value).pipe(Effect.orDie);
};
