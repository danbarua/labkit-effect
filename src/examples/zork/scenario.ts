/** Two independent harness sessions, exchanging game text for at most fifteen commands. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Data, Effect, Layer } from "effect";
import { opening, SystemPrompts } from "../../agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId } from "../../agent-machine/names.ts";
import type { ModelTarget } from "../../agent-machine/observation.ts";
import type { ModelClient } from "../../agent-session/contracts.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { openSession } from "../../agent-session/loop.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { SourcedToolRunner, ToolSources } from "../../agent-session/tool-sources.ts";
import { countingTurnsAfter } from "../../agent-session/turns.ts";
import { adventurerPrompt, enginePrompt, grueEnding, maxTurns } from "./prompt.ts";

export interface Player {
  readonly target: ModelTarget;
  readonly client: Layer.Layer<ModelClient>;
}

export class ZorkResponseFailed extends Data.TaggedError("ZorkResponseFailed")<{ readonly message: string }> {}

export interface Setup {
  readonly engine: Player;
  readonly adventurer: Player;
  /** Defaults to logs/zork/ relative to the working directory. */
  readonly directory?: string;
}

export interface Exchange {
  readonly turn: number;
  readonly adventurer: string;
  readonly engine: string;
}

export interface Played {
  readonly startedAt: string;
  readonly opening: string;
  readonly exchanges: ReadonlyArray<Exchange>;
  /** If the model misses the final-turn instruction, the runner supplies a labelled epilogue. */
  readonly epilogue?: string;
  readonly outcome: "EatenByGrue";
  readonly facts: { readonly engine: ReadonlyArray<Fact>; readonly adventurer: ReadonlyArray<Fact> };
  readonly transcriptPath: string;
}

const participant = (id: string, player: Player, prompt: string) =>
  Effect.gen(function* () {
    const services = Layer.mergeAll(
      ModelFromFacts,
      player.client,
      AgentContextAssembler.pipe(Layer.provide(WholeConversation)),
      countingTurnsAfter(0),
      SourcedToolRunner,
      Layer.succeed(ToolSources, []),
      Layer.succeed(SystemPrompts, [{ system: Effect.succeed([prompt]) }]),
    );
    const context = yield* Layer.build(services);
    const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
    yield* opening(SessionId.make(id), player.target).pipe(
      Effect.flatMap(session.observe),
      Effect.provideContext(context),
    );
    return {
      facts: session.facts,
      ask: (text: string) => Effect.gen(function* () {
        const before = (yield* session.facts).length;
        const ending = yield* session.prompt({ text: InputText.make(text) });
        yield* session.idle;
        if (ending._tag !== "Completed") {
          return yield* new ZorkResponseFailed({ message: `${id}: ${ending._tag}${ending._tag === "Failed" ? `: ${ending.failure}` : ""}` });
        }
        const answer = (yield* session.facts).slice(before).flatMap((fact) =>
          fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
            ? fact.observation.parts.flatMap((part) => part._tag === "Text" ? [part.text] : [])
            : [],
        ).join("\n").trim();
        if (answer === "") return yield* new ZorkResponseFailed({ message: `${id}: empty response` });
        return answer;
      }).pipe(Effect.provideContext(context)),
    };
  });

const eaten = (text: string): boolean => text.trim().split("\n").at(-1)?.trim() === grueEnding;
const quote = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n");

export const transcript = (game: Omit<Played, "facts" | "transcriptPath">, setup: Setup): string => [
  "# Zork", "", `Started: ${game.startedAt}`,
  `Game Engine: ${setup.engine.target.provider}/${setup.engine.target.model}`,
  `Adventurer: ${setup.adventurer.target.provider}/${setup.adventurer.target.model}`,
  `Turns: ${game.exchanges.length}/${maxTurns}`, "Outcome: Eaten by a Grue", "",
  "## Opening — Game Engine", "", quote(game.opening), "",
  ...game.exchanges.flatMap((exchange) => [
    `## Turn ${exchange.turn}`, "", "### Adventurer", "", quote(exchange.adventurer), "",
    "### Game Engine", "", quote(exchange.engine), "",
  ]),
  ...(game.epilogue === undefined ? [] : ["## Round rule — enforced ending", "", quote(game.epilogue), ""]),
].join("\n");

/** A turn is one command and its response; the opening scene does not consume a turn. */
export const play = (setup: Setup) => Effect.gen(function* () {
  const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const id = randomUUID();
  const commands = yield* Effect.tryPromise(() => readFile(new URL("./GAME.md", import.meta.url), "utf8"));
  const engine = yield* participant(`zork-engine-${id}`, setup.engine, enginePrompt(commands));
  const adventurer = yield* participant(`zork-adventurer-${id}`, setup.adventurer, adventurerPrompt(commands));
  const scene = yield* engine.ask("Describe the opening scene. The Adventurer is alive; no command has been played yet.");
  // Even an unexpectedly terminal opening is respected; no command is sent after death.
  const exchanges = yield* Effect.reduce(
    Array.from({ length: maxTurns }, (_, index) => index + 1),
    (): ReadonlyArray<Exchange> => [],
    (previous, turn) => Effect.gen(function* () {
      const currentScene = previous.at(-1)?.engine ?? scene;
      if (eaten(currentScene)) return previous;
      const command = yield* adventurer.ask(currentScene);
      const response = yield* engine.ask(`Turn ${turn}/${maxTurns}${turn === maxTurns ? " — FINAL TURN: the Grue must eat the Adventurer now" : ""}\nAdventurer command:\n${command}`);
      return [...previous, { turn, adventurer: command, engine: response }];
    }),
  );
  const game = {
    startedAt,
    opening: scene,
    exchanges,
    ...(!eaten(exchanges.at(-1)?.engine ?? scene) ? { epilogue: `The last light fails. Something hungry moves in the darkness.\n\n${grueEnding}` } : {}),
    outcome: "EatenByGrue" as const,
  };
  const directory = setup.directory ?? "logs/zork";
  const transcriptPath = join(directory, `${startedAt.replace(/[:.]/g, "-")}-${id}.md`);
  yield* Effect.tryPromise(async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(transcriptPath, transcript(game, setup), { flag: "wx" });
  });
  return {
    ...game,
    facts: { engine: yield* engine.facts, adventurer: yield* adventurer.facts },
    transcriptPath,
  } satisfies Played;
}).pipe(Effect.scoped);
