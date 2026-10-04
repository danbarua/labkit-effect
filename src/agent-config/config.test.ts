/** A session's configuration: plug-ins configured once and listed by name per seam, merged in layers, checked, extended, and made into a session's seam lists. */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Duration, Effect } from "effect";
import fc from "fast-check";
import { boringOpening } from "../../tests/support/boring.ts";
import { observe, open, opened } from "../../tests/support/drive.ts";
import { runTest } from "../../tests/support/run.ts";
import { test, testFolder, testOrigin } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, Seq, type ToolKind, ToolName, TurnId } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { every, type Policy } from "../agent-policy/policy.ts";
import { MaxHolds, ModelRequestPolicies, ToolCallPolicies, type ToolSpec, TurnEndHooks } from "../agent-session/contracts.ts";
import { asText, receivedJson } from "../agent-session/received.ts";
import { type Configuration, fileLayer, type LayerSource, loadConfiguration, policyLayers } from "./file.ts";
import { merged, over } from "./merge.ts";
import { policiesJsonSchema } from "./schema.ts";
import { seamLayer, seamListsOf } from "./seams.ts";

/** Writes `text` to `path` under the test's folder, making its folders; gives the full path. */
const write = (path: string, text: string): string => {
  const full = join(testFolder(), path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  return full;
};

/** The layers in `files`, each with whether it is trusted (the user's: true unless said). */
const layersOf = (files: ReadonlyArray<string | readonly [string, boolean]>) =>
  Effect.map(
    Effect.forEach(files, (file) => (typeof file === "string" ? fileLayer(file, true) : fileLayer(file[0], file[1]))),
    (layers) => layers.filter((layer): layer is LayerSource => layer !== undefined),
  );

const load = (files: ReadonlyArray<string | readonly [string, boolean]>) =>
  runTest(Effect.flatMap(layersOf(files), (layers) => loadConfiguration(layers)).pipe(Effect.provide(BunServices.layer)));

/** What loading `files` fails with, as its message. */
const refusal = (files: ReadonlyArray<string | readonly [string, boolean]>) =>
  runTest(
    Effect.flatMap(layersOf(files), (layers) => loadConfiguration(layers)).pipe(
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

/** Each seam's entries, as their names, plug-ins and settings. */
const listed = (configuration: Configuration) =>
  Object.fromEntries(Object.entries(configuration.lists).map(([seam, entries]) => [seam, entries.map((entry) => [entry.name, entry.plugin.use, entry.settings])]));

test("CF1: plug-ins are configured once, by name, in plugins; each seam lists names in order, a plug-in's own name taking its defaults; they become the session's seam lists", async () => {
  const file = write(
    "user/policies.yml",
    `# yaml-language-server: $schema=./policies.schema.json
plugins:
  loopBreaker:
    nudgeAt: 2
  permissions:
    mode: dontAsk
  retryIncomplete:
    retries: 2
toolCalls: [loopBreaker, permissions]
modelRequests: [loopBreaker, maxTurnRequests]
turnEnd: [retryIncomplete]
maxHolds: 2
`,
  );
  const configuration = await load([file]);
  expect(listed(configuration)).toEqual({
    toolCalls: [
      ["loopBreaker", "loopBreaker", { nudgeAt: 2, stopAt: 5, key: "toolAndInput" }],
      ["permissions", "permissions", { mode: "dontAsk" }],
    ],
    // The loop breaker's settings are the same on both lists: they are said once.
    modelRequests: [
      ["loopBreaker", "loopBreaker", { nudgeAt: 2, stopAt: 5, key: "toolAndInput" }],
      ["maxTurnRequests", "maxTurnRequests", { limit: 1000 }],
    ],
    turnEnd: [["retryIncomplete", "retryIncomplete", { retries: 2 }]],
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
  expect({ modelRequests: provided.modelRequests, turnEnd: provided.turnEnd, maxHolds: provided.maxHolds }).toEqual({ modelRequests: 2, turnEnd: 1, maxHolds: 2 });
});

test("CF4: a later layer that writes a plug-in empty ({}) changes none of its settings; one that writes it null puts it back to its defaults", async () => {
  const user = write("home/policies.yml", "plugins:\n  loopBreaker:\n    nudgeAt: 4\ntoolCalls: [loopBreaker]\n");
  const empty = write("project/empty.yml", "plugins:\n  loopBreaker: {}\n");
  const reset = write("project/reset.yml", "plugins:\n  loopBreaker:\n");
  expect(listed(await load([user, [empty, false]]))["toolCalls"]).toEqual([["loopBreaker", "loopBreaker", { nudgeAt: 4, stopAt: 5, key: "toolAndInput" }]]);
  expect(listed(await load([user, [reset, false]]))["toolCalls"]).toEqual([["loopBreaker", "loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }]]);
});

test("CF9: two of one plug-in, with different settings, are two names in plugins, each saying which plug-in it is (use)", async () => {
  const file = write("user/policies.yml", "plugins:\n  strict:\n    use: loopBreaker\n    stopAt: 3\n  loopBreaker:\ntoolCalls: [strict]\nmodelRequests: [loopBreaker]\n");
  expect(listed(await load([file]))).toEqual({
    toolCalls: [["strict", "loopBreaker", { nudgeAt: 3, stopAt: 3, key: "toolAndInput" }]],
    modelRequests: [["loopBreaker", "loopBreaker", { nudgeAt: 3, stopAt: 5, key: "toolAndInput" }]],
  });
});

test("CF2: what the host says, that no file does: whether anyone can be asked, which permissions reads", async () => {
  const file = write("user/policies.yml", "toolCalls: [permissions]\n");
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

test("CF3: a mistake is refused naming the layer that wrote it, where in it, and what is wrong", async () => {
  const at = (text: string) => write("user/policies.yml", text);
  expect(await refusal([at("toolCalls: [loopBraker]\n")])).toEndWith(
    'user/policies.yml: toolCalls[0]: "loopBraker" is neither in plugins nor a plug-in; the plug-ins are: loopBreaker, permissions, maxTurnRequests, retryIncomplete, maxBudget',
  );
  expect(await refusal([at("toolCalls: [maxTurnRequests]\n")])).toEndWith("toolCalls[0]: maxTurnRequests is maxTurnRequests, which is not on toolCalls; it is on modelRequests");
  expect(await refusal([at("plugins:\n  loopBreaker:\n    nudgAt: 2\n")])).toEndWith("plugins.loopBreaker.nudgAt: loopBreaker has no setting nudgAt; its settings are: nudgeAt, stopAt, key");
  expect(await refusal([at("plugins:\n  permissions:\n    mode: yolo\n")])).toEndWith(
    'plugins.permissions.mode: Expected "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" at ["mode"]',
  );
  expect(await refusal([at("plugins:\n  mine:\n    use: loopBraker\n")])).toEndWith('plugins.mine.use: "loopBraker" is not a plug-in; those are: loopBreaker, permissions, maxTurnRequests, retryIncomplete, maxBudget');
  expect(await refusal([at("toolcalls: [permissions]\n")])).toEndWith(
    "toolcalls: Not a key of the configuration; those are: plugins, toolCalls, modelRequests, turnEnd, knownModels, settling, toolSources, maxHolds, mcpServers, extensions",
  );
  expect(await refusal([at("toolCalls:\n  use: permissions\n")])).toEndWith("toolCalls: Expected a list of names, each one in plugins or a plug-in's own");
});

test("CF3: across layers, a mistake names the layer that wrote the value at fault, not the last one read", async () => {
  const user = write("home/policies.yml", "plugins:\n  strict:\n    use: loopBreaker\ntoolCalls: [strict, permissions]\n");
  const project = write("project/policies.yml", "plugins:\n  strict:\n    stopAt: 0\n");
  // The project sets one setting of the user's plug-in: it is the project's mistake.
  expect(await refusal([user, [project, false]])).toEndWith('project/policies.yml: plugins.strict.stopAt: Expected a value greater than or equal to 1 at ["stopAt"]');
  const project2 = write("project/two.yml", "maxHolds: 1\n");
  const user2 = write("home/two.yml", "toolCalls: [nobody]\n");
  expect(await refusal([user2, [project2, false]])).toContain("home/two.yml: toolCalls[0]");
});

test("CF4 CF12: layers merge in order, the last write winning: mappings key by key, deeply; any other value, a list included, replaced whole; the user's file, the project's, then the local one", async () => {
  expect(merged([{ a: { b: 1, c: [1, 2] }, d: "x" }, { a: { c: [3] }, e: true }, { d: "y" }])).toEqual({ a: { b: 1, c: [3] }, d: "y", e: true });
  const layers = await runTest(policyLayers(join(testFolder(), "project"), { home: join(testFolder(), "home") }).pipe(Effect.provide(BunServices.layer)));
  expect(layers).toEqual([]);
  // The user's own for the project comes last, and is not trusted; the sources read can be chosen.
  write("project/.labkit/policies.local.yml", "plugins:\n  maxTurnRequests:\n    limit: 20\n");
  write("home/.config/labkit/policies.yml", "plugins:\n  maxTurnRequests:\n    limit: 10\n  loopBreaker:\n    nudgeAt: 4\ntoolCalls: [loopBreaker, permissions]\nmodelRequests: [maxTurnRequests]\n");
  write("project/.labkit/policies.yml", "plugins:\n  loopBreaker:\n    stopAt: 8\ntoolCalls: [permissions]\n");
  const configuration = await runTest(
    Effect.flatMap(policyLayers(join(testFolder(), "project"), { home: join(testFolder(), "home") }), (each) => loadConfiguration(each)).pipe(Effect.provide(BunServices.layer)),
  );
  // The project's toolCalls replace the user's; the user's modelRequests stand, with the local file's limit.
  expect(listed(configuration)).toEqual({
    toolCalls: [["permissions", "permissions", { mode: "default" }]],
    modelRequests: [["maxTurnRequests", "maxTurnRequests", { limit: 20 }]],
  });
  const userOnly = await runTest(
    Effect.flatMap(policyLayers(join(testFolder(), "project"), { home: join(testFolder(), "home"), sources: ["user"] }), (each) => loadConfiguration(each)).pipe(
      Effect.provide(BunServices.layer),
    ),
  );
  expect(listed(userOnly)["modelRequests"]).toEqual([["maxTurnRequests", "maxTurnRequests", { limit: 10 }]]);
  const both = await load([write("home/a.yml", "plugins:\n  loopBreaker:\n    nudgeAt: 4\n"), [write("project/b.yml", "plugins:\n  loopBreaker:\n    stopAt: 8\ntoolCalls: [loopBreaker]\n"), false]]);
  expect(listed(both)["toolCalls"]).toEqual([["loopBreaker", "loopBreaker", { nudgeAt: 4, stopAt: 8, key: "toolAndInput" }]]);
});

test("CF4: an overlay changes part of a base, key by key: a base enabling every provider and an overlay disabling some give the rest", () => {
  const base = { providers: { anthropic: { enabled: true, models: ["opus", "sonnet"] }, openai: { enabled: true }, xai: { enabled: true } } };
  const anthropicOnly = { providers: { openai: { enabled: false }, xai: { enabled: false } } };
  expect(merged([base, anthropicOnly])).toEqual({ providers: { anthropic: { enabled: true, models: ["opus", "sonnet"] }, openai: { enabled: false }, xai: { enabled: false } } });
  // An empty layer, one that says nothing of a key, or an empty mapping, changes nothing; null is a value, and replaces.
  expect(merged([base, {}])).toEqual(base);
  expect(merged([base, { providers: {} }])).toEqual(base);
  expect(merged([{ a: { b: 1 } }, { a: null }])).toEqual({ a: null });
  expect(merged([{ a: [1, 2] }, { a: undefined }])).toEqual({ a: [1, 2] });
});

test("CF4: a value that is not a mapping cuts off what an earlier layer had under it: layers are merged in order, and the order matters", () => {
  const a = { k: { x: 1 } };
  const b = { k: 5 };
  const c = { k: { y: 2 } };
  // In order: b replaced a's mapping, and c's starts again.
  expect(merged([a, b, c])).toEqual({ k: { y: 2 } });
  // Merged the other way round, a's x would survive: the merge is a fold in order, not a grouping of any.
  expect(over(a, over(b, c))).toEqual({ k: { x: 1, y: 2 } });
});

/** Layers as parsed: mappings of a few keys, nested, each value a number, string, boolean, null, list or mapping. */
const layers = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.integer({ min: 0, max: 9 }),
    fc.constantFrom("x", "y", "z"),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 2 }),
    tie("mapping"),
  ),
  mapping: fc.dictionary(fc.constantFrom("a", "b", "c"), tie("value"), { maxKeys: 3 }),
})).mapping;

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((inner, key) => (isMapping(inner) ? inner[key] : undefined), value);

/** Every path of `value` to a value that is not a mapping. A mapping, empty or not, is merged key by key: it writes only its keys. */
const leaves = (value: unknown, path: ReadonlyArray<string> = []): ReadonlyArray<ReadonlyArray<string>> =>
  isMapping(value) ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...path, key])) : path.length === 0 ? [] : [path];

test("CF4: for any layers, each leaf of the merge is the last layer's write to its path, and no later layer replaced anything above it; every leaf of the last layer is in the merge", () => {
  fc.assert(
    fc.property(fc.array(layers, { minLength: 1, maxLength: 5 }), (written) => {
      const result = merged(written);
      for (const path of leaves(result)) {
        const writer = written.map((layer) => at(layer, path) !== undefined).lastIndexOf(true);
        expect(at(result, path)).toEqual(at(written[writer], path));
        // No layer after it wrote a value that is not a mapping above the path.
        for (const later of written.slice(writer + 1))
          for (let length = 1; length < path.length; length++) {
            const above = at(later, path.slice(0, length));
            expect(above === undefined || isMapping(above)).toBe(true);
          }
      }
      const last = written.at(-1);
      for (const path of leaves(last)) expect(at(result, path)).toEqual(at(last, path));
    }),
    { numRuns: 2000 },
  );
});

test("CF4: merging is a fold in order: a layer that writes nothing changes nothing, and merging the merge of some layers with the rest is merging them all", () => {
  fc.assert(
    fc.property(fc.array(layers, { maxLength: 5 }), fc.array(layers, { maxLength: 5 }), (before, after) => {
      expect(merged([...before, {}])).toEqual(merged(before));
      expect(merged([merged(before), ...after])).toEqual(merged([...before, ...after]));
    }),
    { numRuns: 1000 },
  );
});

test("CF5: a file that is not there is an empty layer; a seam no layer lists is not provided, so the host's own list or the default stands", async () => {
  const configuration = await load([join(testFolder(), "nowhere.yml")]);
  expect(configuration).toEqual({ lists: {}, mcpServers: [] });
  const lists = seamListsOf(configuration, { canAsk: true });
  expect(lists).toEqual({});
  const provided = Effect.gen(function* () {
    return (yield* ToolCallPolicies).length;
  });
  expect(await runTest(provided.pipe(Effect.provide(seamLayer(lists))))).toBe(0);
});

test("CF6: turn-end hooks need maxHolds, in some layer", async () => {
  const hooks = write("user/policies.yml", "turnEnd: [retryIncomplete]\n");
  expect(await refusal([hooks])).toEndWith("maxHolds: Required when turnEnd lists hooks: how many times they may hold one turn open");
  const holds = write("project/policies.yml", "maxHolds: 1\n");
  expect((await load([hooks, [holds, false]])).maxHolds).toBe(1);
});

test("CF7: an extension a trusted layer names, relative to its folder, registers the plug-ins it exports; a project's layer may not name one; a name used twice is refused", async () => {
  const extension = new URL("../../tests/support/config-extension.ts", import.meta.url).pathname;
  const file = write("user/policies.yml", `extensions:\n  - ${extension}\nplugins:\n  denyTools:\n    tools: [change]\n  permissions:\n    mode: bypassPermissions\ntoolCalls: [denyTools, permissions]\n`);
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
  const relative = write("user/relative.yml", "extensions:\n  - ./extension.ts\ntoolCalls: [denyTools]\n");
  expect(listed(await load([relative]))["toolCalls"]).toEqual([["denyTools", "denyTools", { tools: [] }]]);
  // A project's layer does not run code; a plug-in the user's extension registers it may use.
  const project = write("project/policies.yml", `extensions:\n  - ${extension}\n`);
  expect(await refusal([[project, false]])).toEndWith("project/policies.yml: extensions: Extensions are loaded only from the user's own configuration: a project's does not run code");
  const uses = write("project/uses.yml", "plugins:\n  denyTools:\n    tools: [look]\n");
  expect(listed(await load([relative, [uses, false]]))["toolCalls"]).toEqual([["denyTools", "denyTools", { tools: ["look"] }]]);
  // The same module named twice is loaded once; two modules exporting one name are refused.
  const twice = write("user/twice.yml", `extensions:\n  - ${extension}\n`);
  expect((await load([twice, twice])).lists).toEqual({});
  const clash = write("user/clash.yml", "extensions:\n  - ./extension.ts\n");
  expect(await refusal([twice, clash])).toEndWith("extensions: Two plug-ins are named denyTools");
});

test("CF10: mcpServers are servers by name, merged key by key, so a later layer of the user's can add one or change one; a project's layer may not name them, as they run commands", async () => {
  const user = write("home/policies.yml", "mcpServers:\n  github:\n    command: gh-mcp\n    args: [--read-only]\n  files:\n    command: files-mcp\n");
  const later = write("home/later.yml", "mcpServers:\n  github:\n    required: true\n    connectTimeout: 10 seconds\n  db:\n    command: db-mcp\n    env:\n      DB: local\n");
  const configuration = await load([user, later]);
  expect(configuration.mcpServers.map((server) => ({ ...server, connectTimeout: server.connectTimeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(server.connectTimeout)) }))).toEqual([
    { name: "github", command: "gh-mcp", args: ["--read-only"], env: {}, required: true, connectTimeout: 10_000 },
    { name: "files", command: "files-mcp", args: [], env: {}, required: false, connectTimeout: undefined },
    { name: "db", command: "db-mcp", args: [], env: { DB: "local" }, required: false, connectTimeout: undefined },
  ]);
  expect(await refusal([write("home/bad.yml", "mcpServers:\n  github:\n    command: gh-mcp\n    connectTimeout: soon\n")])).toEndWith(
    'mcpServers.github.connectTimeout: "soon" is not a duration, such as "30 seconds"',
  );
  expect(await refusal([user, [write("project/servers.yml", "mcpServers:\n  github:\n    command: evil\n"), false]])).toEndWith(
    "project/servers.yml: mcpServers: MCP servers are started only from the user's own configuration: a project's does not run commands",
  );
});

test("CF11: maxBudget vetoes a model request once the session has cost its usd or more; it has no default, so a list naming it needs it in plugins", async () => {
  const session = open();
  observe(session, opened);
  observe(session, { _tag: "InputArrived", from: { _tag: "User" }, text: "go" });
  // 1,000,000 output tokens of claude-sonnet-5-5: $10.
  observe(session, { _tag: "ModelResponded", turn: "turn-1", provider: "anthropic", model: "claude-sonnet-5-5", parts: [{ _tag: "Text", text: "Done." }], ending: { _tag: "Complete" }, usage: { input: 0, output: 1_000_000 }, metadata: receivedJson({}) });
  const verdict = (usd: number) =>
    runTest(
      Effect.gen(function* () {
        const configuration = yield* loadConfiguration([{ name: "test", trusted: true, value: { plugins: { maxBudget: { usd } }, modelRequests: ["maxBudget"] } }]);
        const policy = every(yield* Effect.forEach(seamListsOf(configuration, { canAsk: true }).modelRequests ?? [], (policyOf) => policyOf(session.journal)));
        return verdictOf(policy, { _tag: "RequestModelResponse", turn: TurnId.make("turn-1") });
      }),
    );
  expect(await verdict(20)).toBe("runs");
  expect(await verdict(10)).toBe('vetoed: {"stop":"max_budget_usd","usd":10,"spent":10}');
  expect(await refusal([write("user/budget.yml", "modelRequests: [maxBudget]\n")])).toContain('modelRequests[0]: Missing key at ["usd"]');
});

test("CF8: the JSON Schema of a file takes, in plugins, each plug-in's settings under its own name and use with settings under another; each seam's list takes names", () => {
  const schema = policiesJsonSchema() as {
    readonly properties: Readonly<Record<string, { readonly properties?: Readonly<Record<string, { readonly properties: Readonly<Record<string, unknown>> }>>; readonly additionalProperties?: { readonly anyOf: ReadonlyArray<{ readonly required: ReadonlyArray<string> }> }; readonly items?: unknown }>>;
    readonly additionalProperties: boolean;
  };
  expect(schema.additionalProperties).toBe(false);
  const plugins = schema.properties["plugins"];
  expect(Object.keys(plugins?.properties ?? {})).toEqual(["loopBreaker", "permissions", "maxTurnRequests", "retryIncomplete", "maxBudget"]);
  expect(Object.keys(plugins?.properties?.["loopBreaker"]?.properties ?? {})).toEqual(["nudgeAt", "stopAt", "key"]);
  expect(plugins?.additionalProperties?.anyOf.map((each) => each.required)).toEqual([["use"], ["use"], ["use"], ["use"], ["use", "usd"]]);
  expect(schema.properties["toolCalls"]?.items).toEqual({ type: "string" });
});
