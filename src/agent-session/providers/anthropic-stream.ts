/**
 * A Messages API response assembled from its stream: a state machine that takes the stream's events
 * one at a time and holds the message as far as it has arrived.
 * - A content block is complete when its `content_block_stop` arrives.
 * - `assembled` returns the message in the form that a non-streaming request returns, with the
 *   complete blocks only. A block still arriving when the stream ends (the response was cut short,
 *   or the request was stopped) is not included.
 * - A `tool_use` block's input arrives as JSON text in pieces, and is parsed when the block is
 *   complete. When that text is not JSON, the block is still complete, with the text as its `input`,
 *   and the event reports it (`unparsed`): the call is recorded, and the tool rejects the input.
 */

import { Array as Arr, Order } from "effect";
import { isObject, type Json } from "../shaping.ts";

interface JsonObject {
  readonly [key: string]: Json;
}

/** A content block as far as it has arrived, with the JSON text of its input received so far. */
interface Arriving {
  readonly block: JsonObject;
  readonly inputJson: string;
}

export interface Assembling {
  /** The message as `message_start` delivered it. */
  readonly message: JsonObject | undefined;
  /** The top-level message fields that `message_delta` events changed. */
  readonly changed: JsonObject;
  readonly usage: JsonObject | undefined;
  readonly arriving: ReadonlyMap<number, Arriving>;
  readonly complete: ReadonlyMap<number, JsonObject>;
  /** Whether `message_stop` arrived: the stream's own signal that the message is complete. */
  readonly stopped: boolean;
}

export const nothingYet: Assembling = {
  message: undefined,
  changed: {},
  usage: undefined,
  arriving: new Map(),
  complete: new Map(),
  stopped: false,
};

export interface Assembled {
  readonly state: Assembling;
  /** The block this event completed. */
  readonly completed?: JsonObject;
  /** The stream's own report of an error. */
  readonly failed?: { readonly type: string; readonly message: string };
  /** The type of a delta that this machine cannot apply; the block is kept without it. */
  readonly notApplied?: string;
  /** The tool_use block this event completed, when its streamed input is not JSON: the block's `input` is that text. */
  readonly unparsed?: Unparsed;
}

/** A tool_use block whose input, as streamed, is not JSON. */
export interface Unparsed {
  readonly id: string;
  readonly name: string;
  readonly input: string;
}

const object = (value: Json | undefined): JsonObject | undefined => (value !== undefined && isObject(value) ? value : undefined);
const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/** Returns the block with the delta applied, or the delta's type when this machine cannot apply it. */
function applied(arriving: Arriving, delta: JsonObject): Arriving | string {
  const { block } = arriving;
  const type = text(delta["type"]);
  switch (type) {
    case "text_delta":
      return { ...arriving, block: { ...block, text: text(block["text"]) + text(delta["text"]) } };
    case "thinking_delta":
      return { ...arriving, block: { ...block, thinking: text(block["thinking"]) + text(delta["thinking"]) } };
    case "signature_delta":
      return { ...arriving, block: { ...block, signature: text(delta["signature"]) } };
    case "input_json_delta":
      return { ...arriving, inputJson: arriving.inputJson + text(delta["partial_json"]) };
    case "citations_delta": {
      const citations = Array.isArray(block["citations"]) ? block["citations"] : [];
      return { ...arriving, block: { ...block, citations: [...citations, delta["citation"] ?? null] } };
    }
    default:
      return type;
  }
}

/**
 * Returns the completed block, with its input parsed from the JSON text that arrived, if any. When
 * that text is not JSON, the block's input is the text, and the block is reported as `unparsed`.
 */
function finished(arriving: Arriving): { readonly block: JsonObject; readonly unparsed?: Unparsed } {
  if (arriving.inputJson === "") return { block: arriving.block };
  try {
    return { block: { ...arriving.block, input: JSON.parse(arriving.inputJson) as Json } };
  } catch {
    return {
      block: { ...arriving.block, input: arriving.inputJson },
      unparsed: { id: text(arriving.block["id"]), name: text(arriving.block["name"]), input: arriving.inputJson },
    };
  }
}

export function assemble(state: Assembling, event: Json): Assembled {
  if (!isObject(event)) return { state };
  const index = typeof event["index"] === "number" ? event["index"] : -1;
  switch (text(event["type"])) {
    case "message_start":
      return { state: { ...state, message: object(event["message"]) } };
    case "content_block_start": {
      const block = object(event["content_block"]);
      return block === undefined ? { state } : { state: { ...state, arriving: new Map([...state.arriving, [index, { block, inputJson: "" }]]) } };
    }
    case "content_block_delta": {
      const arriving = state.arriving.get(index);
      const delta = object(event["delta"]);
      if (arriving === undefined || delta === undefined) return { state };
      const next = applied(arriving, delta);
      return typeof next === "string"
        ? { state, notApplied: next }
        : { state: { ...state, arriving: new Map([...state.arriving, [index, next]]) } };
    }
    case "content_block_stop": {
      const arriving = state.arriving.get(index);
      if (arriving === undefined) return { state };
      const { block: completed, unparsed } = finished(arriving);
      const stillArriving = new Map([...state.arriving].filter(([at]) => at !== index));
      return {
        state: { ...state, arriving: stillArriving, complete: new Map([...state.complete, [index, completed]]) },
        completed,
        ...(unparsed === undefined ? {} : { unparsed }),
      };
    }
    case "message_delta":
      return {
        state: {
          ...state,
          changed: { ...state.changed, ...object(event["delta"]) },
          usage: { ...state.usage, ...object(event["usage"]) },
        },
      };
    case "message_stop":
      return { state: { ...state, stopped: true } };
    case "error": {
      const error = object(event["error"]);
      return { state, failed: { type: text(error?.["type"]), message: text(error?.["message"]) } };
    }
    default:
      return { state };
  }
}

/** Returns a map's entries, keyed by block index, in index order. */
const byIndex: Order.Order<readonly [number, unknown]> = Order.mapInput(Order.Number, ([at]) => at);

/** Returns the message with its complete blocks; undefined when the stream never started a message. */
export function assembled(state: Assembling): JsonObject | undefined {
  if (state.message === undefined) return undefined;
  const usage = state.usage === undefined ? state.message["usage"] : { ...object(state.message["usage"]), ...state.usage };
  return {
    ...state.message,
    ...state.changed,
    ...(usage === undefined ? {} : { usage }),
    content: Arr.sort(state.complete, byIndex).map(([, block]) => block),
  };
}

/** Returns the types of the blocks that were still arriving, in order. */
export function cut(state: Assembling): ReadonlyArray<string> {
  return Arr.sort(state.arriving, byIndex).map(([, arriving]) => text(arriving.block["type"]));
}
