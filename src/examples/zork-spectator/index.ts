/**
 * The Zork spectator: `bun run zork:spectator`, then open http://localhost:3001 on a phone-sized
 * screen. The page begins a game with the Engine and Adventurer chosen, or shows the game that is
 * running (`match.ts`). The server listens on `localhost` only, so only this machine can begin a game.
 *
 * Each model is asked as `zork/players.ts` describes, with its provider's key from the environment;
 * a model whose key is not set is refused when the game begins. Each game is played as `bun run zork`
 * plays one, with the same sessions, logs, transcripts, spans, log level and ten-minute limit.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, References } from "effect";
import { logLevelOf } from "../../agent-host/log-level.ts";
import { TestName } from "../../agent-machine/names.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { OtlpSpansAndMetrics, otlpLogger } from "../../instrumentation/telemetry.ts";
import { adventurerFor, playerFor } from "../zork/players.ts";
import { play } from "../zork/scenario.ts";
import { makeMatch, modelOf, type Players } from "./match.ts";
import { serve } from "./server.ts";

const port = 3001;

const players: Players = {
  engine: (label) => playerFor(modelOf[label]),
  adventurer: (label) => adventurerFor(modelOf[label]),
};

const { level, invalid } = logLevelOf(process.env);

const match = await Effect.runPromise(
  makeMatch(players, (setup) =>
    play({ ...setup, invalidLevels: invalid }).pipe(
      reportedBy({ _tag: "Test", name: TestName.make("zork") }),
      Effect.timeout("10 minutes"),
      // Each session's log lines go to its log file, and to OTLP when it is set up.
      Effect.provide(Layer.mergeAll(Logger.layer([otlpLogger("labkit-zork")]), Layer.succeed(References.MinimumLogLevel, level), OtlpSpansAndMetrics("labkit-zork"), BunServices.layer)),
    ),
  ),
);
const server = serve(match, { hostname: "localhost", port });
console.log(`Zork spectator: ${server.url.href}`);
