/**
 * The one Zork game that the spectator's process runs. The process owns the game: a page that
 * begins a game, or connects while one is running, is sent its state from the start, and each change
 * as it happens, until the game is over. Then the state returns to setup, and the next Begin starts
 * a new game.
 *
 * What a page is sent of a game is what it shows: the engine's narrations, the tools offered each
 * game turn and the adventurer's call, and a status from the world (its turn, the room's name, and
 * whether the adventurer is alive). The world itself is not sent, nor the runner's epilogue.
 */
import { Cause, Effect, Exit, Stream, SubscriptionRef } from "effect";
import type { Unavailable } from "../zork/players.ts";
import type { Adventurer, GameEvent, Played, Player, Setup } from "../zork/scenario.ts";
import { ZorkResponseFailed } from "../zork/scenario.ts";
import { initialWorld, maxTurns, view, type Action, type ActionName, type World } from "../zork/world.ts";
import { logKeys } from "./log-keys.ts";

/** The models a person can choose, by the names the page shows. */
export const labels = ["Sonnet", "Haiku", "Grok", "Grok Build", "GPT Sol", "GPT Luna"] as const;
export type Label = (typeof labels)[number];

/** The model each label names, as `zork/players.ts` names it. */
export const modelOf: Readonly<Record<Label, string>> = {
  Sonnet: "claude-sonnet-5-5",
  Haiku: "claude-haiku-5-5",
  Grok: "grok-4.7",
  "Grok Build": "grok-build-0.1",
  "GPT Sol": "gpt-6.1-sol",
  "GPT Luna": "gpt-6-luna",
};

const isLabel = (value: unknown): value is Label => labels.some((label) => label === value);

/** The status line, from the world: the game turn of `of`, the room's name, and the adventurer's outcome. */
export interface Status {
  readonly turn: number;
  readonly of: number;
  readonly location: string;
  readonly outcome: World["outcome"];
}

const statusOf = (world: World): Status => ({ turn: world.turn, of: maxTurns, location: view(world).description, outcome: world.outcome });

/** What a page shows of a game, in the order it happened. A game ends with `Ended` (the world's outcome) or `Failed`. */
export type Shown =
  | { readonly _tag: "Opened"; readonly narration: string; readonly offered: ReadonlyArray<ActionName> }
  | { readonly _tag: "Acted"; readonly turn: number; readonly call: string }
  | { readonly _tag: "Narrated"; readonly turn: number; readonly narration: string; readonly offered: ReadonlyArray<ActionName> }
  | { readonly _tag: "Ended" }
  | { readonly _tag: "Failed"; readonly error: string };

/** The state a page is sent: no game, so choose one from `choices`; or the game running, with what it has shown so far. */
export type MatchState =
  | { readonly _tag: "Setup"; readonly choices: ReadonlyArray<Label> }
  | { readonly _tag: "Playing"; readonly engine: Label; readonly adventurer: Label; readonly status: Status; readonly shown: ReadonlyArray<Shown> };

/** How a Begin went: the game started; one was already running, which the page then shows; or it was refused, with why. */
export type Begun =
  | { readonly _tag: "Started" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Refused"; readonly error: string; readonly hint: string };

/** How the game's players are made from the labels chosen. */
export interface Players {
  readonly engine: (label: Label) => Player | Unavailable;
  readonly adventurer: (label: Label) => Adventurer | Unavailable;
}

export interface Match {
  /** The current state, then each change to it. */
  readonly states: Stream.Stream<MatchState>;
  /** Begins a game with the labels chosen, unless one is running. */
  readonly begin: (engine: unknown, adventurer: unknown) => Effect.Effect<Begun>;
}

/** The tool call as the page shows it: the tool's name and its input. */
const callOf = (action: Action): string => `${action.tool}(${JSON.stringify(action.input)})`;

/** Says why `label`'s model has no player, for the page. */
const refusalOf = (label: Label, unavailable: Unavailable): Begun =>
  unavailable._tag === "KeyNotSet"
    ? { _tag: "Refused", error: `ERROR: ${label} is unavailable: ${unavailable.variable} is not set.`, hint: `HINT: Set ${unavailable.variable} and start the spectator again.` }
    : { _tag: "Refused", error: `ERROR: ${label} is not a model the spectator knows.`, hint: "HINT: Choose another model." };

/** The `Failed` line for a game that ended in `cause`, naming the player that failed by its role and label. */
const errorOf = <E>(cause: Cause.Cause<E>, engine: Label, adventurer: Label): string => {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "Some" && error.value instanceof ZorkResponseFailed)
    return `ERROR: The ${error.value.role} (${error.value.role === "Engine" ? engine : adventurer}) ${error.value.reason}.`;
  if (error._tag === "Some" && Cause.isTimeoutError(error.value)) return "ERROR: The game took longer than its time limit.";
  if (Cause.hasInterruptsOnly(cause)) return "ERROR: The game was stopped.";
  const squashed = Cause.squash(cause);
  return `ERROR: The game stopped: ${(squashed instanceof Error ? squashed.message : String(squashed)).replace(/\.$/, "")}.`;
};

/**
 * Makes the process's match. `run` plays a game from a setup (`zork/scenario.ts`'s `play`, with
 * what the process provides it); the match gives the setup its players and its `watch`.
 */
export const makeMatch = <E>(players: Players, run: (setup: Setup) => Effect.Effect<Played, E>): Effect.Effect<Match> =>
  Effect.gen(function* () {
    const setupState: MatchState = { _tag: "Setup", choices: labels };
    const state = yield* SubscriptionRef.make<MatchState>(setupState);
    /** Adds `shown` to the running game, with the status when it changed. */
    const show = (shown: Shown, status?: Status) =>
      SubscriptionRef.update(state, (current) =>
        current._tag === "Playing" ? { ...current, shown: [...current.shown, shown], ...(status === undefined ? {} : { status }) } : current,
      );
    const watch = (event: GameEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "Opened":
          return show({ _tag: "Opened", narration: event.narration, offered: event.offered }, statusOf(event.world));
        case "Acted":
          return show({ _tag: "Acted", turn: event.turn, call: callOf(event.action) }, statusOf(event.world));
        case "Narrated":
          return show({ _tag: "Narrated", turn: event.turn, narration: event.narration, offered: event.offered });
      }
    };
    /** Plays the game, and, however it ends, shows its end and returns the state to setup. */
    const game = (engine: Label, adventurer: Label, setup: Setup) =>
      run(setup).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit)) yield* show({ _tag: "Ended" }, statusOf(exit.value.world));
            else {
              const error = errorOf(exit.cause, engine, adventurer);
              yield* Effect.logError(logKeys.game.failed, { engine, adventurer, error, cause: Cause.pretty(exit.cause) });
              yield* show({ _tag: "Failed", error });
            }
            yield* SubscriptionRef.set(state, setupState);
          }),
        ),
        Effect.exit,
      );
    return {
      states: SubscriptionRef.changes(state),
      begin: (engine, adventurer) =>
        Effect.gen(function* () {
          if (!isLabel(engine) || !isLabel(adventurer)) return { _tag: "Refused", error: "ERROR: Choose an Engine and an Adventurer.", hint: "HINT: Choose both from the lists." } satisfies Begun;
          const enginePlayer = players.engine(engine);
          if ("_tag" in enginePlayer) return refusalOf(engine, enginePlayer);
          const adventurerPlayer = players.adventurer(adventurer);
          if ("_tag" in adventurerPlayer) return refusalOf(adventurer, adventurerPlayer);
          // Only one Begin takes the setup state; any other finds the game running.
          const started = yield* SubscriptionRef.modify(state, (current): readonly [boolean, MatchState] =>
            current._tag === "Setup" ? [true, { _tag: "Playing", engine, adventurer, status: statusOf(initialWorld()), shown: [] }] : [false, current],
          );
          if (!started) return { _tag: "Running" } satisfies Begun;
          // The game outlives the request that began it.
          yield* Effect.forkDetach(game(engine, adventurer, { engine: enginePlayer, adventurer: adventurerPlayer, watch }));
          return { _tag: "Started" } satisfies Begun;
        }),
    };
  });
