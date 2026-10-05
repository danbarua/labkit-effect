/** A spawned process's environment: this process's without its credentials, and a command's own over it. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Stream } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { shouldRedact, redactedArgs, withoutCredentials } from "./environment.ts";
import { makeProcessGroup } from "./process-group.ts";

test("PE1: a variable holds a credential if its name includes known words", () => {
  const held = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK", "npm_config__authToken", "DB_PASSWORD", "GH_PAT", "my.secret", "OPENAI_APIKEY"];
  for (const h of held) {
    expect(shouldRedact(h), `"${h} should be redacted`).toBeTrue();
  }

  const kept = ["PATH", "HOME", "GIT_AUTHOR_NAME", "KEYBOARD_LAYOUT", "MONKEY", "PATTERN", "LANG", "MAX_TOKENS"];
  for (const k of kept) {
    expect(shouldRedact(k), `"${k}" should not be redacted`).toBeFalse();
  }

  expect(withoutCredentials({ PATH: "/bin", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", EMPTY: undefined })).toEqual({ env: { PATH: "/bin" }, left: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"] });
});

test("PE1: a credential word inside a camelCase name is bounded by a capital after a lower-case letter, at both ends", () => {
  const held = ["apiKeyId", "githubTokenValue", "passwordHash", "myPAT", "XApiKey", "authToken"];
  for (const h of held) {
    expect(shouldRedact(h), `"${h}" should be redacted`).toBeTrue();
  }
  const kept = ["monkey", "bypass", "compass", "turkey", "keyboard", "tokenizer", "pathToFile"];
  for (const k of kept) {
    expect(shouldRedact(k), `"${k}" should not be redacted`).toBeFalse();
  }
});

test("PE1: secret values in flags are not logged", () => {
  expect(redactedArgs(["stdio", "--token=ghp_x", "--api-key", "sk-y", "--read-only", "--port", "8080", "--auth-token", "--verbose"])).toEqual([
    "stdio",
    "--token=<left out>",
    "--api-key",
    "<left out>",
    "--read-only",
    "--port",
    "8080",
    "--auth-token",
    "--verbose",
  ]);
});

test("PE2: A run receives this process's environment minus credential variables plus specified kept variables", async () => {
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
