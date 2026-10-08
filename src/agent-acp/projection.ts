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
 *   response comes first, with its tool's name (`name`) and its input (`rawInput`). Its status
 *   follows the call's facts, and its end carries what it returned or why it failed (`rawOutput`).
 *
 * Each text chunk names the message it belongs to (`messageId`). An id the provider does not give,
 * labkit gives; for messages, the projection derives it from the session's journal, so it is the same
 * every time the journal is read: live, on each `session/load`, and in a reloaded session's later
 * turns, which go on from the journal's seqs. An id generated here (Effect's `IdGenerator` makes random
 * ones) would differ on each replay, and keeping it would mean recording it as a fact. Providers' own
 * ids are not used: they differ between providers (Effect's Anthropic adapter numbers a response's
 * blocks from "0" in every response; OpenAI's item ids are global).
 *
 * - A user's input is one message, named by the seq of its `InputArrived`: `"7"`.
 * - A model's message is a run of text of one kind (`Text`, `Commentary` or `Thinking`) in one
 *   response: a call, or text of another kind, ends it. It is named by its request and its place among
 *   the response's runs: `"<seq of the request's first ModelRequestDispatched>:<run>"`, `"12:0"`. A
 *   request is dispatched before it streams, so its deltas and its recorded parts get the same id. A
 *   fallback's dispatch continues the request, which keeps the first's seq. A streamed item waits in
 *   the state until its request's dispatch, or its response, is taken, so that it is sent with its id.
 *
 * The host sends its own updates, which are not made here: `usage_update`, `session_info_update`,
 * `available_commands_update`, `config_option_update`, `plan` and `notice`, and
 * `session/request_permission`.
 */

import { Effect, HashMap, HashSet, Option, Ref, type Schema } from "effect";
import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "effective-acp/schema/v1";
import { MessageId, ToolCallId } from "effective-acp/schema/v1";
import type { Fact } from "../agent-machine/fact.ts";
import type { CallId, ToolName, TurnId } from "../agent-machine/names.ts";
import type { CapturedObservation, ModelPart, ToolFailure, ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { asText, parseJson } from "../agent-session/received.ts";
import { intentOf, isDescribed } from "../agent-tools/described.ts";
import { hunksOf } from "../agent-tools/line-diff.ts";
import { logKeys } from "./log-keys.ts";

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

/**
 * The host's presentation of a tool call; `outcome` is absent until the call ends. `mode` is the
 * projection's: `live` while the session runs, `replay` when a loaded session's facts are shown
 * again, when what the call changed has already happened. It is `replay` when not given.
 */
export type Present = (call: Call, outcome?: ToolOutcome, mode?: "live" | "replay") => Effect.Effect<Presented>;

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

/** Returns `text` on one line of at most 120 characters, for a title. */
export const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
};

/** Returns a call's title: the intent it gives, on one line, when its tool is `spec` and `described` added that input; otherwise its tool's name. */
const titleOf = (call: Call, spec: ToolSpec | undefined): string => {
  if (spec === undefined || !isDescribed(spec)) return call.tool;
  const parsed = parseJson(call.input);
  const intent = "value" in parsed ? intentOf(parsed.value) : undefined;
  return intent === undefined ? call.tool : oneLine(intent);
};

/**
 * Returns the diffs of the files that a call changed, from its details (`FileChanged`): a created
 * file as its whole text, an updated one as one diff for each hunk of its patch. None for a call
 * that has not ended, that failed, or that recorded no details.
 */
export const changedFiles = (outcome: ToolOutcome | undefined): ReadonlyArray<ToolCallContent> =>
  outcome?._tag !== "Succeeded"
    ? []
    : (outcome.details ?? []).flatMap((detail): ReadonlyArray<ToolCallContent> => {
        if (detail.change === "created") return [{ type: "diff", path: detail.path, oldText: null, newText: asText(detail.patch) }];
        return hunksOf(asText(detail.patch)).map((hunk) => ({ type: "diff", path: detail.path, oldText: hunk.before, newText: hunk.after }));
      });

/** Returns the text that a call's outcome shows: its output, or why it failed; undefined before it ends. */
const shownOf = (tool: ToolName, outcome: ToolOutcome | undefined): string | undefined => {
  if (outcome === undefined) return undefined;
  return outcome._tag === "Succeeded" ? asText(outcome.output) : failureText(tool, outcome.reason);
};

/**
 * The default presentation over the session's tool catalog (`immutableToolCatalogOf`): as the title,
 * the call's intent, on one line, when `described` (`agent-tools/described.ts`) added that input to
 * its tool, and the tool's name otherwise; its kind from the catalog (none for a tool the
 * catalog does not have); and, once it ends, the diffs of the files it changed (`changedFiles`), or,
 * when it changed none, its output, or why it failed, as text.
 */
export const presentFrom =
  (catalog: ReadonlyArray<ToolSpec>): Present =>
  (call, outcome) => {
    const spec = catalog.find((tool) => tool.name === call.tool);
    const kind = spec?.kind;
    const shown = shownOf(call.tool, outcome);
    const changed = changedFiles(outcome);
    const content = changed.length > 0 || shown === undefined ? changed : [{ type: "content" as const, content: text(shown) }];
    return Effect.succeed({
      title: titleOf(call, spec),
      ...(kind === undefined ? {} : { kind }),
      ...(content.length === 0 ? {} : { content }),
    });
  };

/** Content as a tool call's `rawInput` or `rawOutput` carries it. */
export interface Raw {
  readonly value: Schema.Json;
  /** Why content that claims to be JSON is carried as its text: it does not parse. */
  readonly notJson?: string;
}

/** Whether `mediaType` names JSON (`application/json`, or a type with the `+json` suffix), its parameters aside. */
const namesJson = (mediaType: string): boolean => {
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  return essence === "application/json" || essence.endsWith("+json");
};

/**
 * Returns content as a tool call's `rawInput` and `rawOutput` carry it, as the facts hold it: the
 * value, when its media type is JSON; its text, for any other text, and for JSON that does not parse
 * (with why). Bytes, in the facts or in the blob store, have none: JSON cannot carry them, and the
 * call's content names them (`asText`: their size, their type and, when stored, their reference).
 */
export const rawOf = (received: Received): Raw | undefined => {
  if (received.body._tag !== "Text") return undefined;
  if (!namesJson(received.mediaType)) return { value: received.body.text };
  const parsed = parseJson(received);
  return "value" in parsed ? { value: parsed.value } : { value: received.body.text, notJson: parsed.reason };
};

/**
 * Logs that `field` of `call` carries the text of `received`, which claims JSON and does not parse:
 * the field, the tool, the media type, why, and the text's length and first 300 characters.
 */
const warnedIfNotJson = (field: "rawInput" | "rawOutput", call: CallId, tool: ToolName | undefined, received: Received, raw: Raw | undefined): Effect.Effect<void> => {
  if (raw?.notJson === undefined) return Effect.void;
  const shown = asText(received);
  return Effect.logWarning(logKeys.update.rawNotJson, {
    field,
    ...(tool === undefined ? {} : { tool }),
    mediaType: received.mediaType,
    cause: raw.notJson,
    text: { chars: shown.length, start: shown.slice(0, 300) },
  }).pipe(Effect.annotateLogs({ call }));
};

/**
 * Returns what a call's end carries as `rawOutput`, as its facts record it, and the content it was
 * read from: what the tool returned; for a call that failed, its recorded reason (the tool's error,
 * the policy's veto, or why its input was rejected). A call that named no tool, was not run, or whose
 * end was not observed has nothing recorded beyond that, which its content says in words: it has none.
 */
const rawOutputOf = (outcome: ToolOutcome): { readonly raw: Raw | undefined; readonly from?: Received } => {
  if (outcome._tag === "Succeeded") return { raw: rawOf(outcome.output), from: outcome.output };
  const reason = outcome.reason;
  switch (reason._tag) {
    case "Reported":
      return { raw: rawOf(reason.error), from: reason.error };
    case "Vetoed":
      return { raw: rawOf(reason.reason), from: reason.reason };
    case "InputRejected":
      return { raw: { value: reason.problem } };
    case "NotFound":
    case "NotRun":
    case "Indeterminate":
      return { raw: undefined };
    default:
      return reason satisfies never;
  }
};

/** The kinds of text a delta carries, as `ModelDelta` names them. */
type TextKind = "Text" | "Commentary" | "Thinking";

/** The number of characters of delta text sent, by kind. */
type Sent = { readonly [Kind in TextKind]: number };

const none: Sent = { Text: 0, Commentary: 0, Thinking: 0 };

const blank = (value: string): boolean => value.trim() === "";

/** A response's messages so far: how many have begun, and the one still open, which the next text of its kind goes on. */
interface Runs {
  readonly begun: number;
  readonly open: { readonly kind: TextKind; readonly run: number } | undefined;
}

const noRuns: Runs = { begun: 0, open: undefined };

/** Returns the message that text of `kind` goes in, and whether the text begins it: the open one when it is of `kind`, else a new one. */
const runFor = (runs: Runs, kind: TextKind): { readonly run: number; readonly begins: boolean; readonly runs: Runs } =>
  runs.open?.kind === kind
    ? { run: runs.open.run, begins: false, runs }
    : { run: runs.begun, begins: true, runs: { begun: runs.begun + 1, open: { kind, run: runs.begun } } };

const isText = (part: ModelPart): part is Extract<ModelPart, { _tag: TextKind }> => part._tag === "Text" || part._tag === "Commentary" || part._tag === "Thinking";

/**
 * Returns the messages after a whole part: a call ends the open one, and text that is not blank goes
 * in one. A part with no text to show (blank text, or one the decoder did not recognise) changes
 * nothing, as a client sees nothing of it.
 */
const runsAfter = (runs: Runs, part: ModelPart): Runs => {
  if (part._tag === "ToolCall") return { ...runs, open: undefined };
  return isText(part) && !blank(part.text) ? runFor(runs, part._tag).runs : runs;
};

/** The id of message `run` of the response to the request first dispatched at seq `request`. */
const messageIdOf = (request: number, run: number): MessageId => MessageId.make(`${request}:${run}`);

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
   * For each kind, the deltas of only whitespace since the last text of that kind was sent: until it is
   * known whose they are, they are held, so that a client shows no blank message and a message gets
   * the whitespace that is its own and no other's.
   *
   * - Text after them in the same message is sent with them.
   * - The end of their part (`ModelPartArrived`) sends them as the end of the part's message; a part of
   *   only whitespace sends none, as on replay.
   * - A call, or another message beginning, sends those of the open message as its end, under its id.
   *   This serves a provider that passes on its parts after the response's last delta (the Chat
   *   Completions adapter does): a part's text is not interrupted by another part's.
   * - Still held when their request ends or its response is taken, they are not counted as sent
   *   (`withoutHeld`): the response sends them from its parts, in each part's own message.
   *
   * Held, they count as sent.
   */
  readonly held: { readonly [Kind in TextKind]?: string };
  /** For each request that has ended but is not answered yet, in order: what its deltas sent. */
  readonly awaiting: ReadonlyArray<Sent>;
  /** How many requests were answered (`ModelResponded`) before their end item. Their remaining deltas are dropped. */
  readonly ahead: number;
  /** For each of the turn's requests, by its position in the turn: the seq of its first `ModelRequestDispatched`, which names its messages. */
  readonly requests: ReadonlyMap<number, number>;
  /** How many of the turn's requests have their `ModelResponded` taken: the position of the request that the facts are in. */
  readonly answered: number;
  /** How many of the turn's requests have their `ModelResponseEnded` taken: the position of the request streaming now. */
  readonly streamed: number;
  /** The messages that the items of the request streaming now have begun. */
  readonly runs: Runs;
  /** Streamed items taken before their request's dispatch or response, in order: they wait for it, to be sent with their message's id. */
  readonly waiting: ReadonlyArray<CapturedObservation>;
}

const fresh: TurnText = { streaming: none, held: {}, awaiting: [], ahead: 0, requests: new Map(), answered: 0, streamed: 0, runs: noRuns, waiting: [] };

export interface ProjectionState {
  /** The text of each turn under way, by the turn, created by the first input that names the turn. */
  readonly texts: ReadonlyMap<TurnId, TurnText>;
  /** The turns that have ended (`TurnEnded`). Items streamed for them afterwards are dropped, because their facts sent the text. */
  readonly ended: ReadonlySet<TurnId>;
  /** The calls announced, as they were presented, each with the latest input it was announced with. */
  readonly calls: ReadonlyMap<CallId, { readonly call: Call; readonly shown: Presented }>;
}

export const start: ProjectionState = { texts: new Map(), ended: new Set(), calls: new Map() };

export interface Projected {
  readonly state: ProjectionState;
  readonly updates: ReadonlyArray<SessionUpdate>;
}

const textOf = (state: ProjectionState, turn: TurnId): TurnText => state.texts.get(turn) ?? fresh;

const withText = (state: ProjectionState, turn: TurnId, now: TurnText): ProjectionState => ({ ...state, texts: new Map([...state.texts, [turn, now]]) });

const chunkOf = (kind: TextKind, value: string, messageId: MessageId): SessionUpdate =>
  kind === "Thinking"
    ? { sessionUpdate: "agent_thought_chunk", content: text(value), messageId }
    : { sessionUpdate: "agent_message_chunk", content: text(value), messageId };

const nothing = (state: ProjectionState): Projected => ({ state, updates: [] });

/** `sent` without what is held: what a request's deltas sent to the client. */
const withoutHeld = (sent: Sent, held: TurnText["held"]): Sent => ({
  Text: sent.Text - (held.Text?.length ?? 0),
  Commentary: sent.Commentary - (held.Commentary?.length ?? 0),
  Thinking: sent.Thinking - (held.Thinking?.length ?? 0),
});

/**
 * Ends the open message of the request streaming now in `now`, named by `request`: returns the chunk
 * that sends what it still holds, the whitespace after its text, under its own id, and what is held
 * after that. Nothing when no message is open or it holds nothing.
 */
const closing = (now: TurnText, request: number): { readonly updates: ReadonlyArray<SessionUpdate>; readonly held: TurnText["held"] } => {
  const open = now.runs.open;
  const rest = open === undefined ? "" : (now.held[open.kind] ?? "");
  if (open === undefined || rest === "") return { updates: [], held: now.held };
  return { updates: [chunkOf(open.kind, rest, messageIdOf(request, open.run))], held: { ...now.held, [open.kind]: "" } };
};

/** Whether two inputs of a call carry the same value, as `rawInput` sends it. */
const sameInput = (a: Received, b: Received): boolean => {
  if (a.mediaType === b.mediaType && a.body._tag === "Text" && b.body._tag === "Text" && a.body.text === b.body.text) return true;
  return JSON.stringify(rawOf(a)?.value) === JSON.stringify(rawOf(b)?.value);
};

/**
 * Announces `call` as `pending`, with its tool's name and its input, unless it was announced. A call
 * announced again with an input other than the one the client has (a source that holds it whole,
 * after one that did not) is kept with that input, and a `tool_call_update` carries it.
 */
const announce = (state: ProjectionState, call: Call, context: ProjectionContext): Effect.Effect<Projected> => {
  const known = state.calls.get(call.call);
  const raw = rawOf(call.input);
  if (known !== undefined) {
    if (sameInput(known.call.input, call.input)) return Effect.succeed(nothing(state));
    const kept: ProjectionState = { ...state, calls: new Map([...state.calls, [call.call, { call, shown: known.shown }]]) };
    if (raw === undefined) return Effect.succeed(nothing(kept));
    return Effect.as(warnedIfNotJson("rawInput", call.call, call.tool, call.input, raw), {
      state: kept,
      updates: [{ sessionUpdate: "tool_call_update", toolCallId: ToolCallId.make(call.call), rawInput: raw.value }],
    });
  }
  return Effect.gen(function* () {
    const shown = yield* context.present(call, undefined, context.mode);
    yield* warnedIfNotJson("rawInput", call.call, call.tool, call.input, raw);
    return {
      state: { ...state, calls: new Map([...state.calls, [call.call, { call, shown }]]) },
      updates: [
        {
          sessionUpdate: "tool_call",
          toolCallId: ToolCallId.make(call.call),
          title: shown.title,
          name: call.tool,
          status: "pending",
          ...(shown.kind === undefined ? {} : { kind: shown.kind }),
          ...(shown.locations === undefined ? {} : { locations: shown.locations }),
          ...(shown.content === undefined ? {} : { content: shown.content }),
          ...(raw === undefined ? {} : { rawInput: raw.value }),
        },
      ],
    };
  });
};

const callOf = (part: Extract<ModelPart, { _tag: "ToolCall" }>): Call => ({ call: part.call, tool: part.tool, input: part.input });

/**
 * Returns the updates for the parts of a response whose deltas sent `sent`, its messages named by
 * `request`. For each kind, the deltas cover that kind's parts in order: a part they covered sends
 * nothing, and the first part they did not cover sends the text they did not send, whitespace
 * included; a part of only whitespace sends nothing. A part that the stream cut is not among `parts`,
 * so what was sent of it stays sent. The parts' messages are counted as the streamed items counted
 * them (`runsAfter`), so the rest of a part goes in the message that its deltas began.
 */
const answered = (state: ProjectionState, parts: ReadonlyArray<ModelPart>, sent: Sent, request: number, context: ProjectionContext): Effect.Effect<Projected> =>
  Effect.map(
    Effect.reduce(
      parts,
      (): { readonly projected: Projected; readonly covered: Sent; readonly runs: Runs } => ({ projected: nothing(state), covered: sent, runs: noRuns }),
      ({ projected, covered, runs }, part) => {
        const after = runsAfter(runs, part);
        if (part._tag === "ToolCall")
          return Effect.map(announce(projected.state, callOf(part), context), (step) => ({
            projected: { state: step.state, updates: [...projected.updates, ...step.updates] },
            covered,
            runs: after,
          }));
        if (!isText(part)) return Effect.succeed({ projected, covered, runs: after });
        const kind = part._tag;
        if (covered[kind] >= part.text.length) return Effect.succeed({ projected, covered: { ...covered, [kind]: covered[kind] - part.text.length }, runs: after });
        const rest = part.text.slice(covered[kind]);
        // A part that is not blank is in the open message.
        const open = after.open;
        return Effect.succeed({
          projected: blank(part.text) || open === undefined ? projected : { ...projected, updates: [...projected.updates, chunkOf(kind, rest, messageIdOf(request, open.run))] },
          covered: { ...covered, [kind]: 0 },
          runs: after,
        });
      },
    ),
    ({ projected }) => projected,
  );

/**
 * Returns what the deltas of the request that a `ModelResponded` answers sent, and the turn's text
 * after it:
 *
 * - the first request that has ended and is not answered, when there is one;
 * - otherwise, live, the request streaming now, but for what it holds, which the response sends. Its
 *   deltas still to come are dropped (`ahead`).
 * - On replay there are no deltas.
 */
const sentFor = (now: TurnText, mode: ProjectionContext["mode"]): readonly [Sent, TurnText] => {
  const [first, ...rest] = now.awaiting;
  if (first !== undefined) return [first, { ...now, awaiting: rest }];
  if (mode === "replay") return [none, now];
  return [withoutHeld(now.streaming, now.held), { ...now, streaming: none, held: {}, ahead: now.ahead + 1 }];
};

/**
 * Whether a streamed item of a turn whose text is `now` waits: while the request streaming now has
 * neither its dispatch nor its response taken, the id of its messages is not known. Items keep their
 * order behind those that wait.
 */
const waits = (now: TurnText): boolean => now.waiting.length > 0 || (now.answered <= now.streamed && !now.requests.has(now.streamed));

const waiting = (state: ProjectionState, turn: TurnId, now: TurnText, item: CapturedObservation): Projected =>
  nothing(withText(state, turn, { ...now, waiting: [...now.waiting, item] }));

/** Takes the items of `turn` that wait, in order, after `projected`: a fact has come that can name their messages. Those it does not name wait on. */
const released = (projected: Projected, turn: TurnId, context: ProjectionContext): Effect.Effect<Projected> => {
  const now = projected.state.texts.get(turn);
  if (now === undefined || now.waiting.length === 0) return Effect.succeed(projected);
  return Effect.reduce(
    now.waiting,
    (): Projected => ({ state: withText(projected.state, turn, { ...now, waiting: [] }), updates: projected.updates }),
    (done, item) => Effect.map(next(done.state, item, context), (step): Projected => ({ state: step.state, updates: [...done.updates, ...step.updates] })),
  );
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
      // A delta with no text adds nothing.
      if (state.ended.has(input.turn) || input.text === "") return Effect.succeed(nothing(state));
      const now = textOf(state, input.turn);
      if (waits(now)) return Effect.succeed(waiting(state, input.turn, now, input));
      const request = now.requests.get(now.streamed);
      // Its request was answered already, and `ModelResponded` sent its text.
      if (now.ahead > 0 || request === undefined) return Effect.succeed(nothing(state));
      const streaming = { ...now.streaming, [input.kind]: now.streaming[input.kind] + input.text.length };
      const held = (now.held[input.kind] ?? "") + input.text;
      if (blank(held)) return Effect.succeed(nothing(withText(state, input.turn, { ...now, streaming, held: { ...now.held, [input.kind]: held } })));
      const { run, begins, runs } = runFor(now.runs, input.kind);
      // A message that begins ends the one before, which is sent what it still holds, under its own id.
      const before = begins ? closing(now, request) : { updates: [], held: now.held };
      return Effect.succeed({
        state: withText(state, input.turn, { ...now, streaming, runs, held: { ...before.held, [input.kind]: "" } }),
        updates: [...before.updates, chunkOf(input.kind, held, messageIdOf(request, run))],
      });
    }
    case "ModelPartArrived": {
      const part = input.part;
      if (state.ended.has(input.turn)) return part._tag === "ToolCall" ? announce(state, callOf(part), context) : Effect.succeed(nothing(state));
      const now = textOf(state, input.turn);
      if (waits(now)) return Effect.succeed(waiting(state, input.turn, now, input));
      const request = now.requests.get(now.streamed);
      // Its request was answered already: its response sent the parts' text and announced its calls.
      if (now.ahead > 0 || request === undefined) return part._tag === "ToolCall" ? announce(state, callOf(part), context) : Effect.succeed(nothing(state));
      if (part._tag === "ToolCall") {
        // A call ends the open message, which is sent what it still holds. Whitespace held of another
        // kind is a part's with nothing to show, which replay does not send either: it is dropped.
        const before = closing(now, request);
        const after = withText(state, input.turn, { ...now, runs: { ...now.runs, open: undefined }, held: {} });
        return Effect.map(announce(after, callOf(part), context), (step) => ({ state: step.state, updates: [...before.updates, ...step.updates] }));
      }
      if (!isText(part)) return Effect.succeed(nothing(state));
      // A part of only whitespace is not sent, as on replay: what its deltas held is dropped.
      if (blank(part.text)) return Effect.succeed(nothing(withText(state, input.turn, { ...now, held: { ...now.held, [part._tag]: "" } })));
      const { run, begins, runs } = runFor(now.runs, part._tag);
      const before = begins ? closing(now, request) : { updates: [], held: now.held };
      // The part is whole: what its deltas still hold is the whitespace after its text, sent in its message.
      const end = before.held[part._tag] ?? "";
      return Effect.succeed({
        state: withText(state, input.turn, { ...now, runs, held: { ...before.held, [part._tag]: "" } }),
        updates: [...before.updates, ...(end === "" ? [] : [chunkOf(part._tag, end, messageIdOf(request, run))])],
      });
    }
    case "ModelResponseEnded": {
      if (state.ended.has(input.turn)) return Effect.succeed(nothing(state));
      const now = textOf(state, input.turn);
      if (waits(now)) return Effect.succeed(waiting(state, input.turn, now, input));
      // What the request's deltas still hold was not sent: its response sends it from its parts, each in
      // its own message, and none of a part of only whitespace.
      const after: TurnText = { ...now, streamed: now.streamed + 1, runs: noRuns, held: {}, streaming: none };
      return Effect.succeed(
        nothing(withText(state, input.turn, now.ahead > 0 ? { ...after, ahead: now.ahead - 1 } : { ...after, awaiting: [...now.awaiting, withoutHeld(now.streaming, now.held)] })),
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
            updates:
              context.mode === "replay" && observation.from._tag === "User"
                ? [{ sessionUpdate: "user_message_chunk", content: text(observation.text), messageId: MessageId.make(String(input.seq)) }]
                : [],
          });
        case "ModelRequestDispatched": {
          const now = textOf(state, observation.turn);
          // A fallback's dispatch continues the request that the first began (`model-fallback.ts`): the request keeps the first's seq.
          const requests = now.requests.has(now.answered) ? now.requests : new Map([...now.requests, [now.answered, input.seq]]);
          return released(nothing(withText(state, observation.turn, { ...now, requests })), observation.turn, context);
        }
        case "ModelResponded": {
          const now = textOf(state, observation.turn);
          const request = now.requests.get(now.answered);
          const [sent, after] = sentFor(now, context.mode);
          const taken = withText(state, observation.turn, { ...after, answered: now.answered + 1 });
          return Effect.gen(function* () {
            // The loop records a request's dispatch before its response; facts without one name its messages by the response's own seq.
            if (request === undefined) yield* Effect.logWarning(logKeys.update.noDispatch, { response: input.seq }).pipe(Effect.annotateLogs({ turn: observation.turn }));
            const step = yield* answered(taken, observation.parts, sent, request ?? input.seq, context);
            return yield* released(step, observation.turn, context);
          });
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
          const { raw, from } = rawOutputOf(outcome);
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
                ...(raw === undefined ? {} : { rawOutput: raw.value }),
              },
            ],
          });
          return Effect.gen(function* () {
            if (from !== undefined) yield* warnedIfNotJson("rawOutput", observation.call, known?.call.tool, from, raw);
            return ended(known === undefined ? undefined : yield* context.present(known.call, outcome, context.mode));
          });
        }
        case "SessionOpened":
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
        case "PermissionAnswered":
        case "NoticeInserted":
        case "CompactionWindow":
        case "McpServerChanged":
        case "FolderAdded":
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
        case "FolderAdded":
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
