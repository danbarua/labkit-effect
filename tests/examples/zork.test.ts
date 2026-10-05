import { expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { CallId, FailureText, ModelName, ModelText, ProviderName, StopReason, ToolName } from "../../src/agent-machine/names.ts";
import type { ModelPart } from "../../src/agent-machine/observation.ts";
import { ModelClient, type ModelContext } from "../../src/agent-session/contracts.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { play, type Player } from "../../src/examples/zork/scenario.ts";
import { catalog, offeredTools, worldTools, type GameState } from "../../src/examples/zork/tools.ts";
import { applyAction, availableTools, grueEnding, initialWorld, inventory, maxTurns, view, type Action, type World } from "../../src/examples/zork/world.ts";
import { runTest } from "../support/run.ts";
import { test, testFolder } from "../support/test.ts";

const say = (text: string): ReadonlyArray<ModelPart> => [{ _tag: "Text", text: ModelText.make(text) }];
const call = (action: Action, id: string): ReadonlyArray<ModelPart> => [{
  _tag: "ToolCall", call: CallId.make(id), tool: ToolName.make(action.tool), input: receivedJson(action.input),
}];
const model = (name: string, reply: (context: ModelContext, request: number) => ReadonlyArray<ModelPart> | undefined) => {
  const seen: Array<ModelContext> = [];
  const player: Player = {
    target: { provider: ProviderName.make("scripted"), model: ModelName.make(name) },
    client: Layer.succeed(ModelClient, {
      respond: (target, context, turn) => Effect.sync(() => {
        seen.push(context);
        const parts = reply(context, seen.length);
        return parts === undefined ? {
          _tag: "ModelFailed" as const, turn, failure: FailureText.make("scripted outage"), error: receivedJson({}),
        } : {
          _tag: "ModelResponded" as const, turn, ...target, parts,
          stop: StopReason.make(parts.some((part) => part._tag === "ToolCall") ? "tool_use" : "end_turn"),
          ending: { _tag: "Complete" as const }, metadata: receivedJson({}),
        };
      }),
    }),
  };
  return { player, seen };
};
const userWorld = (context: ModelContext): ReturnType<typeof view> => {
  const text = context.messages.filter((message) => message.role === "user" && message.parts.some((part) => part._tag === "Text")).at(-1)?.parts
    .flatMap((part) => part._tag === "Text" ? [part.text] : []).join("\n") ?? "";
  return (JSON.parse(text) as { world: ReturnType<typeof view> }).world;
};
const scriptedEngine = (select: (world: ReturnType<typeof view>) => ReadonlyArray<string> = (world) => world.availableTools, narrate?: (world: ReturnType<typeof view>) => string, fenced = false) =>
  model("engine", (context) => {
    const world = userWorld(context);
    const json = JSON.stringify({ narration: narrate?.(world) ?? world.event, tools: world.outcome === "Alive" ? select(world) : [] });
    return say(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json);
  });
const scriptedAdventurer = (choose: (world: ReturnType<typeof view>, context: ModelContext) => Action) => model("adventurer", (context, n) => {
  if (context.messages.at(-1)?.parts.some((part) => part._tag === "ToolResult")) return say("Done.");
  return call(choose(userWorld(context), context), `action-${n}`);
});
const setup = (engine: Player, adventurer: Player) => ({ engine, adventurer, directory: join(testFolder(), "zork") });
const act = (world: World, action: Action): World => {
  const result = applyAction(world, action);
  if ("problem" in result) throw new Error(result.problem);
  return result.world;
};
const move = (direction: string): Action => ({ tool: "move", input: { direction } });
const target = (tool: "open" | "take" | "drop" | "light" | "examine", target: string): Action => ({ tool, input: { target } });

test("Zork records engine-selected tools, inventory changes and an early Grue death in independent sessions", async () => {
  const actions: ReadonlyArray<Action> = [target("open", "mailbox"), target("take", "leaflet"), target("drop", "leaflet"), move("n"), move("n"), target("open", "trapdoor"), move("d")];
  const engine = scriptedEngine((world) => [actions[world.turn]?.tool ?? "look"]);
  const adventurer = scriptedAdventurer((world) => actions[world.turn] ?? { tool: "look", input: {} });
  const game = await runTest(play(setup(engine.player, adventurer.player)));
  expect(game.exchanges).toHaveLength(7);
  expect(game.world.outcome).toBe("EatenByGrue");
  expect(game.epilogue).toBeUndefined();
  expect(inventory(game.exchanges[1]!.world)).toEqual(["leaflet"]);
  expect(game.exchanges[2]?.world.items.leaflet).toBe("house");
  expect(game.world.location).toBe("cellar");
  expect(engine.seen).toHaveLength(8);
  expect(adventurer.seen).toHaveLength(14);
  expect(engine.seen[0]?.system).toContain("runner owns the world");
  expect(adventurer.seen[0]?.system).toContain("tool results are facts");
  expect(adventurer.seen[0]?.tools.map((tool) => String(tool.name))).toEqual(["open"]);
  expect(adventurer.seen[1]?.tools).toEqual([]);
  expect(adventurer.seen[2]?.tools.map((tool) => String(tool.name))).toEqual(["take"]);
  expect(userWorld(adventurer.seen[4]!).inventory).toEqual(["leaflet"]);
  expect(userWorld(engine.seen[2]!).inventory).toEqual(["leaflet"]);
  for (const [role, facts] of Object.entries(game.facts)) {
    const turns = facts.flatMap((fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.turn] : []);
    expect(new Set(turns).size).toBe(role === "engine" ? 8 : 7);
  }
  const markdown = await readFile(game.transcriptPath, "utf8");
  expect(markdown).toContain('take({"target":"leaflet"})');
  expect(markdown).toContain("### World — tool result");
  expect(markdown).toContain("Offered tools: open");
  expect(markdown.trim()).toEndWith(grueEnding);
  expect(game.transcriptPath).toMatch(/\d{4}-\d{2}-\d{2}T.*\.md$/);
});

test("Zork enforces thirty actions and runner-owned death even when narration disagrees", async () => {
  const engine = scriptedEngine(() => ["inventory"], () => "You are carrying a diamond and are perfectly safe.", true);
  const adventurer = scriptedAdventurer(() => ({ tool: "inventory", input: {} }));
  const game = await runTest(play(setup(engine.player, adventurer.player)));
  expect(maxTurns).toBe(30);
  expect(game.exchanges).toHaveLength(30);
  expect(game.world.turn).toBe(30);
  expect(game.world.outcome).toBe("EatenByGrue");
  expect(inventory(game.world)).toEqual([]);
  expect(game.epilogue).toContain(grueEnding);
  expect(engine.seen).toHaveLength(31);
  expect(adventurer.seen).toHaveLength(60);
  expect((await readFile(game.transcriptPath, "utf8")).trim()).toEndWith(grueEnding);
});

test("Zork world checks exits and ownership and preserves a dropped item when revisiting", () => {
  const start = initialWorld();
  expect(applyAction(start, target("take", "leaflet"))).toEqual({ problem: "You cannot take an item that is not present." });
  expect(applyAction(start, target("drop", "lantern"))).toEqual({ problem: "You do not carry that item." });
  expect(applyAction(start, move("down"))).toEqual({ problem: "There is no open exit in that direction." });
  expect(start.turn).toBe(0);
  const opened = act(start, target("open", "mailbox"));
  const taken = act(opened, target("take", "leaflet"));
  expect(applyAction(taken, target("take", "leaflet"))).toEqual({ problem: "You cannot take an item that is not present." });
  const dropped = act(taken, target("drop", "leaflet"));
  const returned = act(act(dropped, move("north")), move("south"));
  expect(view(returned).visibleItems).toEqual(["leaflet"]);
  expect(inventory(act(returned, target("take", "leaflet")))).toEqual(["leaflet"]);
});

test("Zork light protects the Adventurer until its fuel expires and death forbids further actions", () => {
  const actions = [move("north"), target("take", "lantern"), target("light", "lantern"), move("north"), target("open", "trapdoor"), move("down")];
  const cellar = actions.reduce(act, initialWorld());
  expect(cellar.outcome).toBe("Alive");
  expect(view(cellar).dark).toBe(false);
  const ended = Array.from({ length: cellar.fuel }).reduce<World>((world) => act(world, { tool: "inventory", input: {} }), cellar);
  expect(ended.outcome).toBe("EatenByGrue");
  expect(ended.fuel).toBe(0);
  expect(ended.lanternOn).toBe(false);
  expect(availableTools(ended)).toEqual([]);
  expect(applyAction(ended, move("up"))).toEqual({ problem: "The game has ended." });
  // A dropped lit lantern illuminates its room, but does not follow the player.
  const dropped = act(cellar, target("drop", "lantern"));
  expect(dropped.outcome).toBe("Alive");
  expect(act(dropped, move("east")).outcome).toBe("EatenByGrue");
});

test("Zork tool runner rejects unoffered and malformed calls and atomically permits one action", async () => {
  for (const spec of catalog) expect(spec.input).toMatchObject({ type: "object", additionalProperties: false });
  await runTest(Effect.gen(function* () {
    const state = yield* Ref.make<GameState>({ world: initialWorld(), offered: ["look", "open"], action: undefined });
    const tools = worldTools(state);
    const run = (name: string, input: Record<string, string>) => tools.run(ToolName.make(name), receivedJson(input), CallId.make(name));
    expect((yield* run("move", { direction: "north" }))._tag).toBe("Failed");
    expect((yield* run("open", { wrong: "mailbox" }))._tag).toBe("Failed");
    expect((yield* run("look", { target: "mailbox" }))._tag).toBe("Failed");
    expect((yield* tools.run(ToolName.make("look"), receivedJson("anything"), CallId.make("malformed")))._tag).toBe("Failed");
    expect((yield* run("open", { target: "trapdoor" }))._tag).toBe("Failed");
    expect((yield* Ref.get(state)).world).toEqual(initialWorld());
    const results = yield* Effect.all([run("open", { target: "mailbox" }), run("look", {})], { concurrency: "unbounded" });
    expect(results.filter((result) => result._tag === "Succeeded")).toHaveLength(1);
    expect((yield* Ref.get(state)).world.turn).toBe(1);
    expect(yield* offeredTools(state)).toEqual([]);
    expect((yield* run("look", {}))._tag).toBe("Failed");
  }));
});

test("Zork rejects prose-only Adventurer actions", async () => {
  const result = await runTest(play(setup(scriptedEngine().player, model("adventurer", () => say("take lantern")).player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(String(result.failure)).toContain("without a successful world tool call");
  expect(await readdir(testFolder())).not.toContain("zork");
});

test("Zork asks for a real action when the Adventurer first replies with prose", async () => {
  const actions = [move("north"), move("north"), target("open", "trapdoor"), move("down")];
  const adventurer = model("adventurer", (context, n) => {
    if (n === 1) return say("I will head north.");
    if (n === 2) return call(move("north"), "corrected-action");
    if (context.messages.at(-1)?.parts.some((part) => part._tag === "ToolResult")) return say("Done.");
    return call(actions[userWorld(context).turn] ?? move("down"), `action-${n}`);
  });
  const game = await runTest(play(setup(scriptedEngine().player, adventurer.player)));
  expect(game.exchanges).toHaveLength(4);
  expect(game.exchanges[0]?.world.turn).toBe(1);
  expect(game.world.outcome).toBe("EatenByGrue");
  expect(adventurer.seen[1]?.messages.flatMap((message) => message.parts)
    .some((part) => part._tag === "Text" && part.text.includes("No action has succeeded yet"))).toBe(true);
});

test("Zork bounds a model that repeatedly calls an unoffered tool", async () => {
  const engine = scriptedEngine(() => ["inventory"]);
  const adventurer = model("adventurer", (_, n) => call(move("north"), `bad-${n}`));
  const result = await runTest(play(setup(engine.player, adventurer.player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(adventurer.seen).toHaveLength(4);
  expect(engine.seen).toHaveLength(1);
});

test.each([
  "not json",
  JSON.stringify({ narration: "Hello", tools: [] }),
  JSON.stringify({ narration: "Hello", tools: ["teleport"] }),
  JSON.stringify({ narration: "Hello", tools: ["take"] }),
  JSON.stringify({ narration: "Hello", tools: ["look", "look"] }),
])("Zork rejects an invalid engine scene: %s", async (scene) => {
  const adventurer = scriptedAdventurer(() => ({ tool: "look", input: {} }));
  const result = await runTest(play(setup(model("engine", () => say(scene)).player, adventurer.player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(adventurer.seen).toHaveLength(0);
});

test("Zork reports provider failures without writing a successful game", async () => {
  const result = await runTest(play(setup(model("engine", () => undefined).player, scriptedAdventurer(() => ({ tool: "look", input: {} })).player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(await readdir(testFolder())).not.toContain("zork");
});
