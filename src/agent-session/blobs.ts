/**
 * The blob store: bytes held outside the facts, found by their id, the lowercase hex SHA-256 of
 * the bytes (`BlobRef`, agent-machine). Storing the same bytes twice gives the same reference. The
 * facts hold references; an adapter reads the bytes when it makes a request.
 *
 * `Blobs` is a reference whose default holds bytes in memory for as long as the process runs, so a
 * session given no store still finds what it stored. `BlobsInMemory` holds bytes for as long as its
 * layer lasts; `BlobsInFolder(folder)` keeps each as a file named for its id.
 *
 * `keptOutcome` puts a tool's output that arrived as bytes in the store, so the facts hold its
 * reference (`Received` body `Stored`).
 */

import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { BlobId, type BlobRef, FileName } from "../agent-machine/blob.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { MediaType } from "../agent-machine/received.ts";

export interface BlobStore {
  /** Stores `bytes`, and returns the reference the facts hold. */
  readonly store: (bytes: Uint8Array, mediaType: MediaType, name?: string) => Effect.Effect<BlobRef>;
  /** The bytes with `id`, or undefined when the store does not hold them. */
  readonly read: (id: BlobId) => Effect.Effect<Uint8Array | undefined>;
}

/** The id of `bytes`: their lowercase hex SHA-256. */
export const blobIdOf = (bytes: Uint8Array): BlobId => BlobId.make(createHash("sha256").update(bytes).digest("hex"));

const referenceTo = (bytes: Uint8Array, mediaType: MediaType, name: string | undefined): BlobRef => ({
  id: blobIdOf(bytes),
  mediaType,
  size: bytes.byteLength,
  ...(name === undefined ? {} : { name: FileName.make(name) }),
});

/** A store over a map it is given: what `BlobsInMemory` and the default hold. */
const inMap = (held: Map<BlobId, Uint8Array>): BlobStore => ({
  store: (bytes, mediaType, name) =>
    Effect.sync(() => {
      const reference = referenceTo(bytes, mediaType, name);
      held.set(reference.id, bytes);
      return reference;
    }),
  read: (id) => Effect.sync(() => held.get(id)),
});

export const Blobs = Context.Reference<BlobStore>("agent-session/Blobs", { defaultValue: () => inMap(new Map()) });

/** `outcome`, with an output that arrived as bytes put in the store and held by reference. */
export const keptOutcome = (outcome: ToolOutcome): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    if (outcome._tag !== "Succeeded" || outcome.output.body._tag !== "Bytes") return outcome;
    const stored = yield* (yield* Blobs).store(outcome.output.body.bytes, outcome.output.mediaType);
    return { ...outcome, output: { mediaType: outcome.output.mediaType, body: { _tag: "Stored", id: stored.id, size: stored.size } } };
  });

export const BlobsInMemory = Layer.sync(Blobs, () => inMap(new Map()));

/** A file that cannot be written or read is a defect: the bytes the facts refer to cannot be kept. */
export const BlobsInFolder = (folder: string) =>
  Layer.effect(
    Blobs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        store: (bytes, mediaType, name) =>
          Effect.gen(function* () {
            const reference = referenceTo(bytes, mediaType, name);
            yield* fs.makeDirectory(folder, { recursive: true });
            yield* fs.writeFile(path.join(folder, reference.id), bytes);
            return reference;
          }).pipe(Effect.orDie),
        read: (id) =>
          Effect.gen(function* () {
            const file = path.join(folder, id);
            return (yield* fs.exists(file)) ? yield* fs.readFile(file) : undefined;
          }).pipe(Effect.orDie),
      };
    }),
  );
