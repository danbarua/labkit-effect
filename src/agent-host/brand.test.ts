/** The brand: its prefix and folder, which one a program runs as, and the names that follow it. */

import { expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "../../tests/support/test.ts";
import { brandFrom, brandVariable, defaultBrand, envPrefixOf, folderOf } from "./brand.ts";
import { brandFoldersOf } from "./brand-folders.ts";
import { launcherLogOptionsFrom } from "./launcher-logs.ts";

test("a brand's prefix is its name in capitals, every other character _, then _; its folder is .<name>", () => {
  expect(envPrefixOf(defaultBrand)).toBe("LABKIT_");
  expect(envPrefixOf({ name: "whitelabel-agent", version: "1.0.0" })).toBe("WHITELABEL_AGENT_");
  expect(envPrefixOf({ name: "acme.ai 2", version: "1.0.0" })).toBe("ACME_AI_2_");
  expect(folderOf({ name: "acme", version: "1.0.0" })).toBe(".acme");
});

test("the brand is the one LABKIT_BRAND names, else labkit; blank names none", () => {
  expect(brandVariable).toBe("LABKIT_BRAND");
  expect(brandFrom({})).toEqual(defaultBrand);
  expect(brandFrom({ LABKIT_BRAND: "  " })).toEqual(defaultBrand);
  expect(brandFrom({ LABKIT_BRAND: "acme" })).toEqual({ name: "acme", version: defaultBrand.version });
  // The meta variable is the default brand's, whatever brand it names.
  expect(brandFrom({ ACME_BRAND: "other" })).toEqual(defaultBrand);
});

test("the launcher's logs follow the brand: its variables, and its logs folder; another brand's variables are not read", () => {
  const acme = { name: "acme", version: "1.0.0" };
  const logs = brandFoldersOf(acme).logs;
  expect(launcherLogOptionsFrom({}, logs, acme).dir).toBe(join(homedir(), ".local", "share", "acme", "logs"));
  expect(launcherLogOptionsFrom({ ACME_ACP_LOG_DIR: "/tmp/acme", LABKIT_ACP_LOG_DIR: "/tmp/labkit" }, logs, acme).dir).toBe("/tmp/acme");
  expect(launcherLogOptionsFrom({ ACME_ACP_LOG_LEVEL: "info", LABKIT_ACP_LOG_LEVEL: "error" }, logs, acme).level).toBe("Info");
  // Named by the meta variable, without being given.
  expect(launcherLogOptionsFrom({ LABKIT_BRAND: "acme", ACME_ACP_LOG_DIR: "/tmp/acme" }, logs).dir).toBe("/tmp/acme");
});
