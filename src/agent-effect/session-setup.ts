/**
 * A session's set-up, recorded and read back: `openedWith` makes the `SessionOpened` observation
 * from the model, system prompt and tools a session starts with; the readers give, from a session's
 * facts, the model it asks now (the latest change of model taken, or the one it opened with) and
 * the system prompt and tools it opened with. What a request is sent comes from these, so the
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

/** The model named by the latest change of model taken in `facts`, if any has been. */
function changedModel(facts: ReadonlyArray<Fact>): Target | undefined {
  const change = facts
    .flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : []))
    .at(-1);
  const arrived = facts.find(
    (fact) => fact.seq === change && fact._tag === "Observed" && fact.observation._tag === "ModelChangeArrived",
  );
  return arrived?._tag === "Observed" && arrived.observation._tag === "ModelChangeArrived"
    ? { provider: arrived.observation.provider, model: arrived.observation.model }
    : undefined;
}

/**
 * The model the session asks now. A session's facts without its opening is a session that was
 * never opened: asking for its model is a defect.
 */
export const modelOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> => {
  const model = changedModel(facts) ?? openingOf(facts)?.model;
  return model === undefined ? Effect.die(new Error("A model was asked for in a session that was never opened")) : Effect.succeed(model);
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
