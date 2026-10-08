/**
 * The blob store: bytes kept outside the facts, found by their id, which is the lowercase hex
 * SHA-256 of the bytes (`BlobRef`, agent-machine). Storing the same bytes twice returns the same
 * reference. The facts hold references; an adapter reads the bytes when it makes a request.
 *
 * | Store | Keeps bytes |
 * | --- | --- |
 * | `Blobs` default | in memory, while the process runs, so a session given no store still finds what it stored |
 * | `BlobsInMemory` | in memory, while its layer lasts |
 * | `BlobsInFolder(folder, readAlso)` | as files named for their ids, in `folder`; read from `folder`, then from each of `readAlso` |
 *
 * `keptOutcome` puts a tool's output that arrived as bytes in the store, so the facts hold its
 * reference (`Received` body `Stored`).
 *
 * A blob is named `<id>.<extension>` (`blobNameOf`), the extension from its media type
 * (`extensionOf`): a folder store's file has that name, so the operator can open it with the
 * system's own apps, and a pointer to it is `blob://<id>.<extension>` (`blobUriOf`), so whoever
 * follows one knows its type without the facts.
 */

import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, HashMap, Layer, Option, Path, type PlatformError, Ref } from "effect";
import { BlobId, type BlobRef, FileName } from "../agent-machine/blob.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { MediaType } from "../agent-machine/received.ts";
import { logKeys } from "./log-keys.ts";

export interface BlobStore {
  /** Stores `bytes`, and returns the reference the facts hold. */
  readonly store: (bytes: Uint8Array, mediaType: MediaType, name?: string) => Effect.Effect<BlobRef>;
  /** The bytes with `id`, kept under the `extension` of their media type (`extensionOf`), or undefined when the store does not hold them. */
  readonly read: (id: BlobId, extension: string) => Effect.Effect<Uint8Array | undefined>;
}

/** The extension of each media type that has one of its own, as the system's apps and Bun's `Bun.file(…).type` read it. */
const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/zip": "zip",
  "application/octet-stream": "bin",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "text/xml": "xml",
  "text/css": "css",
  "text/javascript": "js",
  "text/yaml": "yaml",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
};

/**
 * The extension a blob of `mediaType` is named with: its own, from the table above, with any
 * parameters (`; charset=utf-8`) left out; `json` for a `+json` type and `xml` for a `+xml` one;
 * `txt` for any other text type; `bin` for anything else.
 */
export const extensionOf = (mediaType: string): string => {
  const essence = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  const own = extensions[essence];
  if (own !== undefined) return own;
  if (essence.endsWith("+json")) return "json";
  if (essence.endsWith("+xml")) return "xml";
  return essence.startsWith("text/") ? "txt" : "bin";
};

/** The name of the blob with `id` and `mediaType`: `<id>.<extension>`. */
export const blobNameOf = (id: BlobId, mediaType: string): string => `${id}.${extensionOf(mediaType)}`;

/** The pointer to the blob with `id` and `mediaType`: `blob://<id>.<extension>`. */
export const blobUriOf = (id: BlobId, mediaType: string): string => `blob://${blobNameOf(id, mediaType)}`;

/** A blob pointer: `blob://<id>`, then `.<extension>`; a pointer recorded before blobs had extensions has none. */
const blobUri = /^blob:\/\/([0-9a-f]{64})(?:\.([A-Za-z0-9]{1,16}))?$/;

/** The id and extension that `uri` points to; undefined when it is not a blob pointer. An extension left out is the empty one. */
export const parseBlobUri = (uri: string): { readonly id: BlobId; readonly extension: string } | undefined => {
  const found = blobUri.exec(uri);
  return found?.[1] === undefined ? undefined : { id: BlobId.make(found[1]), extension: found[2] ?? "" };
};

/** Returns the id of `bytes`: their lowercase hex SHA-256. */
export const blobIdOf = (bytes: Uint8Array): BlobId => BlobId.make(createHash("sha256").update(bytes).digest("hex"));

const referenceTo = (bytes: Uint8Array, mediaType: MediaType, name: string | undefined): BlobRef => ({
  id: blobIdOf(bytes),
  mediaType,
  size: bytes.byteLength,
  ...(name === undefined ? {} : { name: FileName.make(name) }),
});

/** Returns a store over the map in `held`, as `BlobsInMemory` and the default use. */
const inMap = (held: Ref.Ref<HashMap.HashMap<BlobId, Uint8Array>>): BlobStore => ({
  store: (bytes, mediaType, name) =>
    Effect.suspend(() => {
      const reference = referenceTo(bytes, mediaType, name);
      return Ref.update(held, HashMap.set(reference.id, bytes)).pipe(Effect.as(reference));
    }),
  // In memory, a blob is found by its id; its extension names a file only in a folder.
  read: (id) => Effect.map(Ref.get(held), (all) => Option.getOrUndefined(HashMap.get(all, id))),
});

export const Blobs = Context.Reference<BlobStore>("agent-session/Blobs", { defaultValue: () => inMap(Ref.makeUnsafe(HashMap.empty())) });

/** Returns `outcome` with an output that arrived as bytes put in the store and replaced by its reference. */
export const keptOutcome = (outcome: ToolOutcome): Effect.Effect<ToolOutcome> =>
  Effect.gen(function* () {
    if (outcome._tag !== "Succeeded" || outcome.output.body._tag !== "Bytes") return outcome;
    const stored = yield* (yield* Blobs).store(outcome.output.body.bytes, outcome.output.mediaType);
    return { ...outcome, output: { mediaType: outcome.output.mediaType, body: { _tag: "Stored", id: stored.id, size: stored.size } } };
  });

export const BlobsInMemory = Layer.effect(Blobs, Effect.map(Ref.make(HashMap.empty<BlobId, Uint8Array>()), inMap));

/** A blob id as this store writes them: 64 lowercase hex digits, so it names a file in the folder and nothing else. */
const isBlobId = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);

/** An extension as this store reads them: up to 16 letters and digits, or none, so `<id>.<extension>` names a file in the folder and nothing else. */
const isExtension = (extension: string): boolean => /^[A-Za-z0-9]{0,16}$/.test(extension);

/**
 * Blobs as files in `folder`, each named `<id>.<extension>` (`blobNameOf`). A read looks in `folder`
 * and then in each of `readAlso` in turn, such as the folder where a session kept its blobs before
 * blobs were kept in one folder for every session; in each, for `<id>.<extension>` and then for
 * `<id>`, a blob's name before blobs had extensions. The store writes nothing outside `folder`, and
 * reads nothing outside it and `readAlso`. The folder is created when the first blob is stored.
 * Provide the layer to use it in place of the default; it needs a `FileSystem` and a `Path`
 * (`@effect/platform-bun` provides both).
 *
 * - A blob is written to a temporary file in the folder and renamed to its name, so a file named for
 *   a blob holds the whole of its bytes; bytes already held are not written again.
 * - An id that is not 64 lowercase hex digits, or an extension that is not up to 16 letters and
 *   digits, finds nothing, so no pointer the model gives names a path outside the folders.
 * - A read hashes the bytes it read: a file whose bytes no longer match its id is treated as
 *   missing, and logged as a warning, so the model is sent the file's pointer rather than other
 *   bytes.
 * - A file that cannot be written or read is a defect, because the bytes that the facts refer to
 *   cannot be kept.
 */
export const BlobsInFolder = (folder: string, readAlso: ReadonlyArray<string> = []) =>
  Layer.effect(
    Blobs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        store: (bytes, mediaType, name) =>
          Effect.gen(function* () {
            const reference = referenceTo(bytes, mediaType, name);
            const file = path.join(folder, blobNameOf(reference.id, mediaType));
            yield* fs.makeDirectory(folder, { recursive: true });
            if (yield* fs.exists(file)) return reference;
            const writing = path.join(folder, `.${reference.id}.${crypto.randomUUID()}`);
            yield* fs.writeFile(writing, bytes);
            yield* fs.rename(writing, file);
            return reference;
          }).pipe(Effect.orDie),
        read: (id, extension) => {
          // The bytes with `id` in the first of `files` that exists and holds them.
          const readIn = (files: ReadonlyArray<string>): Effect.Effect<Uint8Array | undefined, PlatformError.PlatformError> => {
            const [file, ...rest] = files;
            if (file === undefined) return Effect.undefined;
            return Effect.gen(function* () {
              if (!(yield* fs.exists(file))) return yield* readIn(rest);
              const bytes = yield* fs.readFile(file);
              if (blobIdOf(bytes) === id) return bytes;
              yield* Effect.logWarning(logKeys.blobs.notAsStored, { blob: id, file, size: bytes.byteLength });
              return yield* readIn(rest);
            });
          };
          const names = [...(extension === "" ? [] : [`${id}.${extension}`]), id];
          const files = [folder, ...readAlso].flatMap((each) => names.map((name) => path.join(each, name)));
          return isBlobId(id) && isExtension(extension) ? readIn(files).pipe(Effect.orDie) : Effect.undefined;
        },
      };
    }),
  );
