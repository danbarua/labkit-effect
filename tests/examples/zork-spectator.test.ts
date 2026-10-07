import { expect } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Stream } from "effect";
import { TestName } from "../../src/agent-machine/names.ts";
import { reportedBy } from "../../src/agent-session/origin.ts";
import { labels, makeMatch, type Match, type MatchState, type Players } from "../../src/examples/zork-spectator/match.ts";
import { serve } from "../../src/examples/zork-spectator/server.ts";
import { play, type Player, type Setup } from "../../src/examples/zork/scenario.ts";
import type { Action } from "../../src/examples/zork/world.ts";
import { runTest } from "../support/run.ts";
import { test, testFolder } from "../support/test.ts";
import { model, say, scriptedAdventurer, scriptedEngine } from "../support/zork.ts";

const move = (direction: string): Action => ({ tool: "move", input: { direction } });
/** North twice, open the trapdoor, and down into the dark: eaten in game turn 4. */
const shortGame: ReadonlyArray<Action> = [move("north"), move("north"), { tool: "open", input: { target: "trapdoor" } }, move("down")];
const adventurerOfShortGame = () => scriptedAdventurer((world) => shortGame[world.turn] ?? { tool: "look", input: {} });

const playersOf = (engine: Player, adventurer: Player): Players => ({ engine: () => engine, adventurer: () => adventurer });
/** Plays a game as the spectator's process does, keeping its sessions and transcript in the test's folder. */
const run = (setup: Setup) =>
  play({ ...setup, directory: join(testFolder(), "zork"), home: testFolder() }).pipe(
    reportedBy({ _tag: "Test", name: TestName.make("zork-spectator") }),
    Effect.provide(BunServices.layer),
  );

/** Collects every state `match` sends from now on; the deferred is done when the state returns to setup after a game. */
const watched = (match: Match) =>
  Effect.gen(function* () {
    const states: Array<MatchState> = [];
    const ready = yield* Deferred.make<void>();
    const over = yield* Deferred.make<ReadonlyArray<MatchState>>();
    yield* match.states.pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          states.push(state);
          yield* Deferred.succeed(ready, undefined);
          if (state._tag === "Setup" && states.some((each) => each._tag === "Playing")) yield* Deferred.succeed(over, states);
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    return over;
  });

const playing = (states: ReadonlyArray<MatchState>) => states.flatMap((state) => (state._tag === "Playing" ? [state] : []));

test("a game begun from two labels is sent as it is played: the opening, each call and narration, and its end; then the state returns to setup", async () => {
  const states = await runTest(
    Effect.gen(function* () {
      const match = yield* makeMatch(playersOf(scriptedEngine().player, adventurerOfShortGame().player), run);
      const over = yield* watched(match);
      expect(yield* match.begin("Sonnet", "Haiku")).toEqual({ _tag: "Started" });
      return yield* Deferred.await(over);
    }),
  );
  expect(states[0]).toEqual({ _tag: "Setup", choices: labels });
  expect(states.at(-1)).toEqual({ _tag: "Setup", choices: labels });
  const games = playing(states);
  // Each event was sent on its own, as it was played.
  expect(games.map((state) => state.shown.length)).toEqual(Array.from({ length: 11 }, (_, index) => index));
  const last = games.at(-1);
  expect(last?.engine).toBe("Sonnet");
  expect(last?.adventurer).toBe("Haiku");
  expect(last?.shown.map((shown) => (shown._tag === "Acted" || shown._tag === "Narrated" ? `${shown._tag} ${shown.turn}` : shown._tag))).toEqual([
    "Opened", "Acted 1", "Narrated 1", "Acted 2", "Narrated 2", "Acted 3", "Narrated 3", "Acted 4", "Narrated 4", "Ended",
  ]);
  expect(last?.shown.flatMap((shown) => (shown._tag === "Acted" ? [shown.call] : []))).toEqual([
    'move({"direction":"north"})', 'move({"direction":"north"})', 'open({"target":"trapdoor"})', 'move({"direction":"down"})',
  ]);
  expect(last?.status).toEqual({ turn: 4, of: 30, location: "Damp cellar", outcome: "EatenByGrue" });
  // The status comes from the world; the world itself is never sent.
  expect(games[0]?.status).toEqual({ turn: 0, of: 30, location: "West of the white house", outcome: "Alive" });
  expect(JSON.stringify(states)).not.toContain('"world"');
  expect(JSON.stringify(states)).not.toContain('"mailboxOpen"');
});

test("Begin is refused for a model whose key is not set, naming its label, and for a label the spectator does not know; no game starts", async () => {
  await runTest(
    Effect.gen(function* () {
      const players: Players = {
        engine: () => ({ _tag: "KeyNotSet", model: "grok-4.7", variable: "XAI_API_KEY" }),
        adventurer: () => adventurerOfShortGame().player,
      };
      const match = yield* makeMatch(players, run);
      expect(yield* match.begin("Grok", "Haiku")).toEqual({
        _tag: "Refused",
        error: "ERROR: Grok is unavailable: XAI_API_KEY is not set.",
        hint: "HINT: Set XAI_API_KEY and start the spectator again.",
      });
      expect(yield* match.begin("Sonnet", "Llama")).toEqual({ _tag: "Refused", error: "ERROR: Choose an Engine and an Adventurer.", hint: "HINT: Choose both from the lists." });
      expect(yield* match.states.pipe(Stream.take(1), Stream.runCollect)).toEqual([{ _tag: "Setup", choices: labels }]);
    }),
  );
});

test("a game that fails ends with an ERROR naming the player by its role and label, and one that dies ends with an ERROR too; either way the next Begin starts a game", async () => {
  const { failed, died, again } = await runTest(
    Effect.gen(function* () {
      // An adventurer that only ever answers in text.
      const talker = model("adventurer", () => say("I am thinking about it.")).player;
      const failing = yield* makeMatch(playersOf(scriptedEngine().player, talker), run);
      const failedOver = yield* watched(failing);
      yield* failing.begin("Sonnet", "Haiku");
      const failed = playing(yield* Deferred.await(failedOver)).at(-1)?.shown.at(-1);
      const dying = yield* makeMatch(playersOf(scriptedEngine().player, talker), () => Effect.die(new Error("the world fell over")));
      const diedOver = yield* watched(dying);
      yield* dying.begin("Grok", "GPT Luna");
      const died = playing(yield* Deferred.await(diedOver)).at(-1)?.shown.at(-1);
      return { failed, died, again: yield* dying.begin("Grok", "GPT Luna") };
    }),
  );
  expect(failed).toEqual({ _tag: "Failed", error: "ERROR: The Adventurer (Haiku) ended game turn 1 without an action." });
  expect(died).toEqual({ _tag: "Failed", error: "ERROR: The game stopped: the world fell over." });
  expect(again).toEqual({ _tag: "Started" });
});

/** Reads server-sent events from `url` until `count` states have arrived, or one that `until` accepts, then disconnects. */
const statesFrom = async (url: URL, count: number, until: (state: MatchState) => boolean = () => false): Promise<ReadonlyArray<MatchState>> => {
  const abort = new AbortController();
  const response = await fetch(url, { signal: abort.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const states: Array<MatchState> = [];
  let buffer = "";
  while (states.length < count && !states.some(until)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) if (event.startsWith("data: ")) states.push(JSON.parse(event.slice("data: ".length)) as MatchState);
  }
  abort.abort();
  return states;
};

test("the server sends the page, refuses a Begin it cannot start, and sends a page that reconnects during a game the whole game so far; a second Begin finds the game running", async () => {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // The engine holds its third request, the narration of game turn 2, until the test releases it.
  const engine = scriptedEngine(undefined, undefined, false, (request) =>
    request === 3 ? Effect.promise(async () => { held.resolve(); await release.promise; }) : Effect.void,
  );
  const match = await runTest(makeMatch(playersOf(engine.player, adventurerOfShortGame().player), run));
  const server = serve(match, { hostname: "localhost", port: 0 });
  try {
    const page = await fetch(new URL("/", server.url));
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Begin game");
    const refused = await fetch(new URL("/begin", server.url), { method: "POST", body: JSON.stringify({ engine: "Sonnet" }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ _tag: "Refused", error: "ERROR: Choose an Engine and an Adventurer.", hint: "HINT: Choose both from the lists." });
    expect(await statesFrom(new URL("/events", server.url), 1)).toEqual([{ _tag: "Setup", choices: labels }]);
    const begun = await fetch(new URL("/begin", server.url), { method: "POST", body: JSON.stringify({ engine: "Haiku", adventurer: "Haiku" }) });
    expect(begun.status).toBe(200);
    await held.promise;
    const sofar = ["Opened", "Acted", "Narrated", "Acted"];
    const first = (await statesFrom(new URL("/events", server.url), 1))[0];
    expect(first?._tag === "Playing" ? first.shown.map((shown) => String(shown._tag)) : []).toEqual(sofar);
    // A page that disconnects and connects again is sent the same game so far.
    const reconnected = (await statesFrom(new URL("/events", server.url), 1))[0];
    expect(reconnected).toEqual(first);
    const second = await fetch(new URL("/begin", server.url), { method: "POST", body: JSON.stringify({ engine: "Sonnet", adventurer: "Grok" }) });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ _tag: "Running" });
    release.resolve();
    // The game plays on to its end, and the state returns to setup.
    const rest = await statesFrom(new URL("/events", server.url), Number.POSITIVE_INFINITY, (state) => state._tag === "Setup");
    expect(rest.at(-1)).toEqual({ _tag: "Setup", choices: labels });
  } finally {
    release.resolve();
    await server.stop(true);
  }
});
