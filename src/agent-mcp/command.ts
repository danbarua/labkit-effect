/**
 * The `/mcp` command, which a host answers without the model:
 * - `/mcp` returns each of the session's MCP servers with its state.
 * - `/mcp reconnect <server>` starts the server again, and returns its state and whether its tools
 *   are offered in the session. A session's tools are fixed when it opens, so a server that offered
 *   no tools then offers none in that session.
 */

import { Effect } from "effect";
import { logKeys } from "./log-keys.ts";
import { describe } from "./server-machine.ts";
import type { McpServers } from "./servers.ts";
import { namespaceOf } from "./source.ts";

/** Returns the answer to `/mcp <words>`, for a session whose servers are `mcp` and whose tools are named `offered`. */
export const mcpCommand = (mcp: McpServers, words: ReadonlyArray<string>, offered: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (words[0] === "reconnect" && words[1] !== undefined) {
      const name = words.slice(1).join(" ");
      const state = yield* mcp.reconnect(name);
      yield* Effect.logInfo(logKeys.server.reconnected, { server: name, state: state === undefined ? "no such server" : state._tag });
      if (state === undefined) return `No MCP server of this session is named ${name}.`;
      const has = offered.some((tool) => tool.startsWith(`${namespaceOf(name)}__`));
      return `${name}: ${describe(state)}. ${has ? "Its tools are the ones it offered when this session started." : "It offered no tools when this session started, so none of its tools can be called in it."}`;
    }
    const states = yield* mcp.states;
    return states.length === 0 ? "This session has no MCP servers." : states.map(({ name, state }) => `${name}: ${describe(state)}`).join("\n");
  });
