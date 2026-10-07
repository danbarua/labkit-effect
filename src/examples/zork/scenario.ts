/**
 * Two harness sessions acting on a runner-owned world for at most thirty tool actions. Each is a
 * session as any host runs it (`agent-host/with-session.ts`): saved in the brand's sessions folder,
 * recorded as zork's, with its log in the brand's logs folder and its spans and log lines sent as
 * OTLP when that is set up. The game's machinery is the adventurer's bolt-on: the world's tools, the
 * tools the engine offers each turn, and the feedback that asks for an action. A game is one span,
 * `zork.game`, with both sessions under it, and each log line carries the game's id.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Data, Effect, Layer, Ref, Schema } from "effect";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Brand, logsFolderOf, sessionsFolderOf } from "../../agent-host/brand.ts";
import { type InvalidLevel, warnInvalidLevels } from "../../agent-host/log-level.ts";
import { LogsToFile } from "../../agent-host/logs.ts";
import { SessionServices } from "../../agent-host/services.ts";
import { Headless, withSession } from "../../agent-host/with-session.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, type TurnId } from "../../agent-machine/names.ts";
import { requestsIn } from "../../agent-machine/turn-requests.ts";
import type { ModelTarget } from "../../agent-machine/observation.ts";
import { ContextAssembler, MaxHolds, ModelRequestPolicies, TurnEndHooks, type ModelClient, type ModelContext } from "../../agent-session/contracts.ts";
import { maxTurnRequests } from "../../agent-policy/max-turn-requests.ts";
import type { Session } from "../../agent-session/loop.ts";
import { parseJson, receivedJsonText } from "../../agent-session/received.ts";
import { SourcedToolRunner, type ToolSource } from "../../agent-session/tool-sources.ts";
import { holdsOf } from "../../agent-session/turn-holds.ts";
import type { Customisation } from "./customisations.ts";
import { adventurerPrompt, enginePrompt } from "./prompt.ts";
import { offeredIn, worldTools, type GameState } from "./tools.ts";
import { actionNames, availableTools, grueEnding, initialWorld, maxTurns, view, type Action, type ActionName, type World } from "./world.ts";

export interface Player {
  readonly target: ModelTarget;
  /** The client the player asks; the provider's own, from its key in the environment, when not given (a test gives a scripted one). */
  readonly client?: Layer.Layer<ModelClient>;
}
export interface Adventurer extends Player {
  /** How each request the adventurer is sent is changed for its model (`customisations.ts`); unchanged when not given. */
  readonly customise?: Customisation;
}
/**
 * A game that cannot go on: `message` names the session; `role` is the player that failed and
 * `reason` says how, as a verb phrase after the player's name, without the session's id.
 */
export class ZorkResponseFailed extends Data.TaggedError("ZorkResponseFailed")<{
  readonly message: string;
  readonly role: "Engine" | "Adventurer";
  readonly reason: string;
}> {}
/** What a game reports as it is played (`Setup.watch`). */
export type GameEvent =
  /** The engine's opening scene: its narration, and the tools it offers the first game turn. */
  | { readonly _tag: "Opened"; readonly narration: string; readonly offered: ReadonlyArray<ActionName>; readonly world: World }
  /** The adventurer's action that succeeded in game turn `turn`, from the tools offered, and the world after it. */
  | { readonly _tag: "Acted"; readonly turn: number; readonly offered: ReadonlyArray<ActionName>; readonly action: Action; readonly world: World }
  /** The engine's narration of game turn `turn`, and the tools it offers the next game turn (none after death). */
  | { readonly _tag: "Narrated"; readonly turn: number; readonly narration: string; readonly offered: ReadonlyArray<ActionName> };
export interface Setup {
  readonly engine: Player;
  readonly adventurer: Adventurer;
  /** Where transcripts are written. Defaults to logs/zork/ relative to the working directory. */
  readonly directory?: string;
  /** The home folder under which sessions and logs are kept (`~/.local/share/<brand>/`). Defaults to the user's. */
  readonly home?: string;
  /** Called with the opening, and with each action and its narration as soon as each is played. */
  readonly watch?: (event: GameEvent) => Effect.Effect<void>;
  /** The log-level variables that named no level (`agent-host/log-level.ts`), reported in each session's log once it is open. None when not given. */
  readonly invalidLevels?: ReadonlyArray<InvalidLevel>;
}
export interface Exchange {
  readonly turn: number;
  readonly offered: ReadonlyArray<ActionName>;
  readonly action: Action;
  readonly world: World;
  readonly engine: string;
}
export interface Played {
  readonly startedAt: string;
  readonly opening: string;
  readonly exchanges: ReadonlyArray<Exchange>;
  readonly world: World;
  /** If the narrator misses the death instruction, the runner labels its own ending. */
  readonly epilogue?: string;
  readonly outcome: "EatenByGrue";
  readonly facts: { readonly engine: ReadonlyArray<Fact>; readonly adventurer: ReadonlyArray<Fact> };
  readonly transcriptPath: string;
}

/** The most model requests in a game turn. */
const requestLimit = 4;
/** The most times the turn-end feedback holds a game turn open. */
const holdLimit = 2;

/** Changes a request that the assembler built from `facts` for `turn`. */
type Request = (context: ModelContext, facts: ReadonlyArray<Fact>, turn: TurnId) => Effect.Effect<ModelContext>;

/**
 * The services of a zork session: `SessionServices` with the player's client when it has its own, at
 * most `requestLimit` model requests in a game turn, `holdLimit` turn-end holds with `feedback`, and,
 * when `request` is given, each request as `request` returns it.
 */
const servicesOf = (player: Player, request?: Request, feedback: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([])) => {
  const assembler = Layer.effect(ContextAssembler, Effect.gen(function* () {
    const base = yield* ContextAssembler;
    return { assemble: (facts, turn) => Effect.gen(function* () {
      const context = yield* base.assemble(facts, turn);
      return request === undefined ? context : yield* request(context, facts, turn);
    }) } satisfies ContextAssembler["Service"];
  })).pipe(Layer.provide(AgentContextAssembler.pipe(Layer.provide(WholeConversation))));
  return Layer.mergeAll(
    SessionServices(SourcedToolRunner),
    ...(request === undefined ? [] : [assembler]),
    ...(player.client === undefined ? [] : [player.client]),
    // Bound retries and tool follow-ups within each game turn.
    Layer.succeed(ModelRequestPolicies, [{ name: "zork request limit", policy: (facts) => Effect.succeed(maxTurnRequests(facts, requestLimit)) }]),
    Layer.succeed(MaxHolds, holdLimit),
    Layer.succeed(TurnEndHooks, [() => feedback]),
  );
};

/** One of a game's two sessions, `zork-<role>-<game>`, as `withSession` runs it. `source` is the adventurer's bolt-on, the world's tools. */
const optionsOf = (
  setup: Setup, game: string, role: "engine" | "adventurer", player: Player, prompt: string, brand: Brand,
  source?: ToolSource, request?: Request, feedback?: Effect.Effect<ReadonlyArray<string>>,
) => {
  const sessionId = `zork-${role}-${game}`;
  const home = setup.home ?? homedir();
  return {
    sessionId,
    target: { provider: player.target.provider, model: player.target.model },
    settings: player.target.settings ?? {},
    system: prompt,
    persist: true,
    root: sessionsFolderOf(brand, home),
    record: { host: "zork", game, role, cwd: process.cwd() },
    services: servicesOf(player, request, feedback),
    boltOns: source === undefined ? [] : [{ sources: [source] }],
    logs: LogsToFile(join(logsFolderOf(brand, home), `${sessionId}.log`), "labkit-zork"),
    host: Headless,
  };
};

/** Asks `session` `text`, and returns how the turn ended and the text it answered. */
const asked = (session: Session) => (text: string) => Effect.gen(function* () {
  const before = (yield* session.facts).length;
  const ending = yield* session.prompt({ text: InputText.make(text) });
  yield* session.idle;
  const answer = (yield* session.facts).slice(before).flatMap((fact) =>
    fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
      ? fact.observation.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []) : [],
  ).join("\n").trim();
  return { ending, answer };
});

/** Says how a turn of the session `id` ended, when it did not complete. */
const endedAs = (id: string, ending: Ending): string => `${id}: ${ending._tag}${ending._tag === "Failed" ? `: ${ending.failure}` : ""}`;
/** Says, after a player's name, that its turn did not complete, and how it ended. */
const unfinished = (ending: Ending): string => ending._tag === "Failed" ? `did not finish its turn: ${ending.failure.replace(/\.$/, "")}` : `did not finish its turn (${ending._tag})`;

const Scene = Schema.Struct({ narration: Schema.String, tools: Schema.Array(Schema.Literals(actionNames)) });
const decodeScene = Schema.decodeUnknownResult(Scene, { onExcessProperty: "error" });
const sceneFrom = (text: string, world: World) => Effect.gen(function* () {
  // Providers sometimes fence a JSON answer even when asked for plain JSON.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim());
  const json = parseJson(receivedJsonText(fenced?.[1] ?? text));
  if ("reason" in json) return yield* new ZorkResponseFailed({ message: `Engine must return a JSON scene: ${json.reason}`, role: "Engine", reason: `did not answer with a JSON scene: ${json.reason}` });
  const decoded = decodeScene(json.value);
  if (decoded._tag === "Failure") return yield* new ZorkResponseFailed({ message: decoded.failure.message, role: "Engine", reason: `answered with a scene that does not fit the game: ${decoded.failure.message}` });
  const scene = decoded.success;
  if (scene.narration.trim() === "" || (world.outcome === "Alive" && scene.tools.length === 0) ||
    scene.tools.some((tool) => !availableTools(world).includes(tool)) || new Set(scene.tools).size !== scene.tools.length)
    return yield* new ZorkResponseFailed({
      message: "Engine scene must contain narration and a valid, unique selection of available tools (none after death).",
      role: "Engine",
      reason: "answered without narration or without a valid, unique selection of the available tools",
    });
  return scene;
});
const quote = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n");
export const transcript = (game: Omit<Played, "facts" | "transcriptPath">, setup: Setup): string => [
  "# Zork", "", `Started: ${game.startedAt}`,
  `Game Engine: ${setup.engine.target.provider}/${setup.engine.target.model}`,
  `Adventurer: ${setup.adventurer.target.provider}/${setup.adventurer.target.model}`,
  `Turns: ${game.exchanges.length}/${maxTurns}`, "Outcome: Eaten by a Grue", "",
  "## Opening — Game Engine", "", quote(game.opening), "",
  ...game.exchanges.flatMap((exchange) => [
    `## Turn ${exchange.turn}`, "", `Offered tools: ${exchange.offered.join(", ")}`, "",
    "### Adventurer — tool call", "", quote(`${exchange.action.tool}(${JSON.stringify(exchange.action.input)})`), "",
    "### World — tool result", "", "```json", JSON.stringify(view(exchange.world), null, 2), "```", "",
    "### Game Engine", "", quote(exchange.engine), "",
  ]),
  ...(game.epilogue === undefined ? [] : ["## Round rule — enforced ending", "", quote(game.epilogue), ""]),
].join("\n");

/** One successful Adventurer tool call consumes one game turn; narration consumes none. */
export const play = (setup: Setup) => {
  const id = randomUUID();
  return Effect.gen(function* () {
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const brand = yield* Brand;
    const commands = yield* Effect.tryPromise(() => readFile(new URL("./GAME.md", import.meta.url), "utf8"));
    const state = yield* Ref.make<GameState>({ world: initialWorld(), offered: [], action: undefined });
    const feedback = Ref.get(state).pipe(Effect.map((current) => current.action === undefined
      ? [`No action has succeeded yet. Call exactly one of the offered tools now: ${current.offered.join(", ")}. Use the world snapshot and correct any rejected arguments. Text alone does not act.`]
      : []));
    // Each of the adventurer's requests offers the engine's tools, as the adventurer's customisation changes it.
    // The assembler runs after the request's step is recorded, so `requestsIn` counts this request.
    const customise = setup.adventurer.customise;
    const request: Request = (context, facts, turn) => Ref.get(state).pipe(Effect.map((current) => {
      const offered = { ...context, tools: offeredIn(current) };
      const lastChance = holdsOf(facts, turn) >= holdLimit || requestsIn(facts, turn) >= requestLimit;
      return customise === undefined ? offered : customise({ state: current, context: offered, lastChance });
    }));
    const invalidLevels = setup.invalidLevels ?? [];
    return yield* withSession(optionsOf(setup, id, "engine", setup.engine, enginePrompt(commands), brand), (engineSession) =>
      Effect.andThen(warnInvalidLevels(invalidLevels), withSession(optionsOf(setup, id, "adventurer", setup.adventurer, adventurerPrompt(commands), brand, worldTools(state), request, feedback), (adventurerSession) =>
        Effect.andThen(warnInvalidLevels(invalidLevels), Effect.gen(function* () {
          const engine = asked(engineSession);
          const adventurer = asked(adventurerSession);
          // The engine's turn must complete: its answer is the scene.
          const narrate = (world: World, action?: Action) => engine(JSON.stringify({ world: view(world), action: action ?? null })).pipe(
            Effect.flatMap(({ ending, answer }) => ending._tag === "Completed" ? sceneFrom(answer, world) : Effect.fail(new ZorkResponseFailed({ message: endedAs(`zork-engine-${id}`, ending), role: "Engine", reason: unfinished(ending) }))),
          );
          const watch = setup.watch ?? (() => Effect.void);
          const scene = yield* narrate(initialWorld());
          yield* Ref.update(state, (current) => ({ ...current, offered: scene.tools }));
          yield* watch({ _tag: "Opened", narration: scene.narration, offered: scene.tools, world: initialWorld() });
          const exchanges = yield* Effect.reduce(
            Array.from({ length: maxTurns }, (_, index) => index + 1),
            (): ReadonlyArray<Exchange> => [],
            (previous) => Effect.gen(function* () {
              const before = yield* Ref.get(state);
              if (before.world.outcome !== "Alive") return previous;
              const played = yield* adventurer(JSON.stringify({ narration: previous.at(-1)?.engine ?? scene.narration, world: view(before.world), offeredTools: before.offered }));
              const after = yield* Ref.get(state);
              // An action that succeeded plays the game turn, however the turn ended after it: the reply that follows an action is not needed.
              if (after.action === undefined)
                return yield* new ZorkResponseFailed({
                  message: played.ending._tag === "Completed"
                    ? `Adventurer ended the turn without a successful world tool call (game turn ${before.world.turn + 1}).`
                    : `${endedAs(`zork-adventurer-${id}`, played.ending)}, without a successful world tool call (game turn ${before.world.turn + 1}).`,
                  role: "Adventurer",
                  reason: played.ending._tag === "Completed"
                    ? `ended game turn ${before.world.turn + 1} without an action`
                    : `${unfinished(played.ending)}, without an action in game turn ${before.world.turn + 1}`,
                });
              yield* watch({ _tag: "Acted", turn: after.world.turn, offered: before.offered, action: after.action, world: after.world });
              const next = yield* narrate(after.world, after.action);
              yield* Ref.update(state, (current) => ({ ...current, offered: next.tools, action: undefined }));
              yield* watch({ _tag: "Narrated", turn: after.world.turn, narration: next.narration, offered: next.tools });
              return [...previous, { turn: after.world.turn, offered: before.offered, action: after.action, world: after.world, engine: next.narration }];
            }),
          );
          const world = (yield* Ref.get(state)).world;
          const game = {
            startedAt, opening: scene.narration, exchanges, world,
            ...(!(exchanges.at(-1)?.engine.trim().endsWith(grueEnding) ?? false) ? { epilogue: world.event } : {}),
            outcome: "EatenByGrue" as const,
          };
          const directory = setup.directory ?? "logs/zork";
          const transcriptPath = join(directory, `${startedAt.replace(/[:.]/g, "-")}-${id}.md`);
          yield* Effect.tryPromise(async () => {
            await mkdir(directory, { recursive: true });
            await writeFile(transcriptPath, transcript(game, setup), { flag: "wx" });
          });
          return { ...game, facts: { engine: yield* engineSession.facts, adventurer: yield* adventurerSession.facts }, transcriptPath } satisfies Played;
        })),
      )),
    );
  }).pipe(
    Effect.withSpan("zork.game", { attributes: { game: id, engine: `${setup.engine.target.provider}/${setup.engine.target.model}`, adventurer: `${setup.adventurer.target.provider}/${setup.adventurer.target.model}` } }),
    Effect.annotateLogs({ game: id }),
  );
};
