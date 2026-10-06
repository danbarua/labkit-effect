/**
 * `/mcp` says how the session's MCP servers are; `/mcp reconnect <server>` starts one again, as the
 * ACP host's `/mcp` does (`agent-mcp` `command.ts`).
 */

import { Effect } from "effect";
import { mcpCommand } from "../../../agent-mcp/command.ts";
import { immutableToolCatalogOf } from "../../../agent-session/configuration/session-setup.ts";
import { type ReplCommand, said } from "../command.ts";

export const mcp: ReplCommand = {
  name: "/mcp",
  args: "[reconnect <server>]",
  says: "Say how the MCP servers are; start one again",
  // `reconnect`, then a server's name.
  complete: (words, from) => {
    if (words.length === 2) return ["reconnect "];
    return words.length === 3 && words[1] === "reconnect" ? from.servers : [];
  },
  inSession: (session, words, { mcp: servers }) =>
    Effect.gen(function* () {
      if (servers === undefined) return said("This session has no MCP servers.");
      const tools = yield* immutableToolCatalogOf(yield* session.facts);
      return said(yield* mcpCommand(servers, words, tools.map((tool) => tool.name)));
    }),
};
