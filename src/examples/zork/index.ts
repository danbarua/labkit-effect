/**
 * Run one round: `bun run zork [engine-model] [adventurer-model]`, each model named as `players.ts`
 * describes. By default the Engine is claude-sonnet-5-5 and the Adventurer claude-haiku-5-5.
 *
 * A game's two sessions are saved in `~/.local/share/labkit/sessions/` and log to
 * `~/.local/share/labkit/logs/zork-<role>-<game>.log`, at the level `LABKIT_LOG_LEVEL` names, info by
 * default (`agent-host/log-level.ts`); a value that names no level is reported in both logs. With
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set, their spans and log lines are also sent as OTLP, as the service
 * `labkit-zork`.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger, References } from "effect";
import { logLevelOf } from "../../agent-host/log-level.ts";
import { TestName } from "../../agent-machine/names.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { OtlpSpansAndMetrics, otlpLogger } from "../../instrumentation/telemetry.ts";
import { adventurerFor, playerFor, type Unavailable } from "./players.ts";
import { play, type Player } from "./scenario.ts";

/** Returns `found`, or exits saying why there is no player. */
const orExit = <P extends Player>(found: P | Unavailable): P => {
  if (!("_tag" in found)) return found;
  console.error(
    found._tag === "UnknownModel"
      ? `ERROR: Unknown model: ${found.named}.\nHINT: Name a Claude, GPT or Grok model, as provider/model or by its name.`
      : `ERROR: ${found.model} is unavailable: ${found.variable} is not set.\nHINT: Set ${found.variable} to run a Zork round with it.`,
  );
  process.exit(2);
};

const [engineModel = "claude-sonnet-5-5", adventurerModel = "claude-haiku-5-5"] = process.argv.slice(2);
const { level, invalid } = logLevelOf(process.env);
const game = await Effect.runPromise(
  play({ engine: orExit(playerFor(engineModel)), adventurer: orExit(adventurerFor(adventurerModel)), invalidLevels: invalid }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make("zork") }),
    Effect.timeout("10 minutes"),
    // The console shows only the game; each session's log lines go to its log file, and to OTLP when it is set up.
    Effect.provide(Layer.mergeAll(Logger.layer([otlpLogger("labkit-zork")]), Layer.succeed(References.MinimumLogLevel, level), OtlpSpansAndMetrics("labkit-zork"), BunServices.layer)),
  ),
);
console.log(`Eaten by a Grue after ${game.exchanges.length} turns. Transcript: ${game.transcriptPath}`);
