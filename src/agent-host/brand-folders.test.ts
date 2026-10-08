/** The brand's folders: where each is by default, what each override moves, and a relative --data-dir refused. */

import { expect } from "bun:test";
import { Effect } from "effect";
import { runTest } from "../../tests/support/run.ts";
import { test } from "../../tests/support/test.ts";
import { brandFoldersFor, brandFoldersOf } from "./brand-folders.ts";

const acme = { name: "acme", version: "1.0.0" };

test("by default the folders are under the home folder: configuration in .config/<brand>, the rest in .local/share/<brand>; the project's folder is .<brand>", () => {
  expect(brandFoldersOf(acme, { home: "/home/a" })).toEqual({
    config: "/home/a/.config/acme",
    data: "/home/a/.local/share/acme",
    sessions: "/home/a/.local/share/acme/sessions/v0.1.0",
    blobs: "/home/a/.local/share/acme/blobs",
    logs: "/home/a/.local/share/acme/logs",
    project: ".acme",
  });
});

test("--data-dir moves sessions, blobs and logs together; --sessions-dir moves the sessions alone; --config-dir moves the configuration alone", () => {
  expect(brandFoldersOf(acme, { home: "/home/a", dataDir: "/srv/acme" })).toMatchObject({ config: "/home/a/.config/acme", sessions: "/srv/acme/sessions/v0.1.0", blobs: "/srv/acme/blobs", logs: "/srv/acme/logs" });
  expect(brandFoldersOf(acme, { home: "/home/a", sessionsDir: "/tmp/sessions" })).toMatchObject({ sessions: "/tmp/sessions", blobs: "/home/a/.local/share/acme/blobs", logs: "/home/a/.local/share/acme/logs" });
  expect(brandFoldersOf(acme, { home: "/home/a", configDir: "/etc/acme" })).toMatchObject({ config: "/etc/acme", data: "/home/a/.local/share/acme" });
});

test("a --data-dir that is not absolute is refused, as --config-dir is", async () => {
  const refused = await runTest(brandFoldersFor(acme, { dataDir: "data" }).pipe(Effect.flip));
  expect(refused).toMatchObject({ _tag: "ConfigInvalid", file: "--data-dir", problem: "Not an absolute path: data" });
});
