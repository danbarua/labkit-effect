/** `/tools` lists the tools offered to the model with every request: those the session opened with. */

import { Effect } from "effect";
import { immutableToolCatalogOf } from "../../../agent-session/configuration/session-setup.ts";
import { type ReplCommand, said } from "../command.ts";

export const tools: ReplCommand = {
  name: "/tools",
  says: "List the tools the model can use",
  inSession: (session) =>
    Effect.gen(function* () {
      const offered = yield* immutableToolCatalogOf(yield* session.facts);
      return said(offered.length === 0 ? "This session has no tools." : offered.map((tool) => `${tool.name}: ${tool.description}`).join("\n"));
    }),
};
