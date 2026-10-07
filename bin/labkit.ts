#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * The agent's command, `labkit`: the CLI, started in the folder it is run in, reading that folder's
 * `.env` files and project settings only when the folder is trusted (`src/examples/cli-repl/launcher.ts`).
 * `bun link` in this checkout puts it on the PATH.
 *
 * Bun runs this file without the folder's `.env` files and `bunfig.toml`, which it would otherwise
 * read before any of the agent's code runs.
 */

import { launch } from "../src/examples/cli-repl/launcher.ts";

await launch();
