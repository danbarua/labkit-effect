/**
 * The blob store: bytes held outside the facts, found by their id, the lowercase hex SHA-256 of
 * the bytes (`BlobRef`, agent-machine). Storing the same bytes twice gives the same reference. The
 * facts hold references; an adapter reads the bytes when it makes a request.
 *
 * `Blobs` is a reference whose default holds bytes in memory for as long as the process runs, so a
 * session given no store still finds what it stored. `BlobsInMemory` holds bytes for as long as its
 * layer lasts; `BlobsInFolder(folder)` keeps each as a file named for its id, in that folder only.
 *
 * `keptOutcome` puts a tool's output that arrived as bytes in the store, so the facts hold its
 * reference (`Received` body `Stored`).
 */

import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, HashMap, Layer, Option, Path, Ref } from "effect";
import { BlobId, type BlobRef, FileName } from "../agent-machine/blob.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { MediaType } from "../agent-machine/received.ts";
import { logKeys } from "./log-keys.ts";

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

/** A store over the map `held` holds: what `BlobsInMemory` and the default hold. */
const inMap = (held: Ref.Ref<HashMap.HashMap<BlobId, Uint8Array>>): BlobStore => ({
  store: (bytes, mediaType, name) =>
    Effect.suspend(() => {
      const reference = referenceTo(bytes, mediaType, name);
      return Ref.update(held, HashMap.set(reference.id, bytes)).pipe(Effect.as(reference));
    }),
  read: (id) => Effect.map(Ref.get(held), (all) => Option.getOrUndefined(HashMap.get(all, id))),
});

export const Blobs = Context.Reference<BlobStore>("agent-session/Blobs", { defaultValue: () => inMap(Ref.makeUnsafe(HashMap.empty())) });

/** `outcome`, with an output that arrived as bytes put in the store and held by reference. */
export const keptOutcome = (outcome: ToolOutcome): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    if (outcome._tag !== "Succeeded" || outcome.output.body._tag !== "Bytes") return outcome;
    const stored = yield* (yield* Blobs).store(outcome.output.body.bytes, outcome.output.mediaType);
    return { ...outcome, output: { mediaType: outcome.output.mediaType, body: { _tag: "Stored", id: stored.id, size: stored.size } } };
  });

export const BlobsInMemory = Layer.effect(Blobs, Effect.map(Ref.make(HashMap.empty<BlobId, Uint8Array>()), inMap));

/** A blob id as this store writes them: 64 lowercase hex digits, so it names a file in the folder and nothing else. */
const isBlobId = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);

/**
 * Blobs as files in `folder`, each named for its id; the store reads and writes nothing outside
 * it. The folder is made when the first blob is stored. Swap it in for the default by providing
 * the layer; it needs a `FileSystem` and a `Path` (`@effect/platform-bun` gives both).
 *
 * - A blob is written to a temporary file in the folder and renamed to its id, so a file named for
 *   an id holds the whole of its bytes; bytes already held are not written again.
 * - An id that is not 64 lowercase hex digits finds nothing, so no id read from the facts names a
 *   path outside the folder.
 * - A read hashes what it read: a file whose bytes no longer match its id is found to be nothing,
 *   and logged, so the model is sent the file's pointer rather than other bytes.
 * - A file that cannot be written or read is a defect: the bytes the facts refer to cannot be kept.
 */
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
            const file = path.join(folder, reference.id);
            yield* fs.makeDirectory(folder, { recursive: true });
            if (yield* fs.exists(file)) return reference;
            const writing = path.join(folder, `.${reference.id}.${crypto.randomUUID()}`);
            yield* fs.writeFile(writing, bytes);
            yield* fs.rename(writing, file);
            return reference;
          }).pipe(Effect.orDie),
        read: (id) =>
          Effect.gen(function* () {
            if (!isBlobId(id)) return undefined;
            const file = path.join(folder, id);
            if (!(yield* fs.exists(file))) return undefined;
            const bytes = yield* fs.readFile(file);
            if (blobIdOf(bytes) === id) return bytes;
            yield* Effect.logWarning(logKeys.blobs.notAsStored, { blob: id, file, size: bytes.byteLength });
            return undefined;
          }).pipe(Effect.orDie),
      };
    }),
  );
