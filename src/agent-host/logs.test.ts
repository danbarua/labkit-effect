/** Log lines to a file. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { LogsToFile } from "./logs.ts";

test("H6: log lines go to the file named, in a folder made for it when missing, written by the time the layer is closed", async () => {
  const file = `${testFolder()}/not/yet/made/host.log`;
  await runTest(Effect.logInfo("host.started", { port: 1 }).pipe(Effect.provide(LogsToFile(file).pipe(Layer.provide(BunServices.layer)))));
  const text = await Bun.file(file).text();
  expect(text).toContain("host.started");
});
