/** The blob store: bytes by their SHA-256, the same bytes the same reference, kept in memory or in a folder. */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { BlobId } from "../agent-machine/blob.ts";
import { MediaType } from "../agent-machine/received.ts";
import { Blobs, BlobsInFolder, BlobsInMemory } from "./blobs.ts";

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
        read: yield* blobs.read(first.id),
        missing: yield* blobs.read(BlobId.make("0".repeat(64))),
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

test("in a folder, each blob is a file named for its id", async () => {
  const folder = mkdtempSync(join(tmpdir(), "blobs-"));
  await contract(BlobsInFolder(folder).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))));
  expect(readdirSync(folder)).toEqual([helloId]);
});

test("with no store provided, nothing is held: a read finds nothing", async () => {
  const { read } = await runTest(
    Effect.gen(function* () {
      const blobs = yield* Blobs;
      const stored = yield* blobs.store(bytes, MediaType.make("text/plain"));
      return { read: yield* blobs.read(stored.id) };
    }),
  );
  expect(read).toBeUndefined();
});
