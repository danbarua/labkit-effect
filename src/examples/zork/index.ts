/** Run one round: bun run zork [engine-model] [adventurer-model]. */
import { Effect, Logger, Redacted } from "effect";
import { TestName } from "../../agent-machine/names.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { anthropicSetup } from "./anthropic.ts";
import { play } from "./scenario.ts";

const key = process.env["LABKIT_ANTHROPIC_API_KEY"];
if (key === undefined || key.trim() === "") {
  console.error("Set LABKIT_ANTHROPIC_API_KEY to run a Zork round.");
  process.exit(2);
}

const [engineModel, adventurerModel] = process.argv.slice(2);
const game = await Effect.runPromise(
  play(anthropicSetup(Redacted.make(key), engineModel, adventurerModel)).pipe(
    reportedBy({ _tag: "Test", name: TestName.make("zork") }),
    Effect.timeout("10 minutes"),
    Effect.provide(Logger.layer([])),
  ),
);
console.log(`Eaten by a Grue after ${game.exchanges.length} turns. Transcript: ${game.transcriptPath}`);
