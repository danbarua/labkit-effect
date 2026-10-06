/**
 * The projection of a session to ACP's `session/update`: one pure, incremental function from the
 * core's facts (`session.subscribe`) and the items that a model request passes on while it runs
 * (`session.streamed`, `CapturedObservation`) to the updates that each input makes.
 *
 * - Live, a host merges the two feeds. On `session/load`, it projects the stored facts (`project`).
 *   The two differ only in `mode`: live, an input is not echoed, because the client has what it sent.
 * - Each feed keeps its own order, and there is no order between them: a request's deltas can come
 *   before or after its `ModelResponded`, and either feed can be a request or a turn ahead. Each
 *   feed holds a turn's model requests in the same order, so the projection pairs a request's end
 *   item (`ModelResponseEnded`) on the streamed feed with its outcome (`ModelResponded`) on the
 *   facts by position. Text is sent once, whatever the merge.
 * - Live, a delta is sent as it arrives, and `ModelResponded` sends the text of each part that its
 *   request's deltas did not send.
 * - A tool call is announced once, by whichever of `ToolCallArrived`, its `ModelPartArrived` or its
 *   response comes first. Its status follows the call's facts.
 *
 * The host sends its own updates, which are not made here: `usage_update`, `session_info_update`,
 * `available_commands_update`, `config_option_update` and `plan`, and `session/request_permission`.
 */

import { Effect, HashMap, HashSet, Option, Ref } from "effect";
import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "effective-acp/schema/v1";
import { ToolCallId } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import type { CallId, ToolName, TurnId } from "../agent-machine/names.ts";
import type { CapturedObservation, ModelPart, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { asText, parseJson } from "../agent-session/received.ts";
import { callDescriptionOf } from "../agent-tools/described.ts";

/** An input to the projection: a fact, or an item that a model request passed on while it ran. */
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

/** The host's presentation of a tool call; `outcome` is absent until the call ends. */
export type Present = (call: Call, outcome?: ToolOutcome) => Effect.Effect<Presented>;

export interface ProjectionContext {
  /** `replay` echoes each input as `user_message_chunk`; `live` does not. */
  readonly mode: "live" | "replay";
  readonly present: Present;
}

/** Returns a tool failure in words, for a reader. */
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

/** Returns a call's title: the description it gives, or its tool's name. */
const titleOf = (call: Call): string => {
  const parsed = parseJson(call.input);
  return ("value" in parsed ? callDescriptionOf(parsed.value) : undefined) ?? call.tool;
};

/** Returns the text that a call's outcome shows: its output, or why it failed; undefined before it ends. */
const shownOf = (tool: ToolName, outcome: ToolOutcome | undefined): string | undefined => {
  if (outcome === undefined) return undefined;
  return outcome._tag === "Succeeded" ? asText(outcome.output) : failureText(tool, outcome.reason);
};

/**
 * The default presentation over the session's tool catalog (`immutableToolCatalogOf`): the call's
 * description as the title (its `description` input, `agent-tools/described.ts`), or the tool's name
 * when the call has none; its kind from the catalog (none for a tool the catalog does not have); and,
 * once it ends, its output, or why it failed, as text.
 */
export const presentFrom =
  (catalog: ReadonlyArray<ToolSpec>): Present =>
  (call, outcome) => {
    const kind = catalog.find((tool) => tool.name === call.tool)?.kind;
    const shown = shownOf(call.tool, outcome);
    return Effect.succeed({
      title: titleOf(call),
      ...(kind === undefined ? {} : { kind }),
      ...(shown === undefined ? {} : { content: [{ type: "content" as const, content: text(shown) }] }),
    });
  };


/** The kinds of text a delta carries, as `ModelDelta` names them. */
type TextKind = "Text" | "Commentary" | "Thinking";

/** The number of characters of delta text sent, by kind. */
type Sent = { readonly [Kind in TextKind]: number };

const none: Sent = { Text: 0, Commentary: 0, Thinking: 0 };

/**
 * One turn's text, live: what its requests' deltas sent, until each request's `ModelResponded` is
 * taken. When the streamed feed is ahead (requests ended and not yet answered), `awaiting` holds
 * them; when the facts are ahead (requests answered before their end item), `ahead` counts them.
 * At most one of the two is non-empty.
 */
interface TurnText {
  /** What the deltas of the request streaming now sent; nothing while `ahead` is above 0, because that request's deltas are dropped. */
  readonly streaming: Sent;
  /**
   * For each kind, the deltas of only whitespace since the last text of that kind was sent. They are
   * sent with the next text of that kind, and dropped when a call or the response's end comes first,
   * so that a client shows no blank message. They count as sent.
   */
  readonly held: { readonly [Kind in TextKind]?: string };
  /** For each request that has ended but is not answered yet, in order: what its deltas sent. */
  readonly awaiting: ReadonlyArray<Sent>;
  /** How many requests were answered (`ModelResponded`) before their end item. Their remaining deltas are dropped. */
  readonly ahead: number;
}

const fresh: TurnText = { streaming: none, held: {}, awaiting: [], ahead: 0 };

const blank = (value: string): boolean => value.trim() === "";

export interface ProjectionState {
  /** The text of each turn under way, by the turn, created by the first input that names the turn. */
  readonly texts: ReadonlyMap<TurnId, TurnText>;
  /** The turns that have ended (`TurnEnded`). Items streamed for them afterwards are dropped, because their facts sent the text. */
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

const withText = (state: ProjectionState, turn: TurnId, now: TurnText): ProjectionState => ({ ...state, texts: new Map([...state.texts, [turn, now]]) });

const chunkOf = (kind: TextKind, value: string): SessionUpdate =>
  kind === "Thinking" ? { sessionUpdate: "agent_thought_chunk", content: text(value) } : { sessionUpdate: "agent_message_chunk", content: text(value) };

/** Announces `call` as `pending`, unless it was announced. */
const announce = (state: ProjectionState, call: Call, context: ProjectionContext): Effect.Effect<Projected> => {
  if (state.calls.has(call.call)) return Effect.succeed({ state, updates: [] });
  return Effect.map(context.present(call), (shown) => ({
    state: { ...state, calls: new Map([...state.calls, [call.call, { call, shown }]]) },
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
  }));
};

const callOf = (part: Extract<ModelPart, { _tag: "ToolCall" }>): Call => ({ call: part.call, tool: part.tool, input: part.input });

/**
 * Returns the updates for the parts of a response whose deltas sent `sent`. For each kind, the
 * deltas cover that kind's parts in order: a part they covered sends nothing, and the first part
 * they did not cover sends the text they did not send. A part that the stream cut is not among
 * `parts`, so what was sent of it stays sent.
 */
const answered = (state: ProjectionState, parts: ReadonlyArray<ModelPart>, sent: Sent, context: ProjectionContext): Effect.Effect<Projected> =>
  Effect.map(
    Effect.reduce(
      parts,
      (): { readonly projected: Projected; readonly covered: Sent } => ({ projected: nothing(state), covered: sent }),
      ({ projected, covered }, part) => {
        if (part._tag === "ToolCall")
          return Effect.map(announce(projected.state, callOf(part), context), (step) => ({ projected: { state: step.state, updates: [...projected.updates, ...step.updates] }, covered }));
        if (part._tag !== "Text" && part._tag !== "Commentary" && part._tag !== "Thinking") return Effect.succeed({ projected, covered });
        const kind = part._tag;
        if (covered[kind] >= part.text.length) return Effect.succeed({ projected, covered: { ...covered, [kind]: covered[kind] - part.text.length } });
        const rest = part.text.slice(covered[kind]);
        return Effect.succeed({ projected: blank(rest) ? projected : { ...projected, updates: [...projected.updates, chunkOf(kind, rest)] }, covered: { ...covered, [kind]: 0 } });
      },
    ),
    ({ projected }) => projected,
  );

const nothing = (state: ProjectionState): Projected => ({ state, updates: [] });

/**
 * Returns what the deltas of the request that a `ModelResponded` answers sent, and the turn's text
 * after it:
 *
 * - the first request that has ended and is not answered, when there is one;
 * - otherwise, live, the request streaming now. Its deltas still to come are dropped (`ahead`).
 * - On replay there are no deltas.
 */
const sentFor = (now: TurnText, mode: ProjectionContext["mode"]): readonly [Sent, TurnText] => {
  const [first, ...rest] = now.awaiting;
  if (first !== undefined) return [first, { ...now, awaiting: rest }];
  if (mode === "replay") return [none, now];
  return [now.streaming, { ...now, streaming: none, ahead: now.ahead + 1 }];
};

const status = (call: CallId, value: "pending" | "in_progress"): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: ToolCallId.make(call),
  status: value,
});

/** Returns the updates that `input` makes, and the state to take the next input from. */
export function next(state: ProjectionState, input: ProjectionInput, context: ProjectionContext): Effect.Effect<Projected> {
  switch (input._tag) {
    case "ModelStreamed":
      return Effect.succeed(nothing(state));
    case "ModelDelta": {
      if (state.ended.has(input.turn)) return Effect.succeed(nothing(state));
      const now = textOf(state, input.turn);
      // Its request was answered already, and `ModelResponded` sent its text; a delta with no text adds nothing.
      if (now.ahead > 0 || input.text === "") return Effect.succeed(nothing(state));
      const streaming = { ...now.streaming, [input.kind]: now.streaming[input.kind] + input.text.length };
      const held = (now.held[input.kind] ?? "") + input.text;
      if (blank(held)) return Effect.succeed(nothing(withText(state, input.turn, { ...now, streaming, held: { ...now.held, [input.kind]: held } })));
      return Effect.succeed({ state: withText(state, input.turn, { ...now, streaming, held: { ...now.held, [input.kind]: "" } }), updates: [chunkOf(input.kind, held)] });
    }
    case "ModelPartArrived": {
      if (input.part._tag !== "ToolCall") return Effect.succeed(nothing(state));
      const now = state.texts.get(input.turn);
      const dropped = now === undefined ? state : withText(state, input.turn, { ...now, held: {} });
      return announce(dropped, callOf(input.part), context);
    }
    case "ModelResponseEnded": {
      if (state.ended.has(input.turn)) return Effect.succeed(nothing(state));
      const now = textOf(state, input.turn);
      return Effect.succeed(
        nothing(
          withText(
            state,
            input.turn,
            now.ahead > 0 ? { ...now, ahead: now.ahead - 1 } : { ...now, awaiting: [...now.awaiting, now.streaming], streaming: none, held: {} },
          ),
        ),
      );
    }
    case "Decided": {
      const decision = input.decision;
      if (decision._tag !== "TurnEnded") return Effect.succeed(nothing(state));
      const texts = new Map([...state.texts].filter(([turn]) => turn !== decision.turn));
      return Effect.succeed(nothing({ ...state, texts, ended: new Set([...state.ended, decision.turn]) }));
    }
    case "Observed": {
      const observation = input.observation;
      switch (observation._tag) {
        case "InputArrived":
          // Only the user's input is echoed: a turn-end hook's feedback is input from the system, and another agent's is that agent's.
          return Effect.succeed({
            state,
            updates: context.mode === "replay" && observation.from._tag === "User" ? [{ sessionUpdate: "user_message_chunk", content: text(observation.text) }] : [],
          });
        case "ModelResponded": {
          const now = textOf(state, observation.turn);
          const [sent, after] = sentFor(now, context.mode);
          return answered(withText(state, observation.turn, after), observation.parts, sent, context);
        }
        case "ToolCallArrived":
          return announce(state, { call: observation.call, tool: observation.tool, input: observation.input }, context);
        case "PermissionAsked":
          return Effect.succeed({ state, updates: [status(observation.call, "pending")] });
        case "ToolCallDispatched":
          return Effect.succeed({ state, updates: [status(observation.call, "in_progress")] });
        case "ToolEnded": {
          const known = state.calls.get(observation.call);
          const outcome = observation.outcome;
          const ended = (shown: Presented | undefined): Projected => ({
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
          });
          return known === undefined ? Effect.succeed(ended(undefined)) : Effect.map(context.present(known.call, outcome), ended);
        }
        case "SessionOpened":
        case "InputCancelled":
        case "TurnStarted":
        case "TurnInterrupted":
        case "TurnEndReviewed":
        case "TurnHoldsExhausted":
        case "ModelRequestDispatched":
        case "ModelAttemptFailed":
        case "ModelFailed":
        case "ModelVetoed":
        case "ModelChangeArrived":
        case "SettingAdjusted":
        case "PermissionAnswered":
        case "NoticeInserted":
        case "CompactionWindow":
        case "McpServerChanged":
          return Effect.succeed(nothing(state));
        default:
          return observation satisfies never;
      }
    }
    default:
      return input satisfies never;
  }
}

/** What `inLiveOrder` has found of the inputs so far. */
interface Reordering {
  /** For each turn's request in flight: the position of its first `ToolCallArrived`, or none before one. */
  readonly open: HashMap.HashMap<TurnId, Option.Option<number>>;
  /** The response to take before the input at each position. */
  readonly before: HashMap.HashMap<number, ProjectionInput>;
  /** The positions of the responses that were moved. */
  readonly moved: HashSet.HashSet<number>;
}

/**
 * Returns `inputs` in the order that live sent them, for a replay. The loop records a tool call as
 * the model's stream passes it, so a request's calls, and even their ends, come before the
 * `ModelResponded` that holds the whole response. A request runs from a `ModelRequestDispatched` to
 * its turn's next `ModelResponded`; when calls arrived in it, that response is moved to just before
 * the first `ToolCallArrived`. Every other input keeps its place: the result is a permutation of
 * `inputs`.
 */
function inLiveOrder(inputs: ReadonlyArray<ProjectionInput>): ReadonlyArray<ProjectionInput> {
  const { before, moved } = inputs.reduce<Reordering>(
    (found, input, index) => {
      if (input._tag !== "Observed") return found;
      const observation = input.observation;
      switch (observation._tag) {
        case "ModelRequestDispatched":
          return { ...found, open: HashMap.set(found.open, observation.turn, Option.none()) };
        case "ToolCallArrived": {
          const anchor = HashMap.get(found.open, observation.turn);
          return Option.isSome(anchor) && Option.isNone(anchor.value) ? { ...found, open: HashMap.set(found.open, observation.turn, Option.some(index)) } : found;
        }
        case "ModelResponded": {
          const anchor = Option.flatten(HashMap.get(found.open, observation.turn));
          const open = HashMap.remove(found.open, observation.turn);
          if (Option.isNone(anchor)) return { ...found, open };
          return { open, before: HashMap.set(found.before, anchor.value, input), moved: HashSet.add(found.moved, index) };
        }
        case "SessionOpened":
        case "InputArrived":
        case "InputCancelled":
        case "TurnStarted":
        case "TurnInterrupted":
        case "TurnEndReviewed":
        case "TurnHoldsExhausted":
        case "ModelAttemptFailed":
        case "ModelFailed":
        case "ModelVetoed":
        case "ModelChangeArrived":
        case "SettingAdjusted":
        case "ToolCallDispatched":
        case "ToolEnded":
        case "PermissionAsked":
        case "PermissionAnswered":
        case "NoticeInserted":
        case "CompactionWindow":
        case "McpServerChanged":
          return found;
        default:
          return observation satisfies never;
      }
    },
    { open: HashMap.empty(), before: HashMap.empty(), moved: HashSet.empty() },
  );
  if (HashSet.size(moved) === 0) return inputs;
  return inputs.flatMap((input, index) => [...Option.toArray(HashMap.get(before, index)), ...(HashSet.has(moved, index) ? [] : [input])]);
}

/**
 * Returns the updates that `inputs` make, in order, starting from `from`, and the state after them.
 * On replay, each request's response is taken before its first tool call, as live sent them
 * (`inLiveOrder`).
 */
export function project(inputs: ReadonlyArray<ProjectionInput>, context: ProjectionContext, from: ProjectionState = start): Effect.Effect<Projected> {
  return Effect.gen(function* () {
    const state = yield* Ref.make(from);
    const updates = yield* Effect.forEach(context.mode === "replay" ? inLiveOrder(inputs) : inputs, (input) =>
      Ref.get(state).pipe(
        Effect.flatMap((now) => next(now, input, context)),
        Effect.tap((step) => Ref.set(state, step.state)),
        Effect.map((step) => step.updates),
      ),
    );
    return { state: yield* Ref.get(state), updates: updates.flat() };
  });
}
