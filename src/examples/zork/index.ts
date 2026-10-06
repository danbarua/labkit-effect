/**
 * Run one round: `bun run zork [engine-model] [adventurer-model]`. A model is named as
 * `provider/model`, or by its name alone: a well-known model's provider, or `anthropic` for a name
 * that starts with `claude-`, `openai` for one that starts with `gpt-` and `xai` for one that starts
 * with `grok-`. Each player is asked as the CLI asks a model, with its provider's key from the
 * provider's variable (`agent-host/catalog.ts`): `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY`
 * for GPT, `XAI_API_KEY` for Grok. By default the Engine is
 * claude-sonnet-5-5 and the Adventurer claude-haiku-4-5. An Adventurer whose model has a
 * customisation (`customisations.ts`) plays with it.
 *
 * A game's two sessions are saved in `~/.local/share/labkit/sessions/` and log to
 * `~/.local/share/labkit/logs/zork-<role>-<game>.log`; with `OTEL_EXPORTER_OTLP_ENDPOINT` set, their
 * spans and log lines are also sent as OTLP, as the service `labkit-zork`.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Logger } from "effect";
import { known, keyVariables } from "../../agent-host/catalog.ts";
import { ModelName, ProviderName, TestName, TokenCount } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { OtlpSpansAndMetrics, otlpLogger } from "../../instrumentation/telemetry.ts";
import { adventurerCustomisations } from "./customisations.ts";
import { play, type Adventurer, type Player } from "./scenario.ts";

/**
 * The settings each provider's players ask with: short responses, and as little thinking as the
 * model allows. A Claude or GPT model that can turn its thinking off (Haiku 4.5, gpt-6-luna) does;
 * one that cannot (Sonnet 5.5, gpt-6.1-sol, whose adapters record that `disabled` was not sent)
 * thinks at low effort, within an output limit that leaves room for it. Grok's models cannot turn
 * their reasoning off, so no thinking setting is given; xAI does not count the reasoning against the
 * output limit.
 */
const settingsOf: Readonly<Record<string, ModelSettings>> = {
  anthropic: { thinking: "disabled", effort: "low", maxOutputTokens: TokenCount.make(4096) },
  openai: { thinking: "disabled", effort: "low", maxOutputTokens: TokenCount.make(4096) },
  xai: { maxOutputTokens: TokenCount.make(1024) },
};

/** The provider of a model that is not well-known, by the start of its name. */
const namePrefixes: Readonly<Record<string, string>> = { "claude-": "anthropic", "gpt-": "openai", "grok-": "xai" };

/** The provider of `named`, and the model's name: as `provider/model`, a well-known model's, or by the name's start. */
const providerOf = (named: string): { readonly provider: string | undefined; readonly model: string } => {
  const slash = named.indexOf("/");
  if (slash > 0) return { provider: named.slice(0, slash), model: named.slice(slash + 1) };
  const wellKnown = Object.keys(settingsOf).find((each) => named in (known[each] ?? {}));
  const byName = Object.entries(namePrefixes).find(([prefix]) => named.startsWith(prefix))?.[1];
  return { provider: wellKnown ?? byName, model: named };
};

/** Returns the player for `named`, or exits saying why there is none. */
const playerFor = (named: string): Player => {
  const { provider, model } = providerOf(named);
  const settings = provider === undefined ? undefined : settingsOf[provider];
  const variable = provider === undefined ? undefined : keyVariables[provider];
  if (provider === undefined || settings === undefined || variable === undefined) {
    console.error(`ERROR: Unknown model: ${named}.\nHINT: Name a Claude, GPT or Grok model, as provider/model or by its name.`);
    process.exit(2);
  }
  if ((process.env[variable] ?? "").trim() === "") {
    console.error(`ERROR: ${model} is unavailable: ${variable} is not set.\nHINT: Set ${variable} to run a Zork round with it.`);
    process.exit(2);
  }
  return { target: { provider: ProviderName.make(provider), model: ModelName.make(model), settings } };
};

/** The adventurer for `named`: its player, with the customisation for its model when there is one. */
const adventurerFor = (named: string): Adventurer => {
  const player = playerFor(named);
  const customise = adventurerCustomisations[`${player.target.provider}/${player.target.model}`];
  return customise === undefined ? player : { ...player, customise };
};

const [engineModel = "claude-sonnet-5-5", adventurerModel = "claude-haiku-4-5"] = process.argv.slice(2);
const game = await Effect.runPromise(
  play({ engine: playerFor(engineModel), adventurer: adventurerFor(adventurerModel) }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make("zork") }),
    Effect.timeout("10 minutes"),
    // The console shows only the game; each session's log lines go to its log file, and to OTLP when it is set up.
    Effect.provide(Layer.mergeAll(Logger.layer([otlpLogger("labkit-zork")]), OtlpSpansAndMetrics("labkit-zork"), BunServices.layer)),
  ),
);
console.log(`Eaten by a Grue after ${game.exchanges.length} turns. Transcript: ${game.transcriptPath}`);
