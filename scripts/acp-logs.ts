/**
 * Prints the newest launch's ACP log (`acp-*.jsonl` in `<PREFIX>ACP_LOG_DIR`, `~/.local/share/<brand>/logs`
 * by default; `LABKIT_ACP_LOG_DIR` and `~/.local/share/labkit/logs` for labkit's), a record per line; its path goes
 * to stderr. `--errors` prints only the warning, error
 * and fatal records. Its rotated files (`.jsonl.<n>`) hold older lines and are not printed.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brandFrom, envPrefixOf } from "../src/agent-host/brand.ts";
import { brandFoldersOf } from "../src/agent-host/brand-folders.ts";
import { launcherLogOptionsFrom } from "../src/agent-host/launcher-logs.ts";

const brand = brandFrom(process.env);
const { dir } = launcherLogOptionsFrom(process.env, brandFoldersOf(brand, { dataDir: process.env[`${envPrefixOf(brand)}ACP_DATA_DIR`] || undefined }).logs, brand);
const errorsOnly = process.argv.includes("--errors");
const notable = new Set(["warning", "error", "fatal"]);

/** A line's level, or undefined for a line that does not parse: such a line is printed, not known to be routine. */
const levelOf = (line: string): unknown => {
  try {
    const record: unknown = JSON.parse(line);
    return typeof record === "object" && record !== null && "level" in record ? record.level : undefined;
  } catch {
    return undefined;
  }
};

const newest = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((name) => /^acp-.*\.jsonl$/.test(name))
  .map((name) => ({ path: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.time - a.time)[0];

if (newest === undefined) {
  console.error(`No ACP launch logs in ${dir}`);
  process.exitCode = 1;
} else {
  console.error(`ACP log: ${newest.path}`);
  for (const line of readFileSync(newest.path, "utf8").split("\n")) {
    if (line === "") continue;
    const level = errorsOnly ? levelOf(line) : undefined;
    if (typeof level === "string" && !notable.has(level)) continue;
    console.log(line);
  }
}
