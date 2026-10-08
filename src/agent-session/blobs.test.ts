/** The blob store: bytes by their SHA-256, the same bytes the same reference, kept in memory or in a folder. */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer, Logger } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { BlobId } from "../agent-machine/blob.ts";
import { MediaType } from "../agent-machine/received.ts";
import { Blobs, BlobsInFolder, BlobsInMemory, blobUriOf, extensionOf, keptOutcome, parseBlobUri } from "./blobs.ts";
import { logKeys } from "./log-keys.ts";

const bytes = new TextEncoder().encode("hello");
// sha256("hello")
const helloId = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const contract = (store: Layer.Layer<never>) =>
  runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const first = yield* blobs.store(bytes, MediaType.make("text/plain"), "hello.txt");
      const again = yield* blobs.store(bytes, MediaType.make("text/plain"));
      return {
        first,
        again,
        read: yield* blobs.read(first.id, "txt"),
        missing: yield* blobs.read(BlobId.make("0".repeat(64)), "txt"),
      };
    }).pipe(Effect.provide(store)),
  );

for (const [name, store] of [
  ["in memory", () => BlobsInMemory],
  ["in a folder", () => BlobsInFolder(mkdtempSync(join(tmpdir(), "blobs-"))).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))],
] as const)
  test(`${name}: the id is the bytes' SHA-256, the same bytes give the same id, and a read gives them back`, async () => {
    const { first, again, read, missing } = await contract(store());
    expect(first as unknown).toEqual({ id: helloId, mediaType: "text/plain", size: 5, name: "hello.txt" });
    expect(again.id).toBe(first.id);
    expect(read).toEqual(bytes);
    expect(missing).toBeUndefined();
  });

test("in a folder, each blob is a file named for its id and the extension of its media type", async () => {
  const folder = mkdtempSync(join(tmpdir(), "blobs-"));
  await contract(BlobsInFolder(folder).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))));
  expect(readdirSync(folder)).toEqual([`${helloId}.txt`]);
});

test("a blob's extension is its media type's own, parameters left out; json for +json, xml for +xml, txt for other text, bin for anything else; its pointer is blob://<id>.<extension>", () => {
  const types = ["image/png", "image/jpeg", "text/plain; charset=utf-8", "text/csv", "image/svg+xml", "application/vnd.modelcontextprotocol.call-tool-result+json", "application/atom+xml", "text/x-python", "application/x-thing", ""];
  expect(types.map((type) => extensionOf(type))).toEqual(["png", "jpg", "txt", "csv", "svg", "json", "xml", "txt", "bin", "bin"]);
  expect(blobUriOf(BlobId.make(helloId), "image/png")).toBe(`blob://${helloId}.png`);
  expect([parseBlobUri(`blob://${helloId}.csv`), parseBlobUri(`blob://${helloId}`), parseBlobUri(`blob://${helloId}./../x`), parseBlobUri("blob://abc.png")] as unknown).toEqual([
    { id: helloId, extension: "csv" },
    { id: helloId, extension: "" },
    undefined,
    undefined,
  ]);
});

test("in a folder, a blob missing from it is read from the folders read also, in order, named for its id alone as before blobs had extensions; a store writes only to its own folder", async () => {
  const [own, older] = [mkdtempSync(join(tmpdir(), "blobs-")), mkdtempSync(join(tmpdir(), "blobs-older-"))];
  writeFileSync(join(older, helloId), bytes);
  const found = await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const read = yield* blobs.read(BlobId.make(helloId), "txt");
      yield* blobs.store(new TextEncoder().encode("new"), MediaType.make("text/plain"));
      return read;
    }).pipe(Effect.provide(BlobsInFolder(own, [older]).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))))),
  );
  expect(found).toEqual(bytes);
  expect(readdirSync(older)).toEqual([helloId]);
  expect(readdirSync(own)).toHaveLength(1);
});

test("with no store provided, the default holds the bytes in memory", async () => {
  const { read } = await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const stored = yield* blobs.store(bytes, MediaType.make("text/plain"));
      return { read: yield* blobs.read(stored.id, "txt") };
    }),
  );
  expect(read).toEqual(bytes);
});

test("a tool's output that arrives as bytes is put in the store, and the outcome holds its reference", async () => {
  const { kept, read } = await runTest(
    Effect.gen(function* () {
      const kept = yield* keptOutcome({ _tag: "Succeeded", output: { mediaType: MediaType.make("image/png"), body: { _tag: "Bytes", bytes } } });
      const body = kept._tag === "Succeeded" ? kept.output.body : undefined;
      return { kept, read: body?._tag === "Stored" ? yield* (yield* Blobs).read(body.id, "png") : undefined };
    }).pipe(Effect.provide(BlobsInMemory)),
  );
  expect(kept as unknown).toEqual({ _tag: "Succeeded", output: { mediaType: "image/png", body: { _tag: "Stored", id: helloId, size: 5 } } });
  expect(read).toEqual(bytes);
});

const inFolder = (folder: string) => BlobsInFolder(folder).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)));

test("in a folder, the store reads only ids and extensions that name a file in it: anything else finds nothing", async () => {
  const folder = mkdtempSync(join(tmpdir(), "blobs-"));
  writeFileSync(join(folder, "..", `outside-${helloId}`), bytes);
  writeFileSync(join(folder, `${helloId}.txt`), bytes);
  const read = await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      return [
        yield* blobs.read(BlobId.make(`../outside-${helloId}`), "txt"),
        yield* blobs.read(BlobId.make(helloId.toUpperCase()), "txt"),
        yield* blobs.read(BlobId.make(""), "txt"),
        yield* blobs.read(BlobId.make(helloId), "/../../x"),
      ];
    }).pipe(Effect.provide(inFolder(folder))),
  );
  expect(read).toEqual([undefined, undefined, undefined, undefined]);
});

test("in a folder, a file whose bytes no longer match its id is found to be nothing, and logged", async () => {
  const folder = mkdtempSync(join(tmpdir(), "blobs-"));
  const logged: Array<unknown> = [];
  const read = await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const stored = yield* blobs.store(bytes, MediaType.make("text/plain"));
      writeFileSync(join(folder, `${stored.id}.txt`), "changed");
      return yield* blobs.read(stored.id, "txt");
    }).pipe(Effect.provide(Layer.mergeAll(inFolder(folder), Logger.layer([Logger.make((options) => logged.push(options.message))], { mergeWithExisting: true })))),
  );
  expect(read).toBeUndefined();
  expect(logged).toContainEqual([logKeys.blobs.notAsStored, expect.objectContaining({ blob: helloId, size: 7 })]);
});

test("in a folder, the same bytes stored twice are one file, and no temporary file is left", async () => {
  const folder = mkdtempSync(join(tmpdir(), "blobs-"));
  await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      yield* blobs.store(bytes, MediaType.make("text/plain"));
      yield* blobs.store(bytes, MediaType.make("text/plain"), "again.txt");
    }).pipe(Effect.provide(inFolder(folder))),
  );
  expect(readdirSync(folder)).toEqual([`${helloId}.txt`]);
});
