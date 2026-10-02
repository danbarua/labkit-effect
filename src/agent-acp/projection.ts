/**
 * The projection of a session to ACP's `session/update`: one pure, incremental function from the
 * core's facts, the parts a response completes while it streams (`ModelPartArrived`) and the text
 * of a part as it arrives (`Delta`), to the updates each gives. Live, a host feeds it what
 * `session.subscribe` and `session.streamed` pass on and the deltas; on `session/load`, the stored
 * facts (`project`). The two differ only in `mode`: live, an input is not echoed, since the client
 * has what it sent.
 *
 * Inputs are taken in the order they happened. A response's text is sent once: as deltas arrive,
 * then what of each part no delta carried when the part is whole (`ModelPartArrived`, or the
 * response's `ModelResponded`). A tool call is announced once, by whichever of `ToolCallArrived`,
 * its `ModelPartArrived` or its response comes first; its status follows the call's facts.
 *
 * Not here, the host's own: `usage_update`, `session_info_update`, `available_commands_update`,
 * `config_option_update`, `current_mode_update`, `plan`, and `session/request_permission`.
 */

import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "../acp/schema/v1.gen.ts";
import { ToolCallId } from "../acp/schema/v1.gen.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { type CallId, StepIndex, type ToolName, type TurnId } from "../agent-machine/names.ts";
import type { CapturedObservation, ModelPart, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { asText } from "../agent-session/received.ts";

/**
 * Text of a response's part as it arrives: `response` is the request within `turn` that the
 * response answers (its step, from 1), `part` the part's index among the response's parts, from 0,
 * as `ModelResponded` holds them. The deltas of a part, joined, are the part's text: `Text` or
 * `Commentary` for `text`, `Thinking` for `thinking`.
 */
export interface Delta {
  readonly _tag: "Delta";
  readonly turn: TurnId;
  readonly response: StepIndex;
  readonly part: number;
  readonly kind: "text" | "thinking";
  readonly text: string;
}

type PartArrived = Extract<CapturedObservation, { _tag: "ModelPartArrived" }>;

/** What the projection takes: a fact, a part completed while its response streams, or a delta. */
export type ProjectionInput = Fact | PartArrived | Delta;

/** A tool call as the model made it. */
export interface Call {
  readonly call: CallId;
  readonly tool: ToolName;
  readonly input: Received;
}

/** How a tool call is shown: when it is announced, and again with its outcome when it ends. */
export interface Presented {
  readonly title: string;
  readonly kind?: ToolKind;
  readonly locations?: ReadonlyArray<ToolCallLocation>;
  readonly content?: ReadonlyArray<ToolCallContent>;
}

/** The host's presentation of a tool call, without its outcome while it has none. */
export type Present = (call: Call, outcome?: ToolOutcome) => Presented;

export interface ProjectionContext {
  /** `replay` echoes each input as `user_message_chunk`; `live` does not. */
  readonly mode: "live" | "replay";
  readonly present: Present;
}

/** A tool failure in words, for a reader. */
const failureText = (tool: ToolName, reason: ToolFailure): string => {
  switch (reason._tag) {
    case "Reported":
      return asText(reason.error);
    case "InputRejected":
      return `The input was rejected: ${reason.problem}`;
    case "Vetoed":
      return `Not run: ${asText(reason.reason)}`;
    case "NotFound":
      return `No tool is named ${tool}`;
    case "NotRun":
      return "Not run";
    case "Indeterminate":
      return "How it ended was not observed";
    default:
      return reason satisfies never;
  }
};

const text = (value: string): ContentBlock => ({ type: "text", text: value });

/**
 * The default presentation over the session's tool catalog (`immutableToolCatalogOf`): the tool's
 * name as the title, its kind from the catalog (none for a tool the catalog does not have), and,
 * once it ends, its output, or why it failed, as text.
 */
export const presentFrom =
  (catalog: ReadonlyArray<ToolSpec>): Present =>
  (call, outcome) => {
    const kind = catalog.find((tool) => tool.name === call.tool)?.kind;
    const shown = outcome === undefined ? undefined : outcome._tag === "Succeeded" ? asText(outcome.output) : failureText(call.tool, outcome.reason);
    return {
      title: call.tool,
      ...(kind === undefined ? {} : { kind }),
      ...(shown === undefined ? {} : { content: [{ type: "content", content: text(shown) }] }),
    };
  };

/** The response under way: its turn, its step when known, and how much of each part was sent. */
interface Response {
  readonly turn: TurnId;
  readonly step: StepIndex | undefined;
  /** How many of its parts `ModelPartArrived` completed: the index of the next. */
  readonly arrived: number;
  /** By part index: the characters of the part's text sent, and whether the part was whole when sent. */
  readonly sent: ReadonlyMap<number, { readonly length: number; readonly whole: boolean }>;
  /** Its `ModelResponded` was taken: what arrives for it after is not sent. */
  readonly responded: boolean;
}

export interface ProjectionState {
  readonly response: Response | undefined;
  /** The calls announced, as they were presented. */
  readonly calls: ReadonlyMap<CallId, { readonly call: Call; readonly shown: Presented }>;
}

export const start: ProjectionState = { response: undefined, calls: new Map() };

export interface Projected {
  readonly state: ProjectionState;
  readonly updates: ReadonlyArray<SessionUpdate>;
}

const fresh = (turn: TurnId, step: StepIndex | undefined): Response => ({ turn, step, arrived: 0, sent: new Map(), responded: false });

/** The response that `turn` (and `step`, when given) names: the one under way, or a new one. */
const responseFor = (state: ProjectionState, turn: TurnId, step?: StepIndex): Response => {
  const now = state.response;
  if (now !== undefined && now.turn === turn && (step === undefined || now.step === undefined || now.step === step))
    return now.step === undefined && step !== undefined ? { ...now, step } : now;
  return fresh(turn, step);
};

const chunkOf = (kind: "text" | "thinking", value: string): SessionUpdate =>
  kind === "text" ? { sessionUpdate: "agent_message_chunk", content: text(value) } : { sessionUpdate: "agent_thought_chunk", content: text(value) };

/** A part's text and whether it is answer text or thinking; none for a part with no text to show. */
const textOf = (part: ModelPart): { readonly kind: "text" | "thinking"; readonly text: string } | undefined => {
  switch (part._tag) {
    case "Text":
    case "Commentary":
      return { kind: "text", text: part.text };
    case "Thinking":
      return { kind: "thinking", text: part.text };
    default:
      return undefined;
  }
};

/** Announces `call` as `pending`, unless it was announced. */
const announce = (state: ProjectionState, call: Call, context: ProjectionContext): Projected => {
  if (state.calls.has(call.call)) return { state, updates: [] };
  const shown = context.present(call);
  return {
    state: { ...state, calls: new Map(state.calls).set(call.call, { call, shown }) },
    updates: [
      {
        sessionUpdate: "tool_call",
        toolCallId: ToolCallId.make(call.call),
        title: shown.title,
        status: "pending",
        ...(shown.kind === undefined ? {} : { kind: shown.kind }),
        ...(shown.locations === undefined ? {} : { locations: shown.locations }),
        ...(shown.content === undefined ? {} : { content: shown.content }),
      },
    ],
  };
};

/** The whole part at `index` of `response`: what of its text was not sent, and the call it makes. */
const whole = (state: ProjectionState, response: Response, index: number, part: ModelPart, context: ProjectionContext): Projected => {
  if (part._tag === "ToolCall") return announce({ ...state, response }, { call: part.call, tool: part.tool, input: part.input }, context);
  const shown = textOf(part);
  const sent = response.sent.get(index);
  const rest = shown === undefined || sent?.whole === true ? "" : shown.text.slice(sent?.length ?? 0);
  const next: Response = { ...response, sent: new Map(response.sent).set(index, { length: shown?.text.length ?? 0, whole: true }) };
  return { state: { ...state, response: next }, updates: shown === undefined || rest === "" ? [] : [chunkOf(shown.kind, rest)] };
};

const nothing = (state: ProjectionState): Projected => ({ state, updates: [] });

const status = (call: CallId, value: "pending" | "in_progress"): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: ToolCallId.make(call),
  status: value,
});

/** The updates `input` gives, and the state to take the next input from. */
export function next(state: ProjectionState, input: ProjectionInput, context: ProjectionContext): Projected {
  switch (input._tag) {
    case "Delta": {
      const response = responseFor(state, input.turn, input.response);
      const sent = response.sent.get(input.part);
      if (response.responded || sent?.whole === true || input.text === "") return { state: { ...state, response }, updates: [] };
      const now: Response = { ...response, sent: new Map(response.sent).set(input.part, { length: (sent?.length ?? 0) + input.text.length, whole: false }) };
      return { state: { ...state, response: now }, updates: [chunkOf(input.kind, input.text)] };
    }
    case "ModelPartArrived": {
      const response = responseFor(state, input.turn);
      if (response.responded) return nothing(state);
      return whole(state, { ...response, arrived: response.arrived + 1 }, response.arrived, input.part, context);
    }
    case "Decided": {
      const decision = input.decision;
      if (decision._tag === "AskModel" || decision._tag === "TellModel") {
        const step = decision._tag === "AskModel" ? StepIndex.make(1) : decision.step;
        const now = state.response;
        const same = now !== undefined && now.turn === decision.turn && (now.step === undefined || now.step === step);
        return nothing({ ...state, response: same ? { ...now, step } : fresh(decision.turn, step) });
      }
      return nothing(state);
    }
    case "Observed": {
      const observation = input.observation;
      switch (observation._tag) {
        case "InputArrived":
          return { state, updates: context.mode === "replay" ? [{ sessionUpdate: "user_message_chunk", content: text(observation.text) }] : [] };
        case "ModelResponded": {
          const under = responseFor(state, observation.turn);
          const response = under.responded ? fresh(observation.turn, under.step) : under;
          const done = observation.parts.reduce<Projected>(
            (so, part, index) => {
              const step = whole(so.state, so.state.response ?? response, index, part, context);
              return { state: step.state, updates: [...so.updates, ...step.updates] };
            },
            { state: { ...state, response }, updates: [] },
          );
          const after = done.state.response ?? response;
          return { state: { ...done.state, response: { ...after, sent: new Map(), responded: true } }, updates: done.updates };
        }
        case "ToolCallArrived":
          return announce(state, { call: observation.call, tool: observation.tool, input: observation.input }, context);
        case "PermissionAsked":
          return { state, updates: [status(observation.call, "pending")] };
        case "ToolCallDispatched":
          return { state, updates: [status(observation.call, "in_progress")] };
        case "ToolEnded": {
          const known = state.calls.get(observation.call);
          const outcome = observation.outcome;
          const shown = known === undefined ? undefined : context.present(known.call, outcome);
          return {
            state,
            updates: [
              {
                sessionUpdate: "tool_call_update",
                toolCallId: ToolCallId.make(observation.call),
                status: outcome._tag === "Succeeded" ? "completed" : "failed",
                ...(shown === undefined || shown.title === known?.shown.title ? {} : { title: shown.title }),
                ...(shown?.kind === undefined || shown.kind === known?.shown.kind ? {} : { kind: shown.kind }),
                ...(shown?.locations === undefined ? {} : { locations: shown.locations }),
                ...(shown?.content === undefined ? {} : { content: shown.content }),
              },
            ],
          };
        }
        default:
          return nothing(state);
      }
    }
    default:
      return input satisfies never;
  }
}

/** The updates `inputs` give, in order, from `from`; and the state after them. */
export function project(inputs: ReadonlyArray<ProjectionInput>, context: ProjectionContext, from: ProjectionState = start): Projected {
  const updates: Array<SessionUpdate> = [];
  let state = from;
  for (const input of inputs) {
    const step = next(state, input, context);
    state = step.state;
    updates.push(...step.updates);
  }
  return { state, updates };
}
