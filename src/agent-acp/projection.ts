/**
 * The projection of a session to ACP's `session/update`: one pure, incremental function from the
 * core's facts (`session.subscribe`) and what it passes on while a model responds (`session.streamed`,
 * `CapturedObservation`) to the updates each gives. Live, a host merges the two feeds; on
 * `session/load`, it projects the stored facts (`project`). The two differ in `mode`: live, an input
 * is not echoed, since the client has what it sent.
 *
 * The two feeds keep their own order, and none between them: a request's deltas can come before or
 * after its `ModelResponded`, and the host may be a request or a turn ahead on either. Text is sent
 * once whatever the merge. Each feed holds a turn's model requests in the same order, so the
 * projection pairs them by position: a request's end item (`ModelResponseEnded`) on the captured
 * feed with its outcome (`ModelResponded`) on the facts. Live, a delta is sent as it comes;
 * `ModelResponded` sends what of each part its request's deltas did not. A tool call is announced
 * once, by whichever of `ToolCallArrived`, its `ModelPartArrived` or its response comes first; its
 * status follows the call's facts.
 *
 * Not here, the host's own: `usage_update`, `session_info_update`, `available_commands_update`,
 * `config_option_update`, `current_mode_update`, `plan`, and `session/request_permission`.
 */

import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "../acp/schema/v1.gen.ts";
import { ToolCallId } from "../acp/schema/v1.gen.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { CallId, ToolName, TurnId } from "../agent-machine/names.ts";
import type { CapturedObservation, ModelPart, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { asText } from "../agent-session/received.ts";

/** What the projection takes: a fact, or an item a model request passed on while it ran. */
export type ProjectionInput = Fact | CapturedObservation;

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


/** The kinds of text a delta carries, as `ModelDelta` names them. */
type TextKind = "Text" | "Commentary" | "Thinking";

/** The length of the delta text sent, by kind. */
type Sent = { readonly [Kind in TextKind]: number };

const none: Sent = { Text: 0, Commentary: 0, Thinking: 0 };

/**
 * One turn's text, live: what its requests' deltas sent, until each request's `ModelResponded` is
 * taken. Of a turn's requests, the captured feed has ended the first `c` (their end items) and the
 * facts have answered the first `a`; at most one of `awaiting` and `ahead` is not empty.
 */
interface TurnText {
  /** What the deltas of the request streaming now sent; none while `ahead`, whose deltas are dropped. */
  readonly streaming: Sent;
  /**
   * Of each kind, the deltas of only whitespace since its last text sent: sent with the next text of
   * that kind, and dropped when a call or the response's end comes first, so that a client shows no
   * blank message. They count as sent.
   */
  readonly held: { readonly [Kind in TextKind]?: string };
  /** Of each request ended but not answered yet, in order: what its deltas sent. */
  readonly awaiting: ReadonlyArray<Sent>;
  /** How many requests were answered (`ModelResponded`) before their end item: their deltas are dropped. */
  readonly ahead: number;
}

const fresh: TurnText = { streaming: none, held: {}, awaiting: [], ahead: 0 };

const blank = (value: string): boolean => value.trim() === "";

export interface ProjectionState {
  /** The text of each turn under way, by the turn: made by the first input that names it. */
  readonly texts: ReadonlyMap<TurnId, TurnText>;
  /** The turns ended (`TurnEnded`): what is captured of them after is dropped, its text sent by their facts. */
  readonly ended: ReadonlySet<TurnId>;
  /** The calls announced, as they were presented. */
  readonly calls: ReadonlyMap<CallId, { readonly call: Call; readonly shown: Presented }>;
}

export const start: ProjectionState = { texts: new Map(), ended: new Set(), calls: new Map() };

export interface Projected {
  readonly state: ProjectionState;
  readonly updates: ReadonlyArray<SessionUpdate>;
}

const textOf = (state: ProjectionState, turn: TurnId): TurnText => state.texts.get(turn) ?? fresh;

const withText = (state: ProjectionState, turn: TurnId, now: TurnText): ProjectionState => ({ ...state, texts: new Map(state.texts).set(turn, now) });

const chunkOf = (kind: TextKind, value: string): SessionUpdate =>
  kind === "Thinking" ? { sessionUpdate: "agent_thought_chunk", content: text(value) } : { sessionUpdate: "agent_message_chunk", content: text(value) };

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

const callOf = (part: Extract<ModelPart, { _tag: "ToolCall" }>): Call => ({ call: part.call, tool: part.tool, input: part.input });

/**
 * The parts of a response its deltas sent `sent` of: of each kind, the deltas cover that kind's
 * parts in order, so a part they covered gives nothing and the first they did not gives what of it
 * they did not send. A part the stream cut is not among `parts`: what was sent of it stays sent.
 */
const answered = (state: ProjectionState, parts: ReadonlyArray<ModelPart>, sent: Sent, context: ProjectionContext): Projected => {
  const covered = { ...sent };
  const updates: Array<SessionUpdate> = [];
  let now = state;
  for (const part of parts) {
    if (part._tag === "ToolCall") {
      const step = announce(now, callOf(part), context);
      now = step.state;
      updates.push(...step.updates);
    } else if (part._tag === "Text" || part._tag === "Commentary" || part._tag === "Thinking") {
      const kind = part._tag;
      if (covered[kind] >= part.text.length) covered[kind] -= part.text.length;
      else {
        const rest = part.text.slice(covered[kind]);
        if (!blank(rest)) updates.push(chunkOf(kind, rest));
        covered[kind] = 0;
      }
    }
  }
  return { state: now, updates };
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
    case "ModelStreamed":
      return nothing(state);
    case "ModelDelta": {
      if (state.ended.has(input.turn)) return nothing(state);
      const now = textOf(state, input.turn);
      // Its request was answered already, and `ModelResponded` sent its text.
      if (now.ahead > 0 || input.text === "") return nothing(state);
      const streaming = { ...now.streaming, [input.kind]: now.streaming[input.kind] + input.text.length };
      const held = (now.held[input.kind] ?? "") + input.text;
      if (blank(held)) return nothing(withText(state, input.turn, { ...now, streaming, held: { ...now.held, [input.kind]: held } }));
      return { state: withText(state, input.turn, { ...now, streaming, held: { ...now.held, [input.kind]: "" } }), updates: [chunkOf(input.kind, held)] };
    }
    case "ModelPartArrived": {
      if (input.part._tag !== "ToolCall") return nothing(state);
      const now = state.texts.get(input.turn);
      const dropped = now === undefined ? state : withText(state, input.turn, { ...now, held: {} });
      return announce(dropped, callOf(input.part), context);
    }
    case "ModelResponseEnded": {
      if (state.ended.has(input.turn)) return nothing(state);
      const now = textOf(state, input.turn);
      return nothing(
        withText(
          state,
          input.turn,
          now.ahead > 0 ? { ...now, ahead: now.ahead - 1 } : { ...now, awaiting: [...now.awaiting, now.streaming], streaming: none, held: {} },
        ),
      );
    }
    case "Decided": {
      const decision = input.decision;
      if (decision._tag !== "TurnEnded") return nothing(state);
      const texts = new Map(state.texts);
      texts.delete(decision.turn);
      return nothing({ ...state, texts, ended: new Set(state.ended).add(decision.turn) });
    }
    case "Observed": {
      const observation = input.observation;
      switch (observation._tag) {
        case "InputArrived":
          // Only what the user said is echoed: the feedback of a turn-end hook is the system's, another agent's is its own.
          return { state, updates: context.mode === "replay" && observation.from._tag === "User" ? [{ sessionUpdate: "user_message_chunk", content: text(observation.text) }] : [] };
        case "ModelResponded": {
          const now = textOf(state, observation.turn);
          // The deltas of this request: those of the first request ended and not answered; else, live,
          // those streaming now (none while `ahead`: this request's have not come yet), and its
          // deltas still to come are dropped. On replay there are none.
          const [sent, after]: readonly [Sent, TurnText] =
            now.awaiting[0] !== undefined
              ? [now.awaiting[0], { ...now, awaiting: now.awaiting.slice(1) }]
              : context.mode === "replay"
                ? [none, now]
                : [now.streaming, { ...now, streaming: none, ahead: now.ahead + 1 }];
          return answered(withText(state, observation.turn, after), observation.parts, sent, context);
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
