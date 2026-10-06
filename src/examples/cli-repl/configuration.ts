/**
 * The CLI's configuration: the layers both hosts build from their options (`agent-host/launch.ts`),
 * over the CLI's defaults: the loop breaker then permission on tool calls; the loop breaker on model
 * requests; one more request for an answer when a turn ends with thinking and no answer; and the
 * environment without credentials for the model's commands.
 */

import type { Effect, FileSystem } from "effect";
import type { ConfigInvalid, Configuration, LayerSource } from "../../agent-config/file.ts";
import { type ConfigFlags, launchConfiguration } from "../../agent-host/launch.ts";

/** The CLI's defaults: the first layer. */
export const cliDefaults: LayerSource = {
  name: "the CLI's defaults",
  trusted: true,
  value: { toolCalls: ["loopBreaker", "permissions"], modelRequests: ["loopBreaker"], turnEnd: ["retryIncomplete"], maxHolds: 1, commandEnvironment: ["credentials"] },
};

/** Returns the configuration for a CLI run in `project`, and the layers it was built from. */
export const cliConfiguration = (
  project: string,
  flags: ConfigFlags,
  options: { readonly home?: string; readonly name?: string } = {},
): Effect.Effect<Configuration & { readonly layers: ReadonlyArray<LayerSource> }, ConfigInvalid, FileSystem.FileSystem> =>
  launchConfiguration(project, cliDefaults, flags, options);
