/** A spawned process's environment: this process's without its credentials, and a command's own over it. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Stream } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { isCredential, withoutCredentials } from "./environment.ts";
import { makeProcessGroup } from "./process-group.ts";

test("PE1: a variable holds a credential when a word of its name is one of the credential words, in any case", () => {
  const held = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "npm_config__authToken", "DB_PASSWORD", "GH_PAT", "my.secret", "OPENAI_APIKEY"];
  const kept = ["PATH", "HOME", "GIT_AUTHOR_NAME", "KEYBOARD_LAYOUT", "MONKEY", "PATTERN", "LANG"];
  expect(held.filter((name) => !isCredential(name))).toEqual([]);
  expect(kept.filter(isCredential)).toEqual([]);
  expect(withoutCredentials({ PATH: "/bin", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", EMPTY: undefined })).toEqual({ env: { PATH: "/bin" }, left: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"] });
});

test("PE2: a run is given this process's environment without its credentials, and the command's own env as it says, credentials included", async () => {
  process.env["LABKIT_TEST_TOKEN"] = "inherited";
  process.env["LABKIT_TEST_PLAIN"] = "plain";
  const printed = await runTest(
    Effect.gen(function* () {
      const output = yield* Deferred.make<string>();
      const group = yield* makeProcessGroup(
        { name: "env", command: "/bin/sh", args: ["-c", "env"], env: { SERVER_TOKEN: "given" } },
        (_run, handle) => handle.stdout.pipe(Stream.decodeText, Stream.mkString, Effect.flatMap((text) => Deferred.succeed(output, text)), Effect.ignore),
      );
      yield* group.start;
      return yield* Deferred.await(output).pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const names = printed.split("\n").map((line) => line.split("=")[0]);
  expect(names).toContain("LABKIT_TEST_PLAIN");
  expect(names).not.toContain("LABKIT_TEST_TOKEN");
  expect(printed).toContain("SERVER_TOKEN=given");
});
