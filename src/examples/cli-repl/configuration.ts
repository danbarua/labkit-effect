/**
 * The CLI's configuration: the layers both hosts make from their options (`agent-host/launch.ts`),
 * over the CLI's own defaults: the loop breaker, then permission, on tool calls; the loop breaker on
 * model requests; a turn with thinking and no answer asked once more for it; the model's commands
 * given the environment without its credentials.
 */

import type { Effect, FileSystem } from "effect";
import type { ConfigInvalid, Configuration, LayerSource } from "../../agent-config/file.ts";
import { type ConfigFlags, launchConfiguration } from "../../agent-host/launch.ts";

/** The CLI's own defaults: the first layer. */
export const cliDefaults: LayerSource = {
  name: "the CLI's defaults",
  trusted: true,
  value: { toolCalls: ["loopBreaker", "permissions"], modelRequests: ["loopBreaker"], turnEnd: ["retryIncomplete"], maxHolds: 1, commandEnvironment: ["credentials"] },
};

/** The CLI's configuration, for a CLI run in `project`, and the layers it was made from. */
export const cliConfiguration = (
  project: string,
  flags: ConfigFlags,
  options: { readonly home?: string; readonly name?: string } = {},
): Effect.Effect<Configuration & { readonly layers: ReadonlyArray<LayerSource> }, ConfigInvalid, FileSystem.FileSystem> =>
  launchConfiguration(project, cliDefaults, flags, options);
