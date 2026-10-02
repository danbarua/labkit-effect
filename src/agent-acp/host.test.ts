/**
 * The ACP host (`host.ts`) through the real library: `Agent.run` on in-memory pipes, driven by the
 * official SDK's v1 client (`@agentclientprotocol/sdk`), which serves the editor's `fs/*` and
 * answers permission requests. The model is scripted: a `ModelClient` that passes deltas and parts
 * to the `ModelStream` sink, as a provider adapter does, then returns the response. Sessions are
 * kept in the test's folder.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, Layer, Logger, References } from "effect";
import * as Agent from "../acp/agent.ts";
import { fromWebStreams } from "../acp/stdio.ts";
import { type CatalogSource, ModelCatalog } from "../agent-host/catalog.ts";
import { storeFileOf } from "../agent-host/directory.ts";
import { answerNow } from "../agent-host/incomplete.ts";
import { SessionServices } from "../agent-host/services.ts";
import { CallId, FailureText, Millis, ModelName, ModelText, ProviderName, ThinkingText, TokenCount, ToolName, type TurnId } from "../agent-machine/names.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { ModelPart, Observation } from "../agent-machine/observation.ts";
import { ModelClient, type Target, ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { readFacts } from "../agent-session/file-session-store.ts";
import type { Services } from "../agent-session/loop.ts";
import { ModelStream, ModelStreamInterval } from "../agent-session/model-stream.ts";
import { receivedJson, receivedText } from "../agent-session/received.ts";
import type { SessionStore } from "../agent-session/session-store.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { HostSessionServices, makeHost } from "./host.ts";
import { logKeys } from "./log-keys.ts";
import { presentFrom } from "./projection.ts";
import type { World } from "./world.ts";

const info = { name: "labkit-effect-test", version: "0.0.0" };
const clientInfo = { name: "an-sdk-client", version: "1.0.0" };

const openai = ProviderName.make("openai");
const sol = ModelName.make("gpt-6-sol");
const luna = ModelName.make("gpt-6-luna");
const catalog = (sources: ReadonlyArray<CatalogSource> = [{ provider: openai, models: [sol, luna] }]) =>
  Layer.succeed(ModelCatalog, { sources: Effect.succeed(sources) });

type Responded = Extract<Observation, { _tag: "ModelResponded" | "ModelFailed" }>;
/** One model request, scripted: what it passes on while it runs, and how it ends. */
type Reply = (turn: TurnId, target: Target) => Effect.Effect<Responded>;

type Piece =
  | { readonly _tag: "Thinking"; readonly text: string }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly call: string; readonly tool: string; readonly input: { readonly [key: string]: string | number } };

const toPart = (piece: Piece): ModelPart => {
  switch (piece._tag) {
    case "Thinking":
      return { _tag: "Thinking", text: ThinkingText.make(piece.text), received: receivedJson({ thinking: piece.text }) };
    case "Text":
      return { _tag: "Text", text: ModelText.make(piece.text) };
    case "ToolCall":
      return { _tag: "ToolCall", call: CallId.make(piece.call), tool: ToolName.make(piece.tool), input: receivedJson(piece.input) };
  }
};

/** A request answered with `pieces`: each text streamed as a delta, each tool call as a completed part, then the whole response. */
const answer =
  (...pieces: ReadonlyArray<Piece>): Reply =>
  (turn, target) =>
    Effect.gen(function* () {
      const sink = yield* ModelStream;
      for (const piece of pieces)
        yield* piece._tag === "ToolCall" ? sink({ _tag: "Part", part: toPart(piece) }) : sink({ _tag: "Delta", kind: piece._tag, text: piece.text });
      return {
        _tag: "ModelResponded",
        turn,
        provider: target.provider,
        model: target.model,
        parts: pieces.map(toPart),
        ending: { _tag: "Complete" },
        usage: { input: TokenCount.make(1200), output: TokenCount.make(40) },
        metadata: receivedJson({}),
      };
    });

/** A request that streams `text`, says it started, and waits for `release` before answering it. */
const held = (text: string, started: Deferred.Deferred<void>, release?: Deferred.Deferred<void>): Reply => (turn, target) =>
  Effect.gen(function* () {
    yield* (yield* ModelStream)({ _tag: "Delta", kind: "Text", text });
    yield* Deferred.succeed(started, undefined);
    yield* release === undefined ? Effect.never : Deferred.await(release);
    return yield* answer({ _tag: "Text", text: "" })(turn, target).pipe(Effect.map((responded) => ({ ...responded, parts: [toPart({ _tag: "Text", text })] })));
  });

const failed: Reply = (turn) =>
  Effect.succeed({ _tag: "ModelFailed", turn, failure: FailureText.make("The provider answered 529: overloaded"), error: receivedText("overloaded") });

interface Logged {
  readonly level: string;
  readonly key: unknown;
  readonly details: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** A test world: one tool, `echo` (kind read), which answers with its input. */
const echoTool: ToolSpec = { name: ToolName.make("echo"), description: "Answers with its input.", input: { type: "object" }, kind: "read", replay: "safe" };
const echoWorld: World = {
  open: () =>
    Effect.succeed({
      system: "Test.",
      tools: [echoTool],
      runner: Layer.succeed(ToolRunner, { run: (_name, input) => Effect.succeed({ _tag: "Succeeded", output: input }) }),
      present: presentFrom([echoTool]),
    }),
};

interface HostRun {
  readonly script: Array<Reply>;
  readonly targets: Array<string>;
  readonly logged: Array<Logged>;
  readonly directory: string;
  readonly cwd: string;
  /** What the client writes to the agent, and what it reads. */
  readonly stream: acp.Stream;
  /** Ends the connection: the agent reads the end of its input. */
  readonly hangUp: () => Promise<void>;
  /** Completes when `Agent.run` returns. */
  readonly ended: Promise<void>;
  readonly stop: () => Promise<unknown>;
}

/**
 * The host on in-memory pipes, with `script` answering its model requests in order. A session runs
 * with `services` (`SessionServices` when left out) and the scripted model.
 */
function startHost(
  options: {
    readonly script?: ReadonlyArray<Reply>;
    readonly world?: World;
    readonly sources?: ReadonlyArray<CatalogSource>;
    readonly services?: (runner: Layer.Layer<ToolRunner>) => Layer.Layer<Services, never, SessionStore>;
  } = {},
): HostRun {
  const script = [...(options.script ?? [])];
  const targets: Array<string> = [];
  const logged: Array<Logged> = [];
  const directory = join(testFolder(), "sessions");
  const cwd = join(testFolder(), "work");
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const writer = toAgent.writable.getWriter();
  const scripted = Layer.succeed(ModelClient, {
    respond: (target, _context, turn) =>
      Effect.suspend(() => {
        targets.push(`${target.provider}/${target.model}`);
        const reply = script.shift();
        return reply === undefined ? Effect.die(new Error("the script has no more replies")) : reply(turn, target);
      }),
  });
  const host = makeHost({
    directory,
    ...(options.world === undefined ? {} : { world: options.world }),
    services: (runner) => Layer.mergeAll((options.services ?? SessionServices)(runner), scripted, Layer.succeed(ModelStreamInterval, Millis.make(0))),
  });
  const capture = Logger.make((log) => {
    const [key, details] = Array.isArray(log.message) ? log.message : [log.message];
    logged.push({ level: log.logLevel, key, details, annotations: { ...log.fiber.getRef(References.CurrentLogAnnotations) } });
  });
  const fiber = Effect.runFork(
    Agent.run({ wire: fromWebStreams(toAgent.readable, toClient.writable), info, implementations: [host] }).pipe(
      Effect.provide(Layer.mergeAll(catalog(options.sources), BunServices.layer, Logger.layer([capture]))),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    ),
  );
  return {
    script,
    targets,
    logged,
    directory,
    cwd,
    stream: acp.ndJsonStream(new WritableStream({ write: (chunk) => writer.write(chunk) }), toClient.readable),
    hangUp: () => writer.close(),
    ended: Effect.runPromise(Fiber.await(fiber)).then(() => undefined),
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
}

type Update = acp.SessionNotification["update"];

interface ClientLog {
  readonly updates: Array<Update>;
  /** Each `fs/*` request the client served, as `method path`, with the session it named. */
  readonly files: Array<{ readonly method: string; readonly path: string; readonly sessionId: string; readonly content?: string }>;
  readonly asked: Array<acp.RequestPermissionRequest>;
  /** Each `terminal/*` request the client served, as its method and the command or terminal it named. */
  readonly terminals: Array<{ readonly method: string; readonly command?: string; readonly args?: ReadonlyArray<string>; readonly cwd?: string | null; readonly terminalId?: string }>;
}

/** How the editor's terminal runs a command: its output and exit code, or never ending. */
type Ran = { readonly output: string; readonly exitCode: number } | "runs on";

/** The SDK's client: serves `fs/*` from `contents`, answers permission with `permission`, records each update. */
function sdkClient(
  permission: (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> = () => ({
    outcome: { outcome: "selected", optionId: "allow-once" },
  }),
  contents: Readonly<Record<string, string>> = {},
  run: (command: string) => Ran = () => ({ output: "", exitCode: 0 }),
) {
  const log: ClientLog = { updates: [], files: [], asked: [], terminals: [] };
  const ran = new Map<string, Ran>();
  const app = acp
    .client({ name: "an-sdk-client" })
    .onRequest("session/request_permission", (ctx) => {
      log.asked.push(ctx.params);
      return permission(ctx.params);
    })
    .onRequest("fs/read_text_file", (ctx) => {
      log.files.push({ method: "fs/read_text_file", path: ctx.params.path, sessionId: ctx.params.sessionId });
      return { content: contents[ctx.params.path] ?? "" };
    })
    .onRequest("fs/write_text_file", (ctx) => {
      log.files.push({ method: "fs/write_text_file", path: ctx.params.path, sessionId: ctx.params.sessionId, content: ctx.params.content });
      return {};
    })
    .onRequest("terminal/create", (ctx) => {
      const terminalId = `terminal-${ran.size + 1}`;
      log.terminals.push({ method: "terminal/create", command: ctx.params.command, args: ctx.params.args ?? [], cwd: ctx.params.cwd ?? null });
      ran.set(terminalId, run(ctx.params.args?.at(-1) ?? ctx.params.command));
      return { terminalId };
    })
    .onRequest("terminal/wait_for_exit", (ctx) => {
      const result = ran.get(ctx.params.terminalId);
      return result === undefined || result === "runs on" ? new Promise<never>(() => {}) : { exitCode: result.exitCode };
    })
    .onRequest("terminal/output", (ctx) => {
      const result = ran.get(ctx.params.terminalId);
      return result === undefined || result === "runs on" ? { output: "started\n", truncated: false } : { output: result.output, truncated: false, exitStatus: { exitCode: result.exitCode } };
    })
    .onRequest("terminal/release", (ctx) => {
      log.terminals.push({ method: "terminal/release", terminalId: ctx.params.terminalId });
      return {};
    })
    .onNotification("session/update", ({ params }) => {
      log.updates.push(params.update);
    });
  return { app, log };
}

const editorCapabilities: acp.ClientCapabilities = { fs: { readTextFile: true, writeTextFile: true } };

const initialize = (ctx: acp.ClientContext, clientCapabilities: acp.ClientCapabilities = editorCapabilities) =>
  ctx.request("initialize", { protocolVersion: 1, clientCapabilities, clientInfo });

const say = (sessionId: string, text: string): acp.PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] });

const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => error as { readonly code: number; readonly message: string; readonly data?: unknown },
  );

/** A session's facts as its file keeps them, decoded. */
const factsOn = (file: string): Promise<ReadonlyArray<Fact>> =>
  Effect.runPromise(readFacts(file).pipe(Effect.map((stored) => stored.facts), Effect.provide(BunServices.layer)));

const observed = (facts: ReadonlyArray<Fact>) => facts.flatMap((fact) => (fact._tag === "Observed" ? [fact] : []));

const endings = (facts: ReadonlyArray<Fact>) =>
  facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : []));

/** Resolves once `check` holds of the session's facts: a turn's end is recorded after the prompt that cancelled it was answered. */
const eventually = async (file: string, check: (facts: ReadonlyArray<Fact>) => boolean): Promise<ReadonlyArray<Fact>> => {
  for (let tries = 0; ; tries++) {
    const facts = await factsOn(file);
    if (check(facts) || tries === 200) return facts;
    // Polls the file the store writes; nothing else signals the end of a turn whose prompt is gone.
    await Bun.sleep(10);
  }
};

const kinds = (updates: ReadonlyArray<Update>) =>
  updates.map((update) => ("status" in update && update.status !== undefined ? `${update.sessionUpdate}:${update.status}` : update.sessionUpdate));

/** The tool call the model makes in the main scenario: `write_file`, which asks permission under the default mode. */
const writeNotes = (call = "call-1"): Piece => ({ _tag: "ToolCall", call, tool: "write_file", input: { path: "notes.txt", content: "hello" } });

test("AG1: session/new answers a draft with an id and its config options, writes nothing, and announces /export only after its response", async () => {
  const host = startHost();
  const seen: Array<string> = [];
  const announced = Promise.withResolvers<void>();
  const result = await acp
    .client({ name: "an-sdk-client" })
    .onNotification("session/update", ({ params }) => {
      seen.push(`update ${params.update.sessionUpdate} for ${params.sessionId}`);
      announced.resolve();
    })
    .connectWith(host.stream, async (ctx) => {
      await initialize(ctx);
      const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
      seen.push(`response ${created.sessionId}`);
      await announced.promise;
      return created;
    });
  await host.stop();
  const options = Object.fromEntries((result.configOptions ?? []).map((option) => [option.id, option.type === "select" ? option.currentValue : undefined]));
  expect(options).toMatchObject({ model: "openai/gpt-6-sol", max_output_tokens: "32768" });
  expect(Object.keys(options)).toContain("effort");
  expect(seen).toEqual([`response ${result.sessionId}`, `update available_commands_update for ${result.sessionId}`]);
  expect(existsSync(host.directory)).toBe(false);
});

test("AG2: the first prompt opens the draft; thinking and text stream, write_file goes through the editor after the client allows it, and the turn ends end_turn after its usage", async () => {
  const host = startHost({ script: [answer({ _tag: "Thinking", text: "Plan." }, { _tag: "Text", text: "Writing." }, writeNotes()), answer({ _tag: "Text", text: "Done." })] });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const changed = await ctx.request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
    const prompted = await ctx.request("session/prompt", say(sessionId, "Write hello to notes.txt"));
    return { sessionId, changed, prompted };
  });
  await host.stop();
  const { sessionId } = result;
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(result.changed.configOptions.find((option) => option.id === "effort")).toMatchObject({ currentValue: "high" });
  expect(kinds(log.updates)).toEqual([
    "available_commands_update",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call:pending",
    "tool_call_update:pending",
    "tool_call_update:in_progress",
    "tool_call_update:completed",
    "agent_message_chunk",
    "usage_update",
  ]);
  const texts = log.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []));
  expect(texts.join("")).toBe("Writing.Done.");
  expect(log.asked).toHaveLength(1);
  expect(log.asked[0]?.toolCall).toMatchObject({ toolCallId: "call-1", title: "write_file", kind: "edit", locations: [{ path: join(host.cwd, "notes.txt") }] });
  expect(log.files).toEqual([{ method: "fs/write_text_file", path: join(host.cwd, "notes.txt"), sessionId, content: "hello" }]);
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect(facts[0]).toMatchObject({
    origin: { _tag: "User", via: "acp" },
    observation: { _tag: "SessionOpened", session: sessionId, model: { provider: "openai", model: "gpt-6-sol", settings: { effort: "high", maxOutputTokens: 32768 } } },
  });
  expect(observed(facts).find((fact) => fact.observation._tag === "PermissionAnswered")?.origin).toMatchObject({ _tag: "User", via: "acp" });
  expect(observed(facts).find((fact) => fact.observation._tag === "InputArrived")?.origin).toMatchObject({ _tag: "User", via: "acp" });
  expect(endings(facts)).toEqual(["Completed"]);
});

test("AG3: a client that answers a permission request cancelled refuses the call: the editor is not asked to write, and the turn goes on to its answer", async () => {
  const host = startHost({ script: [answer(writeNotes()), answer({ _tag: "Text", text: "I did not write it." })] });
  const { app, log } = sdkClient(() => ({ outcome: { outcome: "cancelled" } }));
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return { sessionId, prompted: await ctx.request("session/prompt", say(sessionId, "Write hello")) };
  });
  await host.stop();
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(log.files).toEqual([]);
  expect(kinds(log.updates)).toContain("tool_call_update:failed");
  expect(kinds(log.updates)).not.toContain("tool_call_update:in_progress");
  expect(host.targets).toHaveLength(2);
});

test("AG4: session/cancel during a turn ends its prompt cancelled, and the session takes the next prompt; a prompt request the client cancels cancels its turn too", async () => {
  const started = Deferred.makeUnsafe<void>();
  const startedAgain = Deferred.makeUnsafe<void>();
  const host = startHost({ script: [held("Thinking it over", started), answer({ _tag: "Text", text: "Hello." }), held("Again", startedAgain)] });
  const { app } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const first = ctx.request("session/prompt", say(sessionId, "Think"));
    await Effect.runPromise(Deferred.await(started));
    await ctx.notify("session/cancel", { sessionId });
    const cancelled = await first;
    const after = await ctx.request("session/prompt", say(sessionId, "Hi"));
    const abort = new AbortController();
    const third = failure(ctx.request("session/prompt", say(sessionId, "Again"), { cancellationSignal: abort.signal }));
    await Effect.runPromise(Deferred.await(startedAgain));
    abort.abort();
    return { sessionId, cancelled, after, aborted: await third };
  });
  const facts = await eventually(storeFileOf(host.directory, result.sessionId), (each) => endings(each).length === 3);
  await host.stop();
  expect(result.cancelled.stopReason).toBe("cancelled");
  expect(result.after.stopReason).toBe("end_turn");
  expect(result.aborted).toBeDefined();
  expect(endings(facts)).toEqual(["Interrupted", "Completed", "Interrupted"]);
  expect(host.logged.filter((each) => each.key === logKeys.cancel.requested).map((each) => each.details)).toMatchObject([
    { by: "session/cancel" },
    { by: "$/cancel_request" },
  ]);
});

test("AG5: set_config_option changes the draft; once the session is open it is ModelChangeArrived from the user through ACP, taken at the next step; a value not offered is -32602", async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const host = startHost({ script: [answer({ _tag: "Text", text: "One." }), held("Two.", started, release), answer({ _tag: "Text", text: "Three." })] });
  const { app } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/set_config_option", { sessionId, configId: "max_output_tokens", value: "16384" });
    await ctx.request("session/prompt", say(sessionId, "One"));
    const second = ctx.request("session/prompt", say(sessionId, "Two"));
    await Effect.runPromise(Deferred.await(started));
    const changed = await ctx.request("session/set_config_option", { sessionId, configId: "model", value: "openai/gpt-6-luna" });
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await second;
    await ctx.request("session/prompt", say(sessionId, "Three"));
    const refused = await failure(ctx.request("session/set_config_option", { sessionId, configId: "model", value: "openai/no-such-model" }));
    return { sessionId, changed, refused };
  });
  await host.stop();
  expect(result.changed.configOptions.find((option) => option.id === "model")).toMatchObject({ currentValue: "openai/gpt-6-luna" });
  expect(host.targets).toEqual(["openai/gpt-6-sol", "openai/gpt-6-sol", "openai/gpt-6-luna"]);
  expect(result.refused).toMatchObject({ code: -32602 });
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  expect(facts[0]).toMatchObject({ observation: { model: { settings: { maxOutputTokens: 16384 } } } });
  expect(observed(facts).find((fact) => fact.observation._tag === "ModelChangeArrived")).toMatchObject({
    origin: { _tag: "User", via: "acp" },
    observation: { provider: "openai", model: "gpt-6-luna" },
  });
});

test("AG6: /export says there is nothing to export on a draft, and on an open session writes its transcript to .labkit/exports in the working folder without asking the model", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hello there." })] });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const onDraft = await ctx.request("session/prompt", say(sessionId, "/export"));
    await ctx.request("session/prompt", say(sessionId, "Hello"));
    const exported = await ctx.request("session/prompt", say(sessionId, "/export"));
    return { sessionId, onDraft, exported };
  });
  await host.stop();
  const path = join(host.cwd, ".labkit", "exports", `${result.sessionId}.md`);
  expect(result.onDraft.stopReason).toBe("end_turn");
  expect(result.exported.stopReason).toBe("end_turn");
  expect(host.targets).toHaveLength(1);
  const said = log.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []));
  expect(said[0]).toBe("Nothing to export: this session has had no turn yet.");
  expect(said.at(-1)).toBe(`Exported this session to ${path}`);
  const markdown = readFileSync(path, "utf8");
  expect(markdown).toContain(result.sessionId);
  expect(markdown).toContain("Hello there.");
});

test("AG7: a prompt while one runs is -32000, an unknown session -32002, a relative cwd -32602, and no model to ask an error naming what to set", async () => {
  const started = Deferred.makeUnsafe<void>();
  const host = startHost({ script: [held("Busy", started)] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const first = ctx.request("session/prompt", say(sessionId, "Busy"));
    await Effect.runPromise(Deferred.await(started));
    const second = await failure(ctx.request("session/prompt", say(sessionId, "Me too")));
    await ctx.notify("session/cancel", { sessionId });
    await first;
    const unknown = await failure(ctx.request("session/prompt", say("no-such-session", "Hi")));
    const relative = await failure(ctx.request("session/new", { cwd: "work", mcpServers: [] }));
    return { second, unknown, relative };
  });
  await host.stop();
  expect(result.second).toMatchObject({ code: -32000, message: expect.stringContaining("already has an active prompt") });
  expect(result.unknown).toMatchObject({ code: -32002 });
  expect(result.relative).toMatchObject({ code: -32602 });

  const empty = startHost({ sources: [{ provider: ProviderName.make("localhost"), models: undefined }] });
  const none = await sdkClient().app.connectWith(empty.stream, async (ctx) => {
    await initialize(ctx);
    return failure(ctx.request("session/new", { cwd: empty.cwd, mcpServers: [] }));
  });
  await empty.stop();
  const said = none?.message ?? "";
  expect(said).toContain("OPENAI_API_KEY");
  expect(said).toContain("local server");
});

test("AG8: a failed model request answers the prompt with a JSON-RPC error carrying the failure, and the next prompt works", async () => {
  const host = startHost({ script: [failed, answer({ _tag: "Text", text: "Back." })] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const refused = await failure(ctx.request("session/prompt", say(sessionId, "Hi")));
    const after = await ctx.request("session/prompt", say(sessionId, "Again"));
    return { refused, after };
  });
  await host.stop();
  expect(result.refused).toMatchObject({ code: -32603, message: expect.stringContaining("529: overloaded") });
  expect(result.after.stopReason).toBe("end_turn");
});

test("AG9: a client that closes the connection mid-turn leaves the turn running in the facts, and the host returns", async () => {
  const started = Deferred.makeUnsafe<void>();
  const host = startHost({ script: [held("Halfway", started)] });
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    void failure(ctx.request("session/prompt", say(created.sessionId, "Go")));
    await Effect.runPromise(Deferred.await(started));
    await host.hangUp();
    return created.sessionId;
  });
  await host.ended;
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  const tags = observed(facts).map((fact) => fact.observation._tag);
  expect(tags).toContain("TurnStarted");
  expect(tags).not.toContain("TurnInterrupted");
  expect(endings(facts)).toEqual([]);
  expect(host.logged.find((each) => each.key === logKeys.prompt.interrupted)).toMatchObject({ details: { by: "the end of the connection" } });
});

test("AG17: edit_file replaces one occurrence through fs/*; run_command runs in the editor's terminal, released however it ends; both ask first", async () => {
  const host = startHost({
    script: [
      answer(
        { _tag: "ToolCall", call: "edit-1", tool: "edit_file", input: { path: "a.txt", old_text: "alpha", new_text: "beta" } },
        { _tag: "ToolCall", call: "edit-2", tool: "edit_file", input: { path: "a.txt", old_text: "a", new_text: "b" } },
        { _tag: "ToolCall", call: "run-1", tool: "run_command", input: { command: "ls" } },
        { _tag: "ToolCall", call: "run-2", tool: "run_command", input: { command: "false" } },
        { _tag: "ToolCall", call: "run-3", tool: "run_command", input: { command: "sleep 100", timeout_seconds: 1 } },
      ),
      answer({ _tag: "Text", text: "Done." }),
    ],
  });
  const commands: Readonly<Record<string, Ran>> = { ls: { output: "a.txt\n", exitCode: 0 }, false: { output: "", exitCode: 1 }, "sleep 100": "runs on" };
  const { app, log } = sdkClient(undefined, { [join(testFolder(), "work", "a.txt")]: "alpha and a" }, (command) => commands[command] ?? { output: "", exitCode: 127 });
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Edit and run"));
    return created.sessionId;
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toEqual(["read_file", "write_file", "edit_file", "run_command"]);
  // The default permission mode asks before an edit and before a command.
  expect(log.asked).toHaveLength(5);
  expect(log.files.filter((each) => each.method === "fs/write_text_file")).toEqual([
    { method: "fs/write_text_file", path: join(host.cwd, "a.txt"), sessionId, content: "beta and a" },
  ]);
  expect(log.terminals.filter((each) => each.method === "terminal/create")).toEqual(
    ["ls", "false", "sleep 100"].map((command) => ({ method: "terminal/create", command: "/bin/sh", args: ["-c", command], cwd: host.cwd })),
  );
  expect(log.terminals.filter((each) => each.method === "terminal/release")).toHaveLength(3);
  const ended = new Map(observed(facts).flatMap((fact) => (fact.observation._tag === "ToolEnded" ? [[fact.observation.call as string, fact.observation.outcome] as const] : [])));
  const text = (call: string) => JSON.stringify(ended.get(call));
  expect(ended.get("edit-1")).toMatchObject({ _tag: "Succeeded" });
  // The edit read the file as the editor had it before the first edit's write: "a" occurs more than once.
  expect(ended.get("edit-2")).toMatchObject({ _tag: "Failed", reason: { _tag: "InputRejected" } });
  expect(ended.get("run-1")).toMatchObject({ _tag: "Succeeded" });
  expect(text("run-1")).toContain("a.txt\\n[Exit code 0.]");
  expect(ended.get("run-2")).toMatchObject({ _tag: "Failed", reason: { _tag: "Reported" } });
  expect(text("run-2")).toContain("[Exit code 1.]");
  expect(text("run-3")).toContain("started\\n[Still running after 1 seconds: stopped.]");
});

test("AG10: the editor world offers read_file and write_file as the client advertised fs; read_file reads through fs/read_text_file, a path outside the working folder is refused, and a client with no fs has no tools", async () => {
  const host = startHost({
    script: [
      answer({ _tag: "ToolCall", call: "read-1", tool: "read_file", input: { path: "a.txt" } }, { _tag: "ToolCall", call: "read-2", tool: "read_file", input: { path: "../outside.txt" } }),
      answer({ _tag: "Text", text: "Read." }),
    ],
  });
  const { app, log } = sdkClient(undefined, { [join(testFolder(), "work", "a.txt")]: "alpha" });
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, { fs: { readTextFile: true } });
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Read a.txt"));
    return created.sessionId;
  });
  await host.stop();
  expect(log.asked).toEqual([]);
  expect(log.files).toEqual([{ method: "fs/read_text_file", path: join(host.cwd, "a.txt"), sessionId }]);
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toEqual(["read_file"]);
  const ended = observed(facts).flatMap((fact) => (fact.observation._tag === "ToolEnded" ? [fact.observation] : []));
  expect(ended).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ call: "read-1", outcome: expect.objectContaining({ _tag: "Succeeded", output: expect.objectContaining({ body: { _tag: "Text", text: "alpha" } }) }) }),
      expect.objectContaining({ call: "read-2", outcome: { _tag: "Failed", reason: expect.objectContaining({ _tag: "InputRejected" }) } }),
    ]),
  );

  const bare = startHost({ script: [answer({ _tag: "Text", text: "No tools." })] });
  const bareSession = await sdkClient().app.connectWith(bare.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: bare.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Hi"));
    return created.sessionId;
  });
  await bare.stop();
  expect(await Effect.runPromise(immutableToolCatalogOf(await factsOn(storeFileOf(bare.directory, bareSession))))).toEqual([]);
});

test("AG3 AG11: each lifecycle point logs its event with the connection, request, session, turn and call it is about; a routine turn logs no warning, and a failure says what failed and why", async () => {
  const host = startHost({ script: [answer(writeNotes()), answer({ _tag: "Text", text: "Done." })] });
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/set_config_option", { sessionId: created.sessionId, configId: "effort", value: "low" });
    await ctx.request("session/prompt", say(created.sessionId, "Write"));
    return created.sessionId;
  });
  await host.stop();
  const of = (key: string) => host.logged.find((each) => each.key === key);
  expect(host.logged.filter((each) => each.level === "Warn" || each.level === "Error" || each.level === "Fatal")).toEqual([]);
  expect(of(logKeys.session.created)).toMatchObject({
    level: "Info",
    annotations: { session: sessionId, connection: expect.any(String) },
    details: { model: "openai/gpt-6-sol", tools: ["read_file", "write_file", "edit_file"] },
  });
  expect(of(logKeys.config.changed)).toMatchObject({ annotations: { session: sessionId }, details: { configId: "effort", value: "low", applies: "to the draft" } });
  expect(of(logKeys.session.opened)).toMatchObject({ annotations: { session: sessionId, request: expect.anything() } });
  expect(of(logKeys.prompt.received)).toMatchObject({ annotations: { session: sessionId, request: expect.anything() }, details: { blocks: ["text"] } });
  expect(of(logKeys.prompt.admitted)).toMatchObject({ annotations: { session: sessionId } });
  expect(of(logKeys.permission.asked)).toMatchObject({ annotations: { session: sessionId, call: "call-1", turn: expect.any(String) }, details: { tool: "write_file" } });
  expect(of(logKeys.permission.answered)).toMatchObject({ annotations: { call: "call-1" }, details: { outcome: "selected", option: "allow-once" } });
  expect(of(logKeys.usage.sent)).toMatchObject({ details: { used: expect.any(Number), size: expect.any(Number) } });
  expect(of(logKeys.prompt.settled)).toMatchObject({
    level: "Info",
    annotations: { session: sessionId, turn: expect.any(String) },
    details: { stopReason: "end_turn", ms: expect.any(Number) },
  });

  const failing = startHost({ script: [answer(writeNotes()), failed] });
  const fellOver = sdkClient(() => Promise.reject(new Error("the editor fell over")));
  await fellOver.app.connectWith(failing.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId: failingSession } = await ctx.request("session/new", { cwd: failing.cwd, mcpServers: [] });
    await failure(ctx.request("session/prompt", say(failingSession, "Write")));
  });
  await failing.stop();
  expect(fellOver.log.files).toEqual([]);
  expect(failing.logged.find((each) => each.key === logKeys.permission.failed)).toMatchObject({
    level: "Warn",
    annotations: { call: "call-1" },
    details: { doing: "asking the client session/request_permission", answer: "reject_once", cause: expect.stringMatching(/\S/) },
  });
  expect(failing.logged.find((each) => each.key === logKeys.prompt.settled)).toMatchObject({
    level: "Warn",
    annotations: { turn: expect.any(String) },
    details: { error: expect.stringContaining("529: overloaded"), code: -32603 },
  });
});

test("AG12: a world of the host's own gives the session its system prompt, tools, runner and presentation", async () => {
  const host = startHost({ world: echoWorld, script: [answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "ping" } }), answer({ _tag: "Text", text: "Echoed." })] });
  const { app, log } = sdkClient();
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Echo"));
    return created.sessionId;
  });
  await host.stop();
  const completed = log.updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
  expect(completed).toMatchObject({ toolCallId: "echo-1", content: [{ type: "content", content: { type: "text", text: '{"say":"ping"}' } }] });
  expect((await factsOn(storeFileOf(host.directory, sessionId)))[0]).toMatchObject({ observation: { system: { body: { text: "Test." } } } });
  expect(readdirSync(host.directory)).toEqual([sessionId]);
});

test("AG13: session/close stops the turn under way, whose prompt ends cancelled, closes the session, and a later request naming it is -32002", async () => {
  const started = Deferred.makeUnsafe<void>();
  const host = startHost({ script: [held("Working", started)] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const prompted = ctx.request("session/prompt", say(sessionId, "Work"));
    await Effect.runPromise(Deferred.await(started));
    const closed = await ctx.request("session/close", { sessionId });
    return { sessionId, closed, prompted: await prompted, after: await failure(ctx.request("session/prompt", say(sessionId, "Again"))) };
  });
  await host.stop();
  expect(result.closed).toEqual({});
  expect(result.prompted.stopReason).toBe("cancelled");
  expect(result.after).toMatchObject({ code: -32002 });
  expect(endings(await factsOn(storeFileOf(host.directory, result.sessionId)))).toEqual(["Interrupted"]);
});

test("AG16: by default a response after a tool call with thinking but no answer is asked again; the client gets the answer, not the feedback, and end_turn", async () => {
  const host = startHost({
    world: echoWorld,
    services: HostSessionServices,
    script: [
      answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "4" } }),
      answer({ _tag: "Thinking", text: "The echo said 4, so the answer is 4." }),
      answer({ _tag: "Text", text: "It is 4." }),
    ],
  });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return { sessionId, prompted: await ctx.request("session/prompt", say(sessionId, "What is 2 + 2? Echo it first.")) };
  });
  await host.stop();
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(kinds(log.updates)).toEqual([
    "available_commands_update",
    "tool_call:pending",
    "tool_call_update:in_progress",
    "tool_call_update:completed",
    "agent_thought_chunk",
    "agent_message_chunk",
    "usage_update",
  ]);
  const texts = log.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []));
  expect(texts).toEqual(["It is 4."]);
  expect(JSON.stringify(log.updates)).not.toContain(answerNow);
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  expect(observed(facts).filter((fact) => fact.observation._tag === "InputArrived" && fact.observation.from._tag === "System")).toHaveLength(1);
  expect(endings(facts)).toEqual(["Completed"]);
  // A retry that answered is routine: the loop's holds do not run out, so it warns of nothing.
  expect(host.logged.filter((each) => each.level === "Warn" || each.level === "Error" || each.level === "Fatal")).toEqual([]);
});

test("AG16: a turn whose retry has no answer either ends end_turn after one retry, with no answer message", async () => {
  const host = startHost({
    world: echoWorld,
    services: HostSessionServices,
    script: [
      answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "4" } }),
      answer({ _tag: "Thinking", text: "The answer is 4." }),
      answer({ _tag: "Thinking", text: "Still 4." }),
    ],
  });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return { sessionId, prompted: await ctx.request("session/prompt", say(sessionId, "What is 2 + 2? Echo it first.")) };
  });
  await host.stop();
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(host.targets).toHaveLength(3);
  expect(kinds(log.updates).filter((kind) => kind === "agent_message_chunk")).toEqual([]);
  expect(kinds(log.updates).filter((kind) => kind === "agent_thought_chunk")).toHaveLength(2);
  expect(endings(await factsOn(storeFileOf(host.directory, result.sessionId)))).toEqual(["Incomplete"]);
});
