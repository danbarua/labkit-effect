/**
 * The environment variables that a command runs with, as the harness knows them.
 *
 * | Tag | When | Holds |
 * | --- | --- | --- |
 * | `Known` | The harness starts the command's process: `run_command` on the local disk, an MCP server. | The variables the process receives (`variables`), and the names of this process's variables that it does not receive (`leftOut`). |
 * | `Unknown` | Another program starts the process: the editor starts the process of `terminal_command` in its terminal. | Why the harness does not know the variables (`reason`). |
 */

import type { Environment } from "../agent-process/environment.ts";

/** The variables of a process that the harness starts. */
export interface KnownEnvironment {
  readonly _tag: "Known";
  /** The variables that the process receives. */
  readonly variables: Environment;
  /** The names of this process's variables that the process does not receive, sorted. */
  readonly leftOut: ReadonlyArray<string>;
}

/** The variables of a process that another program starts, which the harness does not know. */
export interface UnknownEnvironment {
  readonly _tag: "Unknown";
  /** Why the harness does not know the variables. */
  readonly reason: string;
}

/** The environment variables that a command runs with (the module's table). */
export type CommandEnvironment = KnownEnvironment | UnknownEnvironment;
