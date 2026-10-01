/**
 * A reference to bytes held outside the facts: an attachment, or a tool's binary output. The facts
 * hold the reference; the bytes are in the blob store (agent-session `Blobs`), found by the id,
 * which is the lowercase hex SHA-256 of the bytes, so the same bytes always have the same id.
 */

import { Schema } from "effect";
import { BlobId, MediaType } from "./received.ts";

export { BlobId };

/** The file name a blob came with. */
export const FileName = Schema.String.pipe(Schema.brand("agent-machine/FileName"));
export type FileName = typeof FileName.Type;

/** `size` is the bytes' length; `name` is the file name it came with, when it had one. */
export const BlobRef = Schema.Struct({
  id: BlobId,
  mediaType: MediaType,
  size: Schema.Int,
  name: Schema.optionalKey(FileName),
});
export type BlobRef = typeof BlobRef.Type;
