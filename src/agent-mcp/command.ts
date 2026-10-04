/**
 * The `/mcp` command a host answers without the model: alone, how each of the session's MCP servers
 * is; `/mcp reconnect <server>`, the server started again, how it went, and whether its tools are
 * offered in the session (a session's tools are fixed when it opens: a server that offered none
 * then offers none in it).
 */

import { Effect } from "effect";
import { logKeys } from "./log-keys.ts";
import { describe } from "./server-machine.ts";
import type { McpServers } from "./servers.ts";
import { namespaceOf } from "./source.ts";

/** What `/mcp <words>` says, for a session whose servers are `mcp` and whose tools are named `offered`. */
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
