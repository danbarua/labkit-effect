/**
 * A session's set-up, recorded and read back: `openedWith` makes the `SessionOpened` observation
 * from the model, system prompt and tools a session starts with; the readers give, from a session's
 * facts, the model it asks now (the latest change of model taken, or the one it opened with), its
 * settings, and the system prompt and tools it opened with. What a request is sent comes from these, so the
 * facts are the one place they are held.
 */

import { Effect, Schema } from "effect";
import type { Fact } from "../agent-core/fact.ts";
import { ToolName, type SessionId } from "../agent-core/names.ts";
import type { ModelTarget, Observation } from "../agent-core/observation.ts";
import type { Target, ToolSpec } from "./contracts.ts";
import { asText, parseJson, receivedJson, receivedText } from "./received.ts";

/** Tools as they are recorded: each one's name, description, and the JSON Schema of its input. */
export const ToolSpecs = Schema.Array(Schema.Struct({ name: ToolName, description: Schema.String, input: Schema.Json }));

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

/** The session's opening, if its facts hold one. */
export function openingOf(facts: ReadonlyArray<Fact>): Opened | undefined {
  const found = facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "SessionOpened");
  return found?._tag === "Observed" && found.observation._tag === "SessionOpened" ? found.observation : undefined;
}

/** The changes of model taken in `facts`, in order. */
function changesTaken(facts: ReadonlyArray<Fact>): ReadonlyArray<Extract<Observation, { _tag: "ModelChangeArrived" }>> {
  const taken = new Set(
    facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : [])),
  );
  return facts.flatMap((fact) =>
    taken.has(fact.seq) && fact._tag === "Observed" && fact.observation._tag === "ModelChangeArrived" ? [fact.observation] : [],
  );
}

/**
 * The model the session asks now: the one named by the latest change taken, or the one it opened
 * with; and its settings, each as last said by the opening or a change taken. A session's facts
 * without its opening is a session that was never opened: asking for its model is a defect.
 */
export const modelOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> => {
  const opened = openingOf(facts)?.model;
  if (opened === undefined) return Effect.die(new Error("A model was asked for in a session that was never opened"));
  const changes = changesTaken(facts);
  const latest = changes.at(-1) ?? opened;
  const settings = changes.reduce((said, change) => ({ ...said, ...change.settings }), { ...opened.settings });
  return Effect.succeed({
    provider: latest.provider,
    model: latest.model,
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
