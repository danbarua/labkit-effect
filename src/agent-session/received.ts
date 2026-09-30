/**
 * Wrapping content from outside in `Received`, and parsing it back out, at the edge.
 */

import type { Schema } from "effect";
import { MediaType, type Received, ReceivedText } from "../agent-machine/received.ts";

const json = MediaType.make("application/json");

/** A JSON value, written out as the body of `application/json` content. */
export function receivedJson(value: Schema.Json): Received {
  return { mediaType: json, body: { _tag: "Text", text: ReceivedText.make(JSON.stringify(value)) } };
}

/** JSON exactly as it was received, as text, without parsing it. */
export function receivedJsonText(text: string): Received {
  return { mediaType: json, body: { _tag: "Text", text: ReceivedText.make(text) } };
}

/** Plain text content. */
export function receivedText(text: string): Received {
  return { mediaType: MediaType.make("text/plain"), body: { _tag: "Text", text: ReceivedText.make(text) } };
}

/** The JSON value in `received`, or the reason there is none. */
export function parseJson(received: Received): { readonly value: Schema.Json } | { readonly reason: string } {
  if (received.body._tag === "Bytes")
    return { reason: `the content is ${received.body.bytes.length} bytes of ${received.mediaType}, not text` };
  try {
    return { value: JSON.parse(received.body.text) as Schema.Json };
  } catch (error) {
    return { reason: `the content is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The content as text for a reader: the text itself, or a note of what the bytes are. */
export function asText(received: Received): string {
  return received.body._tag === "Text"
    ? received.body.text
    : `[${received.body.bytes.length} bytes of ${received.mediaType}]`;
}
