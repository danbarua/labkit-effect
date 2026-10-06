/** Writing one setting into the user's configuration folder. */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { fileLayers, loadConfiguration } from "./file.ts";
import { writeSetting } from "./write.ts";

/** The user's folder of this test, holding `files` (by name, their text). */
const folderWith = (files: Readonly<Record<string, string>>): string => {
  const folder = join(testFolder(), "config");
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  return folder;
};

/** Writes `path` as `value` into `folder`; returns the file written and the folder's configuration. */
const written = (folder: string, path: ReadonlyArray<string>, value: string, fallback: string) =>
  runTest(
    Effect.gen(function* () {
      const file = yield* writeSetting(folder, path, value, fallback);
      const configuration = yield* loadConfiguration(yield* fileLayers(testFolder(), { configDir: folder }));
      return { file, configuration };
    }).pipe(Effect.provide(BunServices.layer)),
  );

test("a setting is written into the last of the folder's files that sets it, keeping its comments, and the folder's configuration reads it", async () => {
  const folder = folderWith({
    "10_first.yml": "model: openai/gpt-5\n",
    "40_models.yml": "# Models.\n\n# The model a new session asks.\nmodel: anthropic/claude-sonnet-5-5 # chosen 2026-10-01\n\nmodels:\n  # Measured.\n  xai/grok-4.7:\n    efforts: [minimal, low]\n",
  });
  const { file, configuration } = await written(folder, ["model"], "openai/gpt-5.5", "models.yml");
  expect(file).toBe(join(folder, "40_models.yml"));
  expect(configuration.model).toBe("openai/gpt-5.5");
  const text = readFileSync(file, "utf8");
  expect(text).toBe("# Models.\n\n# The model a new session asks.\nmodel: openai/gpt-5.5 # chosen 2026-10-01\n\nmodels:\n  # Measured.\n  xai/grok-4.7:\n    efforts: [minimal, low]\n");
  expect(readFileSync(join(folder, "10_first.yml"), "utf8")).toBe("model: openai/gpt-5\n");
  expect(existsSync(join(folder, "models.yml"))).toBe(false);
});

test("a file written keeps a long value on one line, and a quoted value quoted", async () => {
  const text = [
    "model: openai/gpt-5",
    "mcpServers:",
    "  files:",
    "    command: files-mcp",
    '    args: ["--root", "/a/very/long/path/that/goes/on/and/on/and/on/past/eighty/columns/for/sure/really"]',
    "    env:",
    "      NOTE: this is a long plain value with many words in it that runs well past the eighty column default width",
    "      QUOTED: 'single quoted'",
    "",
  ].join("\n");
  const folder = folderWith({ "models.yml": text });
  await written(folder, ["model"], "openai/gpt-5.5", "models.yml");
  expect(readFileSync(join(folder, "models.yml"), "utf8")).toBe(text.replace("model: openai/gpt-5\n", "model: openai/gpt-5.5\n"));
});

test("a setting no file sets is written into the fallback file, which is created, with the folder, when it does not exist", async () => {
  const folder = join(testFolder(), "new");
  const { file, configuration } = await written(folder, ["cli", "view", "thinking"], "off", "settings.yml");
  expect(file).toBe(join(folder, "settings.yml"));
  expect(readFileSync(file, "utf8")).toBe("cli:\n  view:\n    thinking: off\n");
  // YAML 1.2 reads `off` as a string; YAML 1.1 would read it as false.
  expect(configuration.cli).toEqual({ view: { thinking: "off" } });
});

test("a fallback file that exists keeps what it holds", async () => {
  const folder = folderWith({ "settings.yml": "# Mine.\nmaxHolds: 2\n" });
  const { configuration } = await written(folder, ["cli", "view", "thinking"], "off", "settings.yml");
  expect(readFileSync(join(folder, "settings.yml"), "utf8")).toBe("# Mine.\nmaxHolds: 2\ncli:\n  view:\n    thinking: off\n");
  expect(configuration.maxHolds).toBe(2);
});

test("a file of the folder that does not parse is not written, and the error names it", async () => {
  const folder = folderWith({ "models.yml": "model: [unclosed\n" });
  const error = await runTest(writeSetting(folder, ["model"], "openai/gpt-5.5", "models.yml").pipe(Effect.flip, Effect.provide(BunServices.layer)));
  expect(error.file).toBe(join(folder, "models.yml"));
  expect(error.problem).toStartWith("Not YAML:");
  expect(readFileSync(join(folder, "models.yml"), "utf8")).toBe("model: [unclosed\n");
});
