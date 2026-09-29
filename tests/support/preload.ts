/** Loaded once before a test run (see `bunfig.toml`): empties the test log, so it holds this run only. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { testLogPath } from "./run.ts";

mkdirSync(dirname(testLogPath), { recursive: true });
writeFileSync(testLogPath, "");
