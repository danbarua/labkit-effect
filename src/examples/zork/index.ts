/**
 * Run one round: `bun run zork [engine-model] [adventurer-model]`. A model is named as
 * `provider/model`, or by its name alone: a well-known model's provider, or `anthropic` for a name
 * that starts with `claude-` and `xai` for one that starts with `grok-`. Its provider's key is read
 * from its variable: `LABKIT_ANTHROPIC_API_KEY` for Claude, `LABKIT_XAI_API_KEY` for Grok. By default
 * the Engine is claude-sonnet-4-5 and the Adventurer claude-haiku-4-5.
 */
import { Effect, Logger, Redacted } from "effect";
import { TestName } from "../../agent-machine/names.ts";
import { known } from "../../agent-host/catalog.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { anthropicPlayer } from "./anthropic.ts";
import type { Player } from "./scenario.ts";
import { play } from "./scenario.ts";
import { xaiPlayer } from "./xai.ts";

/** Each provider a player can ask, with the variable that holds its key. */
const players: Readonly<Record<string, { readonly variable: string; readonly player: (key: Redacted.Redacted<string>) => (model: string) => Player }>> = {
  anthropic: { variable: "LABKIT_ANTHROPIC_API_KEY", player: anthropicPlayer },
  xai: { variable: "LABKIT_XAI_API_KEY", player: xaiPlayer },
};

/** The provider of a model that is not well-known, by the start of its name. */
const namePrefixes: Readonly<Record<string, string>> = { "claude-": "anthropic", "grok-": "xai" };

/** The provider of `named`, and the model's name: as `provider/model`, a well-known model's, or by the name's start. */
const providerOf = (named: string): { readonly provider: string | undefined; readonly model: string } => {
  const slash = named.indexOf("/");
  if (slash > 0) return { provider: named.slice(0, slash), model: named.slice(slash + 1) };
  const wellKnown = Object.keys(players).find((each) => named in (known[each] ?? {}));
  const byName = Object.entries(namePrefixes).find(([prefix]) => named.startsWith(prefix))?.[1];
  return { provider: wellKnown ?? byName, model: named };
};

/** Returns the player for `named`, or exits saying why there is none. */
const playerFor = (named: string): Player => {
  const { provider, model } = providerOf(named);
  const found = provider === undefined ? undefined : players[provider];
  if (found === undefined) {
    console.error(`ERROR: Unknown model: ${named}.\nHINT: Name a Claude or Grok model, as provider/model or by its name.`);
    process.exit(2);
  }
  const key = process.env[found.variable];
  if (key === undefined || key.trim() === "") {
    console.error(`ERROR: ${model} is unavailable: ${found.variable} is not set.\nHINT: Set ${found.variable} to run a Zork round with it.`);
    process.exit(2);
  }
  return found.player(Redacted.make(key))(model);
};

const [engineModel = "claude-sonnet-4-5", adventurerModel = "claude-haiku-4-5"] = process.argv.slice(2);
const game = await Effect.runPromise(
  play({ engine: playerFor(engineModel), adventurer: playerFor(adventurerModel) }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make("zork") }),
    Effect.timeout("10 minutes"),
    Effect.provide(Logger.layer([])),
  ),
);
console.log(`Eaten by a Grue after ${game.exchanges.length} turns. Transcript: ${game.transcriptPath}`);
