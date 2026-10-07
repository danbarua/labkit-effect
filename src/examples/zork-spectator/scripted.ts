/**
 * The Zork spectator with scripted players, which ask no model: `bun run zork:spectator:scripted`,
 * then open http://localhost:3002. Whichever labels are chosen, the engine narrates the world's own
 * event and offers every available tool, and the adventurer plays the same short game: it opens the
 * mailbox, takes the leaflet and the lantern, opens the trapdoor and goes down without light, and is
 * eaten in game turn 7. Each answer takes 1.5 seconds, so the page shows the game arrive turn by turn.
 *
 * Its sessions and transcripts are kept in `logs/zork-spectator/scripted/`, apart from real games.
 * Like the spectator, the server listens on `localhost` only.
 */
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { TestName } from "../../agent-machine/names.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { play } from "../zork/scenario.ts";
import { adventurerScript, engineScript, scriptedPlayer } from "../zork/scripted.ts";
import type { Action } from "../zork/world.ts";
import { makeMatch } from "./match.ts";
import { serve } from "./server.ts";

const port = 3002;
const folder = join("logs", "zork-spectator", "scripted");

/** The adventurer's game, by game turn. */
const plan: ReadonlyArray<Action> = [
  { tool: "open", input: { target: "mailbox" } },
  { tool: "take", input: { target: "leaflet" } },
  { tool: "move", input: { direction: "north" } },
  { tool: "take", input: { target: "lantern" } },
  { tool: "move", input: { direction: "north" } },
  { tool: "open", input: { target: "trapdoor" } },
  { tool: "move", input: { direction: "down" } },
];

const pause = () => Effect.sleep("1500 millis");
const engine = scriptedPlayer("engine", engineScript(), pause);
const adventurer = scriptedPlayer("adventurer", adventurerScript((world) => plan[world.turn] ?? { tool: "look", input: {} }), pause);

const match = await Effect.runPromise(
  makeMatch({ engine: () => engine, adventurer: () => adventurer }, (setup) =>
    play({ ...setup, directory: join(folder, "transcripts"), home: join(folder, "home") }).pipe(
      reportedBy({ _tag: "Test", name: TestName.make("zork-spectator-scripted") }),
      Effect.provide(BunServices.layer),
    ),
  ),
);
const server = serve(match, { hostname: "localhost", port });
console.log(`Zork spectator, scripted: ${server.url.href}`);
