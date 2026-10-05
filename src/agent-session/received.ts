/** Wraps content from outside in `Received`, and parses it back out, at the edge. */

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

/** Parses the JSON value in `received`; returns the reason when it holds none. */
export function parseJson(received: Received): { readonly value: Schema.Json } | { readonly reason: string } {
  if (received.body._tag === "Bytes")
    return { reason: `the content is ${received.body.bytes.length} bytes of ${received.mediaType}, not text` };
  if (received.body._tag === "Stored")
    return { reason: `the content is ${received.body.size} bytes of ${received.mediaType} in the blob store, not text` };
  try {
    return { value: JSON.parse(received.body.text) as Schema.Json };
  } catch (error) {
    return { reason: `the content is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Returns the content as text for a reader: the text itself, or a note of what the bytes are and, when stored, their reference. */
export function asText(received: Received): string {
  switch (received.body._tag) {
    case "Text":
      return received.body.text;
    case "Bytes":
      return `[${received.body.bytes.length} bytes of ${received.mediaType}]`;
    case "Stored":
      return `[${received.body.size} bytes of ${received.mediaType}: blob://${received.body.id}]`;
    default:
      return received.body satisfies never;
  }
}
