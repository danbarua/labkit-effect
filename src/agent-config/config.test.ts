/** Policies read from configuration files: decoded per seam, checked, merged in layers, extended, and made into a session's seam lists. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder, testOrigin } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, Seq, type ToolKind, ToolName, TurnId } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { every, type Policy } from "../agent-policy/policy.ts";
import { MaxHolds, ModelRequestPolicies, ToolCallPolicies, type ToolSpec, TurnEndHooks } from "../agent-session/contracts.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { loadConfiguration, policyFiles } from "./file.ts";
import { merged } from "./merge.ts";
import { policiesJsonSchema } from "./schema.ts";
import { seamLayer, seamListsOf } from "./seams.ts";

/** Writes `text` to `path` under the test's folder, making its folders; gives the full path. */
const write = (path: string, text: string): string => {
  const full = join(testFolder(), path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
};

const load = (files: ReadonlyArray<string>) => runTest(loadConfiguration(files).pipe(Effect.provide(BunServices.layer)));

/** What loading `files` fails with, as its message. */
const refusal = (files: ReadonlyArray<string>) =>
  runTest(
    loadConfiguration(files).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
      Effect.provide(BunServices.layer),
    ),
  );

const spec = (name: string, kind: ToolKind): ToolSpec => ({ name: ToolName.make(name), description: name, input: { type: "object" }, kind, replay: "safe" });

/** A session that opened with a tool that reads and one that edits, and two identical calls to `look` in turn-1. */
const facts = (): ReadonlyArray<Fact> =>
  [
    boringOpening([spec("look", "read"), spec("change", "edit")]),
    { _tag: "ToolCallArrived", turn: TurnId.make("turn-1"), call: CallId.make("c1"), tool: ToolName.make("look"), input: receivedJson({}) },
    { _tag: "ToolCallArrived", turn: TurnId.make("turn-1"), call: CallId.make("c2"), tool: ToolName.make("look"), input: receivedJson({}) },
  ].map((observation, index): Fact => ({ _tag: "Observed", seq: Seq.make(index + 1), time: DateTime.makeUnsafe(0), origin: testOrigin(), observation: observation as never }));

const run = (call: string, tool: string): EffectRequest => ({ _tag: "RunTool", call: CallId.make(call), tool: ToolName.make(tool), input: receivedJson({}) });

/** What `policy` does with `request`: runs it, vetoes it (and why), or asks. */
const verdictOf = <S>(policy: Policy<S>, request: EffectRequest): string => {
  const step = policy.start(request);
  return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : `vetoed: ${asText(step.verdict.reason)}`;
};

test("CF1: a file lists each seam's entries in order, each a plug-in and its settings, a setting not given taking its default; they become the session's seam lists", async () => {
  const file = write(
    "user/policies.yml",
    `# yaml-language-server: $schema=./policies.schema.json
toolCalls:
  - use: loopBreaker
    nudgeAt: 2
  - use: permissions
    mode: dontAsk
modelRequests:
  - use: maxTurnRequests
turnEnd:
  - use: retryIncomplete
    retries: 2
maxHolds: 2
`,
  );
  const configuration = await load([file]);
  expect(Object.fromEntries(Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => [entry.plugin.use, entry.settings])]))).toEqual({
    toolCalls: [
      ["loopBreaker", { nudgeAt: 2, stopAt: 5, key: "toolAndInput" }],
      ["permissions", { mode: "dontAsk" }],
    ],
    modelRequests: [["maxTurnRequests", { limit: 1000 }]],
    turnEnd: [["retryIncomplete", { retries: 2 }]],
  });
  const provided = await runTest(
    Effect.gen(function* () {
      const toolCalls = every(yield* Effect.forEach(yield* ToolCallPolicies, (policyOf) => policyOf(facts())));
      return {
        toolCalls: [verdictOf(toolCalls, run("c1", "look")), verdictOf(toolCalls, run("c2", "look")), verdictOf(toolCalls, run("c3", "change"))],
        modelRequests: (yield* ModelRequestPolicies).length,
        turnEnd: (yield* TurnEndHooks).length,
        maxHolds: yield* MaxHolds,
      };
    }).pipe(Effect.provide(seamLayer(seamListsOf(configuration, { canAsk: true })))),
  );
  expect(provided.toolCalls[0]).toBe("runs");
  expect(provided.toolCalls[1]).toStartWith("vetoed: Not run: look has been called with this same input 2 times in a row.");
  // dontAsk vetoes a call to a tool that edits.
  expect(provided.toolCalls[2]).toStartWith("vetoed: ");
  expect({ modelRequests: provided.modelRequests, turnEnd: provided.turnEnd, maxHolds: provided.maxHolds }).toEqual({ modelRequests: 1, turnEnd: 1, maxHolds: 2 });
});

test("CF2: what the host says, that no file does: whether anyone can be asked, which permissions reads", async () => {
  const file = write("user/policies.yml", "toolCalls:\n  - use: permissions\n");
  const configuration = await load([file]);
  const verdict = (canAsk: boolean) =>
    runTest(
      Effect.gen(function* () {
        const policy = every(yield* Effect.forEach(yield* ToolCallPolicies, (policyOf) => policyOf(facts())));
        return verdictOf(policy, run("c3", "change"));
      }).pipe(Effect.provide(seamLayer(seamListsOf(configuration, { canAsk })))),
    );
  expect(await verdict(true)).toBe("asks");
  expect(await verdict(false)).toStartWith("vetoed: ");
});

test("CF3: a mistake is refused naming the file, where in it, and what is wrong", async () => {
  const at = (text: string) => write("user/policies.yml", text);
  expect(await refusal([at("toolCalls:\n  - use: loopBraker\n")])).toEndWith(
    'user/policies.yml: toolCalls[0].use: "loopBraker" is not a plug-in on toolCalls; those are: loopBreaker, permissions',
  );
  expect(await refusal([at("toolCalls:\n  - use: maxTurnRequests\n")])).toEndWith(
    'toolCalls[0].use: "maxTurnRequests" is not a plug-in on toolCalls; those are: loopBreaker, permissions',
  );
  expect(await refusal([at("toolCalls:\n  - use: loopBreaker\n    nudgAt: 2\n")])).toEndWith('toolCalls[0]: loopBreaker: Expected no excess property at ["nudgAt"]');
  expect(await refusal([at("toolCalls:\n  - use: permissions\n    mode: yolo\n")])).toEndWith(
    'toolCalls[0]: permissions: Expected "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" at ["mode"]',
  );
  expect(await refusal([at("toolcalls:\n  - use: permissions\n")])).toEndWith("toolcalls: Not a key of the file; those are: toolCalls, modelRequests, turnEnd, knownModels, settling, toolSources, maxHolds, extensions");
  expect(await refusal([at("toolCalls:\n  use: permissions\n")])).toEndWith("toolCalls: Expected a list of entries, each `use: <plug-in>` and its settings");
});

test("CF4: layers merge in order, the last write winning: mappings key by key, deeply; any other value, a list included, replaced whole", async () => {
  expect(merged([{ a: { b: 1, c: [1, 2] }, d: "x" }, { a: { c: [3] }, e: true }, { d: "y" }])).toEqual({ a: { b: 1, c: [3] }, d: "y", e: true });
  const [user, project] = policyFiles(join(testFolder(), "project"), { home: join(testFolder(), "home") });
  if (user === undefined || project === undefined) throw new Error("expected the user's file and the project's");
  write("home/.config/labkit/policies.yml", "toolCalls:\n  - use: loopBreaker\n  - use: permissions\nmodelRequests:\n  - use: maxTurnRequests\n    limit: 10\n");
  write("project/.labkit/policies.yml", "toolCalls:\n  - use: permissions\n    mode: acceptEdits\n");
  const configuration = await load([user, project]);
  // The project's toolCalls replace the user's; the user's modelRequests stand.
  expect(configuration.lists.toolCalls?.map((entry) => [entry.plugin.use, entry.settings])).toEqual([["permissions", { mode: "acceptEdits" }]]);
  expect(configuration.lists.modelRequests?.map((entry) => entry.settings)).toEqual([{ limit: 10 }]);
});

test("CF5: a file that is not there is an empty layer; a seam no file lists is not provided, so the host's own list or the default stands", async () => {
  const configuration = await load(policyFiles(join(testFolder(), "nowhere"), { home: join(testFolder(), "no-home") }));
  expect(configuration).toEqual({ lists: {} });
  const lists = seamListsOf(configuration, { canAsk: true });
  expect(lists).toEqual({});
  const provided = Effect.gen(function* () {
    return (yield* ToolCallPolicies).length;
  });
  expect(await runTest(provided.pipe(Effect.provide(seamLayer(lists))))).toBe(0);
});

test("CF6: turn-end hooks need maxHolds, in some layer", async () => {
  const hooks = write("user/policies.yml", "turnEnd:\n  - use: retryIncomplete\n");
  expect(await refusal([hooks])).toEndWith("maxHolds: Required when turnEnd lists hooks: how many times they may hold one turn open");
  const holds = write("project/policies.yml", "maxHolds: 1\n");
  expect((await load([hooks, holds])).maxHolds).toBe(1);
});

test("CF7: an extension the file names, relative to its folder, registers the plug-ins it exports, as built-ins are; a name used twice is refused", async () => {
  const extension = new URL("../../tests/support/config-extension.ts", import.meta.url).pathname;
  const file = write("user/policies.yml", `extensions:\n  - ${extension}\ntoolCalls:\n  - use: denyTools\n    tools: [change]\n  - use: permissions\n    mode: bypassPermissions\n`);
  const configuration = await load([file]);
  const verdicts = await runTest(
    Effect.gen(function* () {
      const policy = every(yield* Effect.forEach(yield* ToolCallPolicies, (policyOf) => policyOf(facts())));
      return [verdictOf(policy, run("c1", "look")), verdictOf(policy, run("c3", "change"))];
    }).pipe(Effect.provide(seamLayer(seamListsOf(configuration, { canAsk: true })))),
  );
  expect(verdicts).toEqual(["runs", 'vetoed: {"denied":"change"}']);
  // A path relative to the file's folder.
  write("user/extension.ts", `export { default } from ${JSON.stringify(extension)};\n`);
  const relative = write("user/relative.yml", "extensions:\n  - ./extension.ts\ntoolCalls:\n  - use: denyTools\n");
  expect((await load([relative])).lists.toolCalls?.map((entry) => [entry.plugin.use, entry.settings])).toEqual([["denyTools", { tools: [] }]]);
  // The same module named by two layers is loaded once; two modules exporting one name are refused.
  const twice = write("user/twice.yml", `extensions:\n  - ${extension}\n`);
  const again = write("project/again.yml", `extensions:\n  - ${extension}\n`);
  expect((await load([twice, again])).lists).toEqual({});
  const clash = write("project/clash.yml", "extensions:\n  - ../user/extension.ts\n");
  expect(await refusal([twice, clash])).toEndWith("extensions: Two plug-ins are named denyTools");
});

test("CF8: the JSON Schema of a file names each seam's plug-ins and their settings, and no other property", () => {
  const schema = policiesJsonSchema() as { readonly properties: Record<string, { readonly items?: { readonly anyOf?: ReadonlyArray<{ readonly properties: Record<string, unknown>; readonly required: ReadonlyArray<string>; readonly additionalProperties: boolean }> } }>; readonly additionalProperties: boolean };
  expect(schema.additionalProperties).toBe(false);
  const entries = schema.properties["toolCalls"]?.items?.anyOf ?? [];
  expect(entries.map((entry) => entry.properties["use"])).toEqual([{ type: "string", enum: ["loopBreaker"] }, { type: "string", enum: ["permissions"] }]);
  expect(entries.map((entry) => [entry.required, entry.additionalProperties])).toEqual([
    [["use"], false],
    [["use"], false],
  ]);
  expect(Object.keys(entries[0]?.properties ?? {})).toEqual(["use", "nudgeAt", "stopAt", "key"]);
});
