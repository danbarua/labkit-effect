/**
 * Content from outside the harness, as it arrived: a tool's input or output, a provider's
 * metadata, a policy's reason. It is untrusted. It may not be structured, and parsing it may fail.
 * The core carries it and does not look inside; an adapter that needs its contents parses it.
 */

import { Schema } from "effect";

/** What the sender says the content is, such as `application/json`. A claim, not a guarantee. */
export const MediaType = Schema.String.pipe(Schema.brand("agent-core/MediaType"));
export type MediaType = typeof MediaType.Type;

/** Text as it arrived, unparsed. */
export const ReceivedText = Schema.String.pipe(Schema.brand("agent-core/ReceivedText"));
export type ReceivedText = typeof ReceivedText.Type;

export const Received = Schema.Struct({
  mediaType: MediaType,
  body: Schema.Union([
    Schema.TaggedStruct("Text", { text: ReceivedText }),
    Schema.TaggedStruct("Bytes", { bytes: Schema.Uint8Array }),
  ]),
});
export type Received = typeof Received.Type;
