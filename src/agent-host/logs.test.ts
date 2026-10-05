/** Log lines to a file. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Layer } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { LogsToFile } from "./logs.ts";

test("log lines go to the file named, in a folder made for it when missing, written by the time the layer is closed", async () => {
  const file = `${testFolder()}/not/yet/made/host.log`;
  await runTest(Effect.logInfo("host.started", { port: 1 }).pipe(Effect.provide(LogsToFile(file).pipe(Layer.provide(BunServices.layer)))));
  const text = await Bun.file(file).text();
  expect(text).toContain("host.started");
});

test("the CLI's log redacts the environment's secrets wherever they are, and a credential field's value; a value under 8 characters is reported, not searched for", async () => {
  const file = `${testFolder()}/host.log`;
  const env = { GITHUB_PAT: "github_pat_0123456789", OPENAI_API_KEY: "set", HOME: "/home/x" };
  await runTest(
    Effect.logWarning("pushing with github_pat_0123456789", { headers: { authorization: "Bearer plain-credential" }, settings: "set" }, Cause.fail(new Error("refused github_pat_0123456789"))).pipe(
      Effect.annotateLogs({ request: "r-github_pat_0123456789" }),
      Effect.provide(LogsToFile(file, env).pipe(Layer.provide(BunServices.layer))),
    ),
  );
  const text = await Bun.file(file).text();
  for (const secret of ["github_pat_0123456789", "plain-credential"]) expect(text).not.toContain(secret);
  const [said, record] = text.trim().split("\n");
  expect(said).toContain("host_logs.secrets_not_looked_for");
  expect(said).toContain("OPENAI_API_KEY");
  expect(said).not.toContain('"set"');
  expect(record).toContain("pushing with <redacted>");
  // logfmt quotes the message's JSON.
  expect(record).toContain(String.raw`\"authorization\":\"<redacted>\"`);
  expect(record).toContain(String.raw`\"settings\":\"set\"`);
  expect(record).toContain("refused <redacted>");
  expect(record).toContain("request=r-<redacted>");
});

