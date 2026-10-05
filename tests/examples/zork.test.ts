import { expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { FailureText, ModelName, ModelText, ProviderName, StopReason } from "../../src/agent-machine/names.ts";
import { ModelClient, type ModelContext } from "../../src/agent-session/contracts.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import { grueEnding, maxTurns } from "../../src/examples/zork/prompt.ts";
import { play, type Player } from "../../src/examples/zork/scenario.ts";
import { runTest } from "../support/run.ts";
import { test, testFolder } from "../support/test.ts";

const model = (name: string, reply: (request: number) => string | undefined) => {
  const seen: Array<ModelContext> = [];
  const player: Player = {
    target: { provider: ProviderName.make("scripted"), model: ModelName.make(name) },
    client: Layer.succeed(ModelClient, {
      respond: (target, context, turn) => Effect.sync(() => {
        seen.push(context);
        const text = reply(seen.length);
        return text === undefined ? {
          _tag: "ModelFailed" as const, turn, failure: FailureText.make("scripted outage"), error: receivedJson({}),
        } : {
          _tag: "ModelResponded" as const, turn, ...target,
          parts: [{ _tag: "Text" as const, text: ModelText.make(text) }],
          stop: StopReason.make("end_turn"), ending: { _tag: "Complete" as const }, metadata: receivedJson({}),
        };
      }),
    }),
  };
  return { player, seen };
};

const messages = (context: ModelContext | undefined) => context?.messages.map((message) => ({
  role: message.role,
  text: message.parts.flatMap((part) => part._tag === "Text" ? [part.text] : []).join("\n"),
}));

const setup = (engine: Player, adventurer: Player) => ({ engine, adventurer, directory: join(testFolder(), "zork") });

test("Zork exchanges replies through separate sessions and stops immediately after a Grue death", async () => {
  const engine = model("engine", (n) => ["Outside a white house.", "A dark cellar. You might be eaten by a Grue.", `Your lamp goes out.\n${grueEnding}`][n - 1]);
  const adventurer = model("adventurer", (n) => n === 1 ? "open mailbox" : "go down");
  const game = await runTest(play(setup(engine.player, adventurer.player)));
  expect(game.exchanges).toHaveLength(2);
  expect(game.epilogue).toBeUndefined();
  expect(engine.seen).toHaveLength(3);
  expect(adventurer.seen).toHaveLength(2);
  expect(engine.seen[0]?.system).toContain("Game Engine");
  expect(engine.seen[0]?.system).toContain("look under the rug");
  expect(adventurer.seen[0]?.system).toContain("Adventurer playing");
  expect(adventurer.seen[0]?.system).not.toContain("Every round MUST end");
  expect(messages(adventurer.seen[1])).toEqual([
    { role: "user", text: "Outside a white house." },
    { role: "assistant", text: "open mailbox" },
    { role: "user", text: "A dark cellar. You might be eaten by a Grue." },
  ]);
  expect(messages(engine.seen[2])?.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  expect(messages(engine.seen[2])?.at(-1)?.text).toContain("go down");
  for (const [role, facts] of Object.entries(game.facts)) {
    const turns = facts.flatMap((fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.turn] : []);
    expect(new Set(turns).size).toBe(role === "engine" ? 3 : 2);
  }
  const markdown = await readFile(game.transcriptPath, "utf8");
  expect(markdown).toContain("## Turn 2");
  expect(markdown).toContain("> go down");
  expect(markdown.trim()).toEndWith(grueEnding);
  expect(game.transcriptPath).toMatch(/\d{4}-\d{2}-\d{2}T.*\.md$/);
});

test("Zork enforces fifteen commands and a labelled Grue ending when the engine ignores the rule", async () => {
  const engine = model("engine", () => "You are still in the brightly lit house.");
  const adventurer = model("adventurer", () => "restart");
  const game = await runTest(play(setup(engine.player, adventurer.player)));
  expect(game.exchanges).toHaveLength(maxTurns);
  expect(engine.seen).toHaveLength(maxTurns + 1);
  expect(adventurer.seen).toHaveLength(maxTurns);
  expect(game.outcome).toBe("EatenByGrue");
  expect(game.epilogue).toContain(grueEnding);
  expect(messages(engine.seen.at(-1))?.at(-1)?.text).toContain("FINAL TURN");
  const markdown = await readFile(game.transcriptPath, "utf8");
  expect(markdown).toContain("## Round rule — enforced ending");
  expect(markdown.trim()).toEndWith(grueEnding);
});

test("Zork accepts the engine's own final-turn ending without adding an epilogue", async () => {
  const engine = model("engine", (n) => n === maxTurns + 1 ? grueEnding : "A passage leads down.");
  const adventurer = model("adventurer", () => "d");
  const game = await runTest(play(setup(engine.player, adventurer.player)));
  expect(game.exchanges).toHaveLength(maxTurns);
  expect(game.epilogue).toBeUndefined();
});

test.each(["engine", "adventurer", "empty"])("Zork reports a %s response failure without writing a successful game", async (role) => {
  const engine = model("engine", () => role === "engine" ? undefined : role === "empty" ? "  " : "A white house.");
  const adventurer = model("adventurer", () => undefined);
  const settings = setup(engine.player, adventurer.player);
  const result = await runTest(play(settings).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  expect(await readdir(testFolder())).not.toContain("zork");
  expect(engine.seen).toHaveLength(1);
  expect(adventurer.seen).toHaveLength(role === "adventurer" ? 1 : 0);
});
