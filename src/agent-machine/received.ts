/**
 * Content from outside the harness, as it arrived: a tool's input or output, a provider's
 * metadata, a policy's reason. It is untrusted. It may not be structured, and parsing it may fail.
 * The core carries it and does not look inside; an adapter that needs its contents parses it.
 */

import { Schema } from "effect";

/** What the sender says the content is, such as `application/json`. A claim, not a guarantee. */
export const MediaType = Schema.String.pipe(Schema.brand("agent-machine/MediaType"));
export type MediaType = typeof MediaType.Type;

/** Text as it arrived, unparsed. */
export const ReceivedText = Schema.String.pipe(Schema.brand("agent-machine/ReceivedText"));
export type ReceivedText = typeof ReceivedText.Type;

/** The id of bytes in the blob store: the lowercase hex SHA-256 of the bytes. */
export const BlobId = Schema.String.pipe(Schema.brand("agent-machine/BlobId"));
export type BlobId = typeof BlobId.Type;

/**
 * Content as text, as bytes, or as bytes kept in the blob store (`Stored`: their id and length),
 * which is how the facts hold bytes that came from outside, such as a tool's image.
 */
export const Received = Schema.Struct({
  mediaType: MediaType,
  body: Schema.Union([
    Schema.TaggedStruct("Text", { text: ReceivedText }),
    Schema.TaggedStruct("Bytes", { bytes: Schema.Uint8Array }),
    Schema.TaggedStruct("Stored", { id: BlobId, size: Schema.Int }),
  ]),
});
export type Received = typeof Received.Type;
