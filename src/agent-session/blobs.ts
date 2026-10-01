/**
 * The blob store: bytes held outside the facts, found by their id, the lowercase hex SHA-256 of
 * the bytes (`BlobRef`, agent-machine). Storing the same bytes twice gives the same reference. The
 * facts hold references; an adapter reads the bytes when it makes a request.
 *
 * `Blobs` is a reference with an empty store as its default: outside a session that provides one,
 * nothing is stored and every read finds nothing. `BlobsInMemory` holds bytes for as long as its
 * layer lasts; `BlobsInFolder(folder)` keeps each as a file named for its id.
 */

import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect";
import { BlobId, type BlobRef, FileName } from "../agent-machine/blob.ts";
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

const empty: BlobStore = {
  store: (bytes, mediaType, name) => Effect.succeed(referenceTo(bytes, mediaType, name)),
  read: () => Effect.undefined,
};

export const Blobs = Context.Reference<BlobStore>("agent-session/Blobs", { defaultValue: () => empty });

export const BlobsInMemory = Layer.effect(
  Blobs,
  Effect.gen(function* () {
    const held = yield* Ref.make<ReadonlyMap<BlobId, Uint8Array>>(new Map());
    return {
      store: (bytes, mediaType, name) => {
        const reference = referenceTo(bytes, mediaType, name);
        return Ref.update(held, (before) => new Map([...before, [reference.id, bytes]])).pipe(Effect.as(reference));
      },
      read: (id) => Ref.get(held).pipe(Effect.map((all) => all.get(id))),
    };
  }),
);

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
