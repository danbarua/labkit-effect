/** Two harness sessions acting on a runner-owned world for at most thirty tool actions. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Data, Effect, Layer, Ref, Schema } from "effect";
import { opening, SystemPrompts } from "../../agent-context/assemble.ts";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId } from "../../agent-machine/names.ts";
import type { ModelTarget } from "../../agent-machine/observation.ts";
import { ContextAssembler, MaxHolds, ModelRequestPolicies, TurnEndHooks, type ModelClient, type ToolSpec } from "../../agent-session/contracts.ts";
import { maxTurnRequests } from "../../agent-policy/max-turn-requests.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { openSession } from "../../agent-session/loop.ts";
import { parseJson, receivedJsonText } from "../../agent-session/received.ts";
import { EphemeralSessionStore } from "../../agent-session/session-store.ts";
import { SourcedToolRunner, ToolSources, type ToolSource } from "../../agent-session/tool-sources.ts";
import { countingTurnsAfter } from "../../agent-session/turns.ts";
import { adventurerPrompt, enginePrompt } from "./prompt.ts";
import { offeredTools, worldTools, type GameState } from "./tools.ts";
import { actionNames, availableTools, grueEnding, initialWorld, maxTurns, view, type Action, type ActionName, type World } from "./world.ts";

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

const participant = (
  id: string, player: Player, prompt: string, source?: ToolSource,
  offered?: Effect.Effect<ReadonlyArray<ToolSpec>>, feedback: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([]),
) =>
  Effect.gen(function* () {
    const assembler = Layer.effect(ContextAssembler, Effect.gen(function* () {
      const base = yield* ContextAssembler;
      return { assemble: (facts, turn) => Effect.gen(function* () {
        const context = yield* base.assemble(facts, turn);
        return offered === undefined ? context : { ...context, tools: yield* offered };
      }) } satisfies ContextAssembler["Service"];
    })).pipe(Layer.provide(AgentContextAssembler.pipe(Layer.provide(WholeConversation))));
    const services = Layer.mergeAll(
      ModelFromFacts, player.client, assembler, countingTurnsAfter(0), SourcedToolRunner,
      // Bound retries and tool follow-ups within each game turn.
      Layer.succeed(ModelRequestPolicies, [{ name: "zork request limit", policy: (facts) => Effect.succeed(maxTurnRequests(facts, 4)) }]),
      Layer.succeed(MaxHolds, 2),
      Layer.succeed(TurnEndHooks, [() => feedback]),
      Layer.succeed(SystemPrompts, [{ system: Effect.succeed([prompt]) }]),
    ).pipe(Layer.provideMerge(Layer.succeed(ToolSources, source === undefined ? [] : [source])));
    const context = yield* Layer.build(services);
    const session = yield* openSession.pipe(Effect.provide(EphemeralSessionStore));
    yield* opening(SessionId.make(id), player.target).pipe(Effect.flatMap(session.observe), Effect.provideContext(context));
    return {
      facts: session.facts,
      ask: (text: string) => Effect.gen(function* () {
        const before = (yield* session.facts).length;
        const ending = yield* session.prompt({ text: InputText.make(text) });
        yield* session.idle;
        if (ending._tag !== "Completed") return yield* new ZorkResponseFailed({
          message: `${id}: ${ending._tag}${ending._tag === "Failed" ? `: ${ending.failure}` : ""}`,
        });
        return (yield* session.facts).slice(before).flatMap((fact) =>
          fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
            ? fact.observation.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []) : [],
        ).join("\n").trim();
      }).pipe(Effect.provideContext(context)),
    };
  });

const Scene = Schema.Struct({ narration: Schema.String, tools: Schema.Array(Schema.Literals(actionNames)) });
const decodeScene = Schema.decodeUnknownResult(Scene, { onExcessProperty: "error" });
const sceneFrom = (text: string, world: World) => Effect.gen(function* () {
  // Providers sometimes fence a JSON answer even when asked for plain JSON.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim());
  const json = parseJson(receivedJsonText(fenced?.[1] ?? text));
  if ("reason" in json) return yield* new ZorkResponseFailed({ message: `Engine must return a JSON scene: ${json.reason}` });
  const decoded = decodeScene(json.value);
  if (decoded._tag === "Failure") return yield* new ZorkResponseFailed({ message: decoded.failure.message });
  const scene = decoded.success;
  if (scene.narration.trim() === "" || (world.outcome === "Alive" && scene.tools.length === 0) ||
    scene.tools.some((tool) => !availableTools(world).includes(tool)) || new Set(scene.tools).size !== scene.tools.length)
    return yield* new ZorkResponseFailed({ message: "Engine scene must contain narration and a valid, unique selection of available tools (none after death)." });
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
export const play = (setup: Setup) => Effect.gen(function* () {
  const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const id = randomUUID();
  const commands = yield* Effect.tryPromise(() => readFile(new URL("./GAME.md", import.meta.url), "utf8"));
  const state = yield* Ref.make<GameState>({ world: initialWorld(), offered: [], action: undefined });
  const engine = yield* participant(`zork-engine-${id}`, setup.engine, enginePrompt(commands));
  const feedback = Ref.get(state).pipe(Effect.map((current) => current.action === undefined
    ? [`No action has succeeded yet. Call exactly one of the offered tools now: ${current.offered.join(", ")}. Use the world snapshot and correct any rejected arguments. Text alone does not act.`]
    : []));
  const adventurer = yield* participant(`zork-adventurer-${id}`, setup.adventurer, adventurerPrompt(commands), worldTools(state), offeredTools(state), feedback);
  const narrate = (world: World, action?: Action) => engine.ask(JSON.stringify({ world: view(world), action: action ?? null })).pipe(
    Effect.flatMap((text) => sceneFrom(text, world)),
  );
  const scene = yield* narrate(initialWorld());
  yield* Ref.update(state, (current) => ({ ...current, offered: scene.tools }));
  const exchanges = yield* Effect.reduce(
    Array.from({ length: maxTurns }, (_, index) => index + 1),
    (): ReadonlyArray<Exchange> => [],
    (previous) => Effect.gen(function* () {
      const before = yield* Ref.get(state);
      if (before.world.outcome !== "Alive") return previous;
      yield* adventurer.ask(JSON.stringify({ narration: previous.at(-1)?.engine ?? scene.narration, world: view(before.world), offeredTools: before.offered }));
      const after = yield* Ref.get(state);
      if (after.action === undefined) return yield* new ZorkResponseFailed({ message: `Adventurer ended the turn without a successful world tool call (game turn ${before.world.turn + 1}).` });
      const next = yield* narrate(after.world, after.action);
      yield* Ref.update(state, (current) => ({ ...current, offered: next.tools, action: undefined }));
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
  return { ...game, facts: { engine: yield* engine.facts, adventurer: yield* adventurer.facts }, transcriptPath } satisfies Played;
}).pipe(Effect.scoped);
