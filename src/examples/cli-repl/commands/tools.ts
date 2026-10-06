/**
 * `/tools` prints the tools that every model request offers: for each tool the session opened with,
 * its name, its description and its input schema, as the request sends them. The context assemblers
 * read the same catalog (`immutableToolCatalogOf`), and the provider adapters send these three fields
 * unchanged; only the name of the schema's field differs by provider (`input_schema`, `parameters`).
 */

import { Effect } from "effect";
import type { ToolSpec } from "../../../agent-session/contracts.ts";
import { immutableToolCatalogOf } from "../../../agent-session/configuration/session-setup.ts";
import { type ReplCommand, said } from "../command.ts";

/** Returns `tool` as `/tools` prints it: its name, its description, and its input schema as indented JSON, each on its own lines. */
export const shown = (tool: ToolSpec): string => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.input, null, 2)}`;

export const tools: ReplCommand = {
  name: "/tools",
  says: "Show each tool as the model is sent it: name, description, input schema",
  inSession: (session) =>
    Effect.gen(function* () {
      const offered = yield* immutableToolCatalogOf(yield* session.facts);
      return said(offered.length === 0 ? "This session has no tools." : offered.map(shown).join("\n\n"));
    }),
};
