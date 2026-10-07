/** Scripted Zork players (`src/examples/zork/scripted.ts`) that keep every request they answered, for tests to read. */

import type { Effect } from "effect";
import type { ModelContext } from "../../src/agent-session/contracts.ts";
import { adventurerScript, engineScript, type Reply, scriptedPlayer } from "../../src/examples/zork/scripted.ts";

export { call, say, userWorld } from "../../src/examples/zork/scripted.ts";

/** A scripted player that answers with `reply`; `seen` holds every request it answered, in order. */
export const model = (name: string, reply: Reply, before?: (request: number) => Effect.Effect<void>) => {
  const seen: Array<ModelContext> = [];
  const player = scriptedPlayer(name, (context, request) => {
    seen.push(context);
    return reply(context, request);
  }, before);
  return { player, seen };
};

export const scriptedEngine = (...[select, narrate, fenced, before]: [...Parameters<typeof engineScript>, before?: (request: number) => Effect.Effect<void>]) =>
  model("engine", engineScript(select, narrate, fenced), before);

export const scriptedAdventurer = (choose: Parameters<typeof adventurerScript>[0], before?: (request: number) => Effect.Effect<void>) =>
  model("adventurer", adventurerScript(choose), before);
