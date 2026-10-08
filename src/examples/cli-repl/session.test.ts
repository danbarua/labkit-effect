/** What the CLI records of a session, which stored sessions `--continue` and the `--resume` picker offer, and what a CLI session's log lines carry. */

import { expect } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, References } from "effect";
import { runTest } from "../../../tests/support/run.ts";
import { test, testFolder } from "../../../tests/support/test.ts";
import { loadConfiguration } from "../../agent-config/file.ts";
import { defaultBrand } from "../../agent-host/brand.ts";
import { brandFoldersLayer, brandFoldersOf } from "../../agent-host/brand-folders.ts";
import { Headless } from "../../agent-host/with-session.ts";
import { ModelName, ProviderName } from "../../agent-machine/names.ts";
import { cliRecord, type Config, madeIn, withCliSession } from "./session.ts";

test("a session counts as made in a folder only when its record names the CLI and that folder", () => {
  expect(cliRecord("/work/a")).toEqual({ host: "cli", cwd: "/work/a" });
  expect(madeIn(cliRecord("/work/a"), "/work/a")).toBe(true);
  expect(madeIn(cliRecord("/work/a"), "/work/b")).toBe(false);
  expect(madeIn({ host: "acp", cwd: "/work/a" }, "/work/a")).toBe(false);
  expect(madeIn(undefined, "/work/a")).toBe(false);
});

test("a log line written inside a CLI session carries the session's id (session), whatever writes it", async () => {
  const logged: Array<{ readonly message: unknown; readonly session: unknown }> = [];
  const capture = Logger.make((options) => {
    logged.push({ message: options.message, session: options.fiber.getRef(References.CurrentLogAnnotations)["session"] });
  });
  const configuration = { ...(await runTest(loadConfiguration([]))), layers: [] };
  const config: Config = {
    sessionId: "cli-logged",
    target: { provider: ProviderName.make("openai"), model: ModelName.make("gpt-5.5") },
    settings: {},
    system: undefined,
    persist: false,
    configuration,
    canAsk: false,
    additionalFolders: [],
    strictToolInput: false,
  };
  await runTest(
    withCliSession(config, Logger.layer([capture], { mergeWithExisting: true }), Headless, () => Effect.logInfo("test.inside_the_session")).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, brandFoldersLayer(brandFoldersOf(defaultBrand, { home: testFolder() })))),
    ),
  );
  // The loop names the session on what it records; the line from the session's own work is named by the session's context.
  const inside = logged.filter(({ message }) => JSON.stringify(message).includes("test.inside_the_session"));
  expect(inside.map(({ session }) => session)).toEqual(["cli-logged"]);
  const recorded = logged.filter(({ message }) => JSON.stringify(message).includes("loop.observation.recorded"));
  expect(recorded.length).toBeGreaterThan(0);
  expect(recorded.every(({ session }) => session === "cli-logged")).toBe(true);
});
