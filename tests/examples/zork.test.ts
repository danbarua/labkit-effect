import { expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Ref } from "effect";
import { CallId, ToolName } from "../../src/agent-machine/names.ts";
import type { ModelContext } from "../../src/agent-session/contracts.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { sentIn } from "../../src/agent-session/sent.ts";
import { adventurerCustomisations, haikuAdventurer } from "../../src/examples/zork/customisations.ts";
import { adventurerFor, playerFor } from "../../src/examples/zork/players.ts";
import { play, type Adventurer, type GameEvent, type Player, type Setup } from "../../src/examples/zork/scenario.ts";
import { catalog, moveInputJson, offeredTools, worldTools, type GameState } from "../../src/examples/zork/tools.ts";
import { applyAction, availableTools, grueEnding, initialWorld, inventory, maxTurns, view, type Action, type World } from "../../src/examples/zork/world.ts";
import { runTest } from "../support/run.ts";
import { test, testFolder } from "../support/test.ts";
import { call, model, say, scriptedAdventurer, scriptedEngine, userWorld } from "../support/zork.ts";

const setup = (engine: Player, adventurer: Adventurer): Setup => ({ engine, adventurer, directory: join(testFolder(), "zork"), home: testFolder() });
/** Plays a game with the platform's file system, which its saved sessions and logs are written with. */
const played = (given: Setup) => play(given).pipe(Effect.provide(BunServices.layer));
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
  const game = await runTest(played(setup(engine.player, adventurer.player)));
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
  // An adventurer without a customisation is sent the requests as the game makes them.
  expect(adventurer.seen.filter((context) => context.toolChoice !== undefined || context.tools.some((tool) => tool.constrained !== undefined))).toEqual([]);
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

test("Haiku's adventurer requests, as recorded, constrain each offered tool and let move take only the open exits; only a game turn's last chance requires a tool call; the reply after an action is unchanged", async () => {
  expect(adventurerCustomisations["anthropic/claude-haiku-4-5"]).toBe(haikuAdventurer);
  expect(adventurerCustomisations["anthropic/claude-haiku-5-5"]).toBe(haikuAdventurer);
  // The narrowed move is the catalog's move with fewer directions.
  expect(moveInputJson(["north", "south", "east", "west", "up", "down", "n", "s", "e", "w", "u", "d"])).toEqual(catalog.find((tool) => tool.name === "move")!.input);
  // The world the latest game turn's message gave; the turn-end feedback after it is not JSON.
  const latestWorld = (context: ModelContext): ReturnType<typeof view> => {
    const texts = context.messages.filter((message) => message.role === "user").flatMap((message) => message.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []));
    const found = texts.reverse().find((text) => text.startsWith("{"));
    if (found === undefined) throw new Error("no game turn's message");
    return (JSON.parse(found) as { world: ReturnType<typeof view> }).world;
  };
  const engine = scriptedEngine();
  // Game turn 1: answers in text until a tool call is required. Game turn 2: has its calls rejected until one is required.
  const adventurer = model("adventurer", (context, n) => {
    if (context.tools.length === 0) return say("Done.");
    const required = context.toolChoice === "required";
    const turn = latestWorld(context).turn;
    if (turn === 0) return required ? call(move("north"), `action-${n}`) : say("Let me think about where to go.");
    if (turn === 1) return call(required ? move("north") : target("examine", "nothing"), `action-${n}`);
    return call(turn === 2 ? target("open", "trapdoor") : move("down"), `action-${n}`);
  });
  const game = await runTest(played(setup(engine.player, { ...adventurer.player, customise: haikuAdventurer })));
  expect(game.exchanges.map((exchange) => exchange.action.tool)).toEqual(["move", "move", "open", "move"]);
  const sent = game.facts.adventurer.flatMap((fact) => fact._tag === "Observed" && fact.observation._tag === "ModelRequestDispatched" ? [sentIn(fact.observation.sent)] : []);
  const offering = sent.filter((context) => context.tools.length > 0);
  const replies = sent.filter((context) => context.tools.length === 0);
  // Game turn 1: after two holds, the third request. Game turn 2: the fourth request, the last the limit allows.
  expect(offering.map((context) => [latestWorld(context).turn, context.toolChoice ?? "auto"])).toEqual([
    [0, "auto"], [0, "auto"], [0, "required"],
    [1, "auto"], [1, "auto"], [1, "auto"], [1, "required"],
    [2, "auto"],
    [3, "auto"],
  ]);
  expect(offering.every((context) => context.tools.every((tool) => tool.constrained === true))).toBe(true);
  const directions = (context: ModelContext): Array<string> => {
    const offered = context.tools.find((tool) => tool.name === "move");
    if (offered === undefined) throw new Error("move was not offered");
    return [...(offered.input as { readonly properties: { readonly direction: { readonly enum: ReadonlyArray<string> } } }).properties.direction.enum];
  };
  expect(offering.map(directions)).toEqual(offering.map((context) => Object.keys(latestWorld(context).exits)));
  // The house, the forest, the clearing with its trapdoor closed, then open.
  expect([...new Set(offering.map((context) => directions(context).join(" ")))]).toEqual(["north", "south north", "south", "south down"]);
  // Game turn 2's reply after its action was the fifth request, which the limit vetoed.
  expect(replies.map((context) => context.toolChoice)).toEqual([undefined, undefined, undefined]);
});

test("a game reports its opening, then each action and its narration in order, as each is played", async () => {
  const actions: ReadonlyArray<Action> = [move("north"), move("north"), target("open", "trapdoor"), move("down")];
  const engine = scriptedEngine();
  const adventurer = scriptedAdventurer((world) => actions[world.turn] ?? { tool: "look", input: {} });
  const events: Array<GameEvent> = [];
  // Each event is reported before the next model request: the adventurer has been asked once for each action reported so far.
  const asked: Array<number> = [];
  const game = await runTest(played({ ...setup(engine.player, adventurer.player), watch: (event) => Effect.sync(() => { events.push(event); asked.push(engine.seen.length); }) }));
  expect(events.map((event) => event._tag === "Opened" ? "Opened" : `${event._tag} ${event.turn}`)).toEqual(["Opened", "Acted 1", "Narrated 1", "Acted 2", "Narrated 2", "Acted 3", "Narrated 3", "Acted 4", "Narrated 4"]);
  expect(asked).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
  const opened = events[0];
  expect(opened?._tag === "Opened" ? opened.offered : []).toEqual(availableTools(initialWorld()));
  const acted = events.flatMap((event) => event._tag === "Acted" ? [event] : []);
  expect(acted.map((event) => event.action)).toEqual([...actions]);
  expect(acted.at(-1)?.world.outcome).toBe("EatenByGrue");
  const narrated = events.flatMap((event) => event._tag === "Narrated" ? [event] : []);
  expect(narrated.map((event) => event.narration)).toEqual(game.exchanges.map((exchange) => exchange.engine));
  expect(narrated.at(-1)?.offered).toEqual([]);
});

test("a player is named by its model, and needs its provider's key; Haiku's adventurer has its customisation", () => {
  const keys = { ANTHROPIC_API_KEY: "key", OPENAI_API_KEY: "key", XAI_API_KEY: "key" };
  expect(playerFor("claude-haiku-4-5", keys)).toMatchObject({ target: { provider: "anthropic", model: "claude-haiku-4-5" } });
  expect(playerFor("gpt-6-luna", keys)).toMatchObject({ target: { provider: "openai", model: "gpt-6-luna" } });
  expect(playerFor("grok-build-0.1", keys)).toMatchObject({ target: { provider: "xai", model: "grok-build-0.1" } });
  expect(playerFor("grok-4.7", {})).toEqual({ _tag: "KeyNotSet", model: "grok-4.7", variable: "XAI_API_KEY" });
  expect(playerFor("llama-3", keys)).toEqual({ _tag: "UnknownModel", named: "llama-3" });
  expect(adventurerFor("claude-haiku-4-5", keys)).toMatchObject({ customise: haikuAdventurer });
  expect(adventurerFor("claude-haiku-5-5", keys)).toMatchObject({ target: { provider: "anthropic", model: "claude-haiku-5-5" }, customise: haikuAdventurer });
  expect(adventurerFor("claude-sonnet-5-5", keys)).not.toHaveProperty("customise");
});

test("Zork enforces thirty actions and runner-owned death even when narration disagrees", async () => {
  const engine = scriptedEngine(() => ["inventory"], () => "You are carrying a diamond and are perfectly safe.", true);
  const adventurer = scriptedAdventurer(() => ({ tool: "inventory", input: {} }));
  const game = await runTest(played(setup(engine.player, adventurer.player)));
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
  const result = await runTest(played(setup(scriptedEngine().player, model("adventurer", () => say("take lantern")).player)).pipe(Effect.result));
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
  const game = await runTest(played(setup(scriptedEngine().player, adventurer.player)));
  expect(game.exchanges).toHaveLength(4);
  expect(game.exchanges[0]?.world.turn).toBe(1);
  expect(game.world.outcome).toBe("EatenByGrue");
  expect(adventurer.seen[1]?.messages.flatMap((message) => message.parts)
    .some((part) => part._tag === "Text" && part.text.includes("No action has succeeded yet"))).toBe(true);
});

test("Zork bounds a model that repeatedly calls an unoffered tool", async () => {
  const engine = scriptedEngine(() => ["inventory"]);
  const adventurer = model("adventurer", (_, n) => call(move("north"), `bad-${n}`));
  const result = await runTest(played(setup(engine.player, adventurer.player)).pipe(Effect.result));
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
  const result = await runTest(played(setup(model("engine", () => say(scene)).player, adventurer.player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(adventurer.seen).toHaveLength(0);
});

test("Zork plays a game turn whose action succeeded on the last request it may make, though the reply after it is vetoed", async () => {
  const engine = scriptedEngine((world) => (world.outcome === "Alive" ? ["move", "look"] : []));
  // Each game turn: three moves with no exit, then a look that succeeds on the fourth request; the fifth, the reply, is over the limit.
  const adventurer = model("adventurer", (context, n) => {
    // The tool results since the game turn's input, the last message with text from the user.
    const input = context.messages.reduce((found, message, index) => (message.role === "user" && message.parts.some((part) => part._tag === "Text") ? index : found), -1);
    const results = context.messages.slice(input + 1).flatMap((message) => message.parts.filter((part) => part._tag === "ToolResult")).length;
    if (results === 4) return say("Done.");
    return call(results === 3 ? { tool: "look", input: {} } : move("up"), `try-${n}`);
  });
  const game = await runTest(played(setup(engine.player, adventurer.player)));
  expect(game.exchanges.length).toBeGreaterThan(0);
  expect(game.exchanges[0]?.action.tool).toBe("look");
});

test("Zork reports provider failures without writing a successful game", async () => {
  const result = await runTest(played(setup(model("engine", () => undefined).player, scriptedAdventurer(() => ({ tool: "look", input: {} })).player)).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(await readdir(testFolder())).not.toContain("zork");
});
