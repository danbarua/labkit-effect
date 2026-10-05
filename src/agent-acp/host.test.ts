/**
 * The ACP host (`host.ts`) through the real library: `Agent.run` on in-memory pipes, driven by the
 * official SDK's v1 client (`@agentclientprotocol/sdk`), which serves the editor's `fs/*` and
 * answers permission requests. The model is scripted: a `ModelClient` that passes deltas and parts
 * to the `ModelStream` sink, as a provider adapter does, then returns the response. Sessions are
 * kept in the test's folder.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, Layer, Logger, References } from "effect";
import * as Agent from "effective-acp/agent";
import { fromWebStreams } from "effective-acp/stdio";
import type { Brand } from "../agent-host/brand.ts";
import type { ConfigFlags } from "../agent-host/launch.ts";
import type { Environment } from "../agent-process/environment.ts";
import { type CatalogSource, ModelCatalog } from "../agent-host/catalog.ts";
import { sessionFolderOf, storeFileOf } from "../agent-host/directory.ts";
import { startFakeHttpServer } from "../../tests/support/mcp-http-server.ts";
import { answerNow } from "../agent-host/incomplete.ts";
import { SessionServices } from "../agent-host/services.ts";
import { CallId, FailureText, Millis, ModelName, ModelText, ProviderName, ThinkingText, TokenCount, ToolName, type TurnId } from "../agent-machine/names.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { ModelPart, Observation, ToolOutcome } from "../agent-machine/observation.ts";
import { ModelClient, type ModelContext, type Target, ToolRunner, type ToolSpec } from "../agent-session/contracts.ts";
import { immutableToolCatalogOf } from "../agent-session/configuration/session-setup.ts";
import { readFacts } from "../agent-session/file-session-store.ts";
import type { Services } from "../agent-session/loop.ts";
import { ModelStream, ModelStreamInterval } from "../agent-session/model-stream.ts";
import { asText, receivedJson, receivedText } from "../agent-session/received.ts";
import type { SessionStore } from "../agent-session/session-store.ts";
import { logKeys as mcpLogKeys } from "../agent-mcp/log-keys.ts";
import { test, testFolder } from "../../tests/support/test.ts";
import { makeHost } from "./host.ts";
import { logKeys } from "./log-keys.ts";
import { presentFrom, project } from "./projection.ts";
import { maxFileBytes, type World } from "./world.ts";

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

/** A request that passes on `call` as a completed part, says it started, waits for `release`, then answers with the call. */
const heldCall = (call: Extract<Piece, { _tag: "ToolCall" }>, started: Deferred.Deferred<void>, release: Deferred.Deferred<void>): Reply => (turn, target) =>
  Effect.gen(function* () {
    yield* (yield* ModelStream)({ _tag: "Part", part: toPart(call) });
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(release);
    return yield* answer(call)(turn, target);
  });

/** A request that passes on `call` as a completed part, says it started, and never answers. */
const heldAfterCall = (call: Extract<Piece, { _tag: "ToolCall" }>, started: Deferred.Deferred<void>): Reply => () =>
  Effect.gen(function* () {
    yield* (yield* ModelStream)({ _tag: "Part", part: toPart(call) });
    yield* Deferred.succeed(started, undefined);
    return yield* Effect.never;
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
      sources: [{ tools: [echoTool], run: (_name, input) => Effect.succeed({ _tag: "Succeeded", output: input }) }],
      present: presentFrom([echoTool]),
    }),
};

interface HostRun {
  readonly script: Array<Reply>;
  readonly targets: Array<string>;
  /** What each model request was sent, in order. */
  readonly contexts: Array<ModelContext>;
  readonly logged: Array<Logged>;
  readonly directory: string;
  readonly cwd: string;
  /** What the client writes to the agent, and what it reads. */
  readonly stream: acp.Stream;
  /** Every message the agent wrote, as JSON, in the order it wrote them: what the client's own handlers may see a tick later. */
  readonly wire: Array<Record<string, unknown>>;
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
    readonly world?: "editor" | "local" | World;
    readonly sources?: ReadonlyArray<CatalogSource>;
    readonly services?: (runner: Layer.Layer<ToolRunner>) => Layer.Layer<Services, never, SessionStore>;
    readonly pageSize?: number;
    readonly maxTurnRequests?: number;
    readonly brand?: Brand;
    /** How many times a turn with thinking and no answer is asked again; 0 (no turn-end hook) when left out, and the host's own default when "the host's default". */
    readonly retries?: number | "the host's default";
    readonly strictToolInput?: boolean;
    readonly configFlags?: ConfigFlags;
  } = {},
): HostRun {
  const script = [...(options.script ?? [])];
  const targets: Array<string> = [];
  const contexts: Array<ModelContext> = [];
  const logged: Array<Logged> = [];
  const directory = join(testFolder(), "sessions");
  const cwd = join(testFolder(), "work");
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const [toSdk, tapped] = toClient.readable.tee();
  const wire: Array<Record<string, unknown>> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of tapped) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") wire.push(JSON.parse(line) as Record<string, unknown>);
    }
  })();
  const writer = toAgent.writable.getWriter();
  const scripted = Layer.succeed(ModelClient, {
    respond: (target, context, turn) =>
      Effect.suspend(() => {
        targets.push(`${target.provider}/${target.model}`);
        contexts.push(context);
        const reply = script.shift();
        return reply === undefined ? Effect.die(new Error("the script has no more replies")) : reply(turn, target);
      }),
  });
  const host = makeHost({
    directory,
    ...(options.world === undefined ? {} : { world: options.world }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.maxTurnRequests === undefined ? {} : { maxTurnRequests: options.maxTurnRequests }),
    ...(options.brand === undefined ? {} : { brand: options.brand }),
    ...(options.configFlags === undefined ? {} : { configFlags: options.configFlags }),
    ...(options.retries === "the host's default" ? {} : { retries: options.retries ?? 0 }),
    ...(options.strictToolInput === undefined ? {} : { strictToolInput: options.strictToolInput }),
    // The user's file is the test's own, not the machine's.
    home: join(testFolder(), "home"),
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
    contexts,
    logged,
    directory,
    cwd,
    stream: acp.ndJsonStream(new WritableStream({ write: (chunk) => writer.write(chunk) }), toSdk),
    wire,
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

/**
 * The SDK's client: serves `fs/*` from `contents`, answers permission with `permission`, records each update. `until(check)`
 * resolves once `check` holds of the updates recorded: the host's updates after an answer come once it is written.
 */
function sdkClient(
  permission: (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse> = () => ({
    outcome: { outcome: "selected", optionId: "allow-once" },
  }),
  contents: Readonly<Record<string, string>> = {},
  run: (command: string) => Ran = () => ({ output: "", exitCode: 0 }),
) {
  const log: ClientLog = { updates: [], files: [], asked: [], terminals: [] };
  const ran = new Map<string, Ran>();
  const waiting: Array<{ readonly check: (updates: ReadonlyArray<Update>) => boolean; readonly resolve: () => void }> = [];
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
      // Named by its command: calls run at once, so the order terminals are made in is not fixed.
      const terminalId = `terminal ${ctx.params.args?.at(-1) ?? ctx.params.command}`;
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
      for (const waiter of waiting.filter((each) => each.check(log.updates))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
    });

  const until = (check: (updates: ReadonlyArray<Update>) => boolean): Promise<void> => {
    if (check(log.updates)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.push({ check, resolve });
    return promise;
  };

  return { app, log, until };
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

test("session/new answers a draft with an id and its config options, writes nothing, and announces /export only after its response", async () => {
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

test("the first prompt opens the draft; thinking and text stream, write_file goes through the editor after the client allows it, and the prompt answers end_turn after usage_update", async () => {
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
    "config_option_update",
    "session_info_update",
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
  expect(log.asked[0]?.toolCall).toMatchObject({ toolCallId: "call-1", title: "write_file: notes.txt", kind: "edit", locations: [{ path: join(host.cwd, "notes.txt") }] });
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

test("a client that answers a permission request cancelled refuses the call: the editor is not asked to write, and the turn goes on to its answer", async () => {
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

test("session/cancel during a turn ends its prompt cancelled, and the session takes the next prompt; a prompt request the client cancels cancels its turn too", async () => {
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

test("a prompt's image and embedded file are attached to the input, their bytes in the session's folder", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Seen." })] });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [
        { type: "text", text: "What are these?" },
        { type: "image", data: png.toString("base64"), mimeType: "image/png", uri: "file:///tmp/shot.png" },
        { type: "resource", resource: { uri: "file:///work/notes.md", text: "# Notes", mimeType: "text/markdown" } },
        { type: "resource_link", uri: "file:///work/a.ts", name: "a.ts" },
      ],
    });
    return created.sessionId;
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  const input = observed(facts).find((fact) => fact.observation._tag === "InputArrived")?.observation;
  expect(input).toMatchObject({
    text: "What are these?\n[a.ts](file:///work/a.ts)",
    attachments: [
      { mediaType: "image/png", size: png.byteLength, name: "shot.png" },
      { mediaType: "text/markdown", size: 7, name: "notes.md" },
    ],
  });
  const attached = input !== undefined && input._tag === "InputArrived" ? (input.attachments ?? []) : [];
  for (const blob of attached) expect(await Bun.file(join(host.directory, sessionId, "blobs", blob.id)).exists()).toBe(true);
});

test("update_plan sends the whole plan to the editor as a plan update, without asking", async () => {
  const entries = [
    { content: "Read the tests", status: "completed" },
    { content: "Fix the bug", status: "in_progress", priority: "high" },
  ];
  const host = startHost({ script: [answer({ _tag: "ToolCall", call: "plan-1", tool: "update_plan", input: { entries } as never }), answer({ _tag: "Text", text: "Planned." })] });
  const { app, log } = sdkClient();
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Plan it"));
    return created.sessionId;
  });
  await host.stop();
  expect(log.asked).toEqual([]);
  expect(log.updates).toContainEqual({
    sessionUpdate: "plan",
    entries: [
      { content: "Read the tests", status: "completed", priority: "medium" },
      { content: "Fix the bug", status: "in_progress", priority: "high" },
    ],
  });
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect(observed(facts).find((fact) => fact.observation._tag === "ToolEnded")?.observation).toMatchObject({
    call: "plan-1",
    outcome: { _tag: "Succeeded", output: { body: { text: "The plan has 2 steps: 1 completed, 1 in progress, 0 pending." } } },
  });
});

test("the permission mode is an option of category mode; changed between turns, it applies at once: a write runs without asking, then is asked about again", async () => {
  const write = (call: string) => answer({ _tag: "ToolCall", call, tool: "write_file", input: { path: "a.txt", content: call } });
  const host = startHost({ script: [write("w-1"), answer({ _tag: "Text", text: "One." }), write("w-2"), answer({ _tag: "Text", text: "Two." })] });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const sessionId = created.sessionId;
    const changed = await ctx.request("session/set_config_option", { sessionId, configId: "permission_mode", value: "bypassPermissions" });
    await ctx.request("session/prompt", say(sessionId, "Write one"));
    await ctx.request("session/set_config_option", { sessionId, configId: "permission_mode", value: "default" });
    await ctx.request("session/prompt", say(sessionId, "Write two"));
    const refused = await failure(ctx.request("session/set_config_option", { sessionId, configId: "permission_mode", value: "plan" }));
    return { created, changed, refused };
  });
  await host.stop();
  const option = (options: ReadonlyArray<acp.SessionConfigOption> | null | undefined) => options?.find((each) => each.id === "permission_mode");
  expect(option(result.created.configOptions)).toMatchObject({ category: "mode", currentValue: "default" });
  expect(option(result.changed.configOptions)).toMatchObject({ currentValue: "bypassPermissions" });
  // Each accepted change is sent as an update too, every option as it now is; the refused one is not.
  const sent = log.updates.flatMap((update) => (update.sessionUpdate === "config_option_update" ? [option(update.configOptions)?.currentValue] : []));
  expect(sent).toEqual(["bypassPermissions", "default"]);
  expect(log.asked.map((asked) => asked.toolCall.toolCallId)).toEqual(["w-2"]);
  expect(log.files.filter((each) => each.method === "fs/write_text_file").map((each) => each.content)).toEqual(["w-1", "w-2"]);
  expect(result.refused).toMatchObject({ code: -32602 });
});

test("set_config_option changes the draft; once the session is open it is ModelChangeArrived from the user through ACP, held while a turn runs and made when it ends; a value not offered is -32602", async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  // The second turn takes two steps: a tool call, then its answer. The change made during its first step waits for its end.
  const host = startHost({
    world: echoWorld,
    script: [
      answer({ _tag: "Text", text: "One." }),
      heldCall({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "2" } }, started, release),
      answer({ _tag: "Text", text: "Two." }),
      answer({ _tag: "Text", text: "Three." }),
    ],
  });
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
  // The answer shows the change held, as the next turn will run.
  expect(result.changed.configOptions.find((option) => option.id === "model")).toMatchObject({ currentValue: "openai/gpt-6-luna" });
  expect(host.targets).toEqual(["openai/gpt-6-sol", "openai/gpt-6-sol", "openai/gpt-6-sol", "openai/gpt-6-luna"]);
  expect(result.refused).toMatchObject({ code: -32602 });
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  expect(facts[0]).toMatchObject({ observation: { model: { settings: { maxOutputTokens: 16384 } } } });
  expect(observed(facts).find((fact) => fact.observation._tag === "ModelChangeArrived")).toMatchObject({
    origin: { _tag: "User", via: "acp" },
    observation: { provider: "openai", model: "gpt-6-luna" },
  });
});

test("/export says there is nothing to export on a draft, and on an open session writes its transcript to .labkit/exports in the working folder without asking the model", async () => {
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

test("a prompt while one runs is -32000, an unknown session -32002, a relative cwd -32602, and no model to ask an error naming what to set", async () => {
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

test("a failed model request answers the prompt with a JSON-RPC error carrying the failure, and the next prompt works", async () => {
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

test("a client that closes the connection mid-turn leaves the turn running in the facts, and the host returns", async () => {
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

test("edit_file replaces one occurrence through fs/*, shown as a diff; run_command runs in the editor's terminal, shown in its call, released however it ends; both ask first", async () => {
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
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toEqual(["read_file", "write_file", "edit_file", "update_plan", "run_command"]);
  // The default permission mode asks before an edit and before a command.
  expect(log.asked).toHaveLength(5);
  expect(log.files.filter((each) => each.method === "fs/write_text_file")).toEqual([
    { method: "fs/write_text_file", path: join(host.cwd, "a.txt"), sessionId, content: "beta and a" },
  ]);
  // The calls run at once, each when its permission is answered: their terminals in any order.
  const created = log.terminals.filter((each) => each.method === "terminal/create");
  expect(created).toHaveLength(3);
  expect(created).toEqual(
    expect.arrayContaining(["ls", "false", "sleep 100"].map((command) => ({ method: "terminal/create", command: "/bin/sh", args: ["-c", command], cwd: host.cwd }))),
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
  // The edit's change is shown as a diff when permission is asked; a command's terminal is shown in
  // its call once it has one, and still when it has ended.
  // A call's title names its command or its path, so the question says what it asks about.
  expect(log.asked.find((asked) => asked.toolCall.toolCallId === "run-1")?.toolCall.title).toBe("run_command: ls");
  expect(log.asked.find((asked) => asked.toolCall.toolCallId === "edit-1")?.toolCall.title).toBe("edit_file: a.txt");
  expect(log.asked.find((asked) => asked.toolCall.toolCallId === "edit-1")?.toolCall.content).toEqual([
    { type: "diff", path: join(host.cwd, "a.txt"), oldText: "alpha", newText: "beta" },
  ]);
  const runUpdates = log.updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === "run-1");
  expect(runUpdates.filter((update) => "content" in update && update.content !== undefined).map((update) => ("content" in update ? update.content : undefined))).toEqual([
    [{ type: "terminal", terminalId: "terminal ls" }],
    [{ type: "terminal", terminalId: "terminal ls" }],
  ]);
});

test("the editor world offers read_file and write_file as the client advertised fs; read_file reads through fs/read_text_file, a path outside the working folder is refused, and a client with no fs has no file tools", async () => {
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
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toEqual(["read_file", "update_plan"]);
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
  // A client with no fs and no terminal has only the plan.
  expect((await Effect.runPromise(immutableToolCatalogOf(await factsOn(storeFileOf(bare.directory, bareSession))))).map((tool): string => tool.name)).toEqual(["update_plan"]);
});

test("each lifecycle point logs its event with the connection, request, session, turn and call it is about; a routine turn logs no warning, and a failure says what failed and why", async () => {
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
    details: { model: "openai/gpt-6-sol", tools: ["read_file", "write_file", "edit_file", "update_plan"] },
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

test("a world of the host's own gives the session its system prompt, tools, runner and presentation", async () => {
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

test("session/close stops the turn under way, whose prompt ends cancelled, closes the session, and a later request naming it is -32002", async () => {
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

test("a turn that would make more model requests than maxTurnRequests ends with max_turn_requests", async () => {
  const host = startHost({
    world: echoWorld,
    maxTurnRequests: 2,
    script: [
      answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "1" } }),
      answer({ _tag: "ToolCall", call: "echo-2", tool: "echo", input: { say: "2" } }),
      answer({ _tag: "Text", text: "Never asked for." }),
    ],
  });
  const { app } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return { sessionId, prompted: await ctx.request("session/prompt", say(sessionId, "Echo forever.")) };
  });
  await host.stop();
  expect(result.prompted.stopReason).toBe("max_turn_requests");
  expect(host.targets).toHaveLength(2);
  expect(endings(await factsOn(storeFileOf(host.directory, result.sessionId)))).toEqual(["Vetoed"]);
});

/** The test MCP server (`tests/support/mcp-server.ts`), as a client names it in `session/new`. */
const fakeMcp = (name: string): acp.McpServer => ({ name, command: process.execPath, args: [new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname], env: [] });

test("the MCP servers a client names are started; their tools are offered after the world's, under mcp__<server>; a call runs on the server and is shown with its result as text; the session records each server's state once it opens", async () => {
  const host = startHost({
    world: echoWorld,
    script: [answer({ _tag: "ToolCall", call: "m-1", tool: "mcp__fake__echo", input: { message: "hi" } }), answer({ _tag: "Text", text: "Done." })],
  });
  const { app, log } = sdkClient();
  // The server runs in the session's working folder.
  mkdirSync(host.cwd, { recursive: true });
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [fakeMcp("fake")] });
    return { sessionId, prompted: await ctx.request("session/prompt", say(sessionId, "Echo hi.")) };
  });
  await host.stop();
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(host.contexts[0]?.tools.map((tool) => tool.name as string)).toEqual(["echo", "mcp__fake__echo", "mcp__fake__roots", "mcp__fake__slow"]);
  const completed = log.updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
  expect(completed).toMatchObject({ toolCallId: "m-1", content: [{ type: "content", content: { type: "text", text: "hi" } }] });
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  const changed = observed(facts).filter((fact) => fact.observation._tag === "McpServerChanged");
  expect(changed.map((fact) => [fact.origin, fact.observation]) as unknown).toEqual([
    [{ _tag: "Harness", part: "mcp servers" }, { _tag: "McpServerChanged", server: "fake", state: { _tag: "Ready", tools: ["mcp__fake__echo", "mcp__fake__roots", "mcp__fake__slow"] } }],
  ]);
  expect(facts[0]).toMatchObject({ observation: { _tag: "SessionOpened" } });
});

test("a server at a URL the client names is connected over Streamable HTTP or HTTP+SSE: its tools are offered, a call runs on it, and closing the session ends its session", async () => {
  const web = startFakeHttpServer({ transport: "http", auth: { token: "t-1" } });
  const legacy = startFakeHttpServer({ transport: "sse" });
  const host = startHost({
    world: echoWorld,
    script: [answer({ _tag: "ToolCall", call: "w-1", tool: "mcp__web__echo", input: { message: "over http" } }), answer({ _tag: "Text", text: "Done." })],
  });
  const { app, log } = sdkClient();
  try {
    const result = await app.connectWith(host.stream, async (ctx) => {
      await initialize(ctx, {});
      const { sessionId } = await ctx.request("session/new", {
        cwd: host.cwd,
        mcpServers: [
          { type: "http", name: "web", url: web.url, headers: [{ name: "Authorization", value: "Bearer t-1" }] },
          { type: "sse", name: "legacy", url: legacy.url, headers: [] },
        ],
      });
      const prompted = await ctx.request("session/prompt", say(sessionId, "Echo over http."));
      await ctx.request("session/close", { sessionId });
      // Closing the session, not the end of the connection, ends its session at the server.
      for (let tries = 0; web.deleted.length === 0 && tries < 100; tries++) await Bun.sleep(10);
      return { prompted, deletedAtClose: web.deleted.length };
    });
    await host.stop();
    expect(result.prompted.stopReason).toBe("end_turn");
    expect(host.contexts[0]?.tools.map((tool) => tool.name as string)).toEqual([
      "echo",
      "mcp__web__echo",
      "mcp__web__roots",
      "mcp__web__slow",
      "mcp__legacy__echo",
      "mcp__legacy__roots",
      "mcp__legacy__slow",
    ]);
    const completed = log.updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
    expect(completed).toMatchObject({ toolCallId: "w-1", content: [{ type: "content", content: { type: "text", text: "over http" } }] });
    expect(result.deletedAtClose).toBe(1);
  } finally {
    web.stop();
    legacy.stop();
  }
});

test("the host goes by its brand: /export writes to .acme/exports, an MCP server is told its name, and with no model to ask it names ACME_ACP_MODEL", async () => {
  const acme = { name: "acme", version: "1.0.0" };
  const host = startHost({ brand: acme, script: [answer({ _tag: "Text", text: "Hello there." })] });
  const { app, log } = sdkClient();
  mkdirSync(host.cwd, { recursive: true });
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [fakeMcp("fake")] });
    await ctx.request("session/prompt", say(sessionId, "Hello"));
    await ctx.request("session/prompt", say(sessionId, "/export"));
    return sessionId;
  });
  await host.stop();
  const path = join(host.cwd, ".acme", "exports", `${sessionId}.md`);
  const said = log.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []));
  expect(said.at(-1)).toBe(`Exported this session to ${path}`);
  expect(existsSync(path)).toBe(true);
  const serverSaid = host.logged.filter((each) => each.key === mcpLogKeys.server.logged).map((each) => (each.details as { readonly data?: unknown }).data);
  expect(serverSaid).toContain("initialized by acme 1.0.0");

  const empty = startHost({ brand: acme, sources: [{ provider: ProviderName.make("localhost"), models: undefined }] });
  const none = await sdkClient().app.connectWith(empty.stream, async (ctx) => {
    await initialize(ctx);
    return failure(ctx.request("session/new", { cwd: empty.cwd, mcpServers: [] }));
  });
  await empty.stop();
  expect(none?.message).toContain("name one with ACME_ACP_MODEL as provider/model");
});

/** Writes the user's file of a test host (its home is the test's own). */
const userFile = (text: string) => {
  const folder = join(testFolder(), "home", ".config", "labkit");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "policies.yml"), text);
};

test("a session's configuration is read when it is made: the user's file's MCP servers start, the client's replace those of the same name whole, the launcher's mode is the one it starts in, and effective-settings.json is written at its first prompt", async () => {
  const fake = new URL("../../tests/support/mcp-server.ts", import.meta.url).pathname;
  userFile(`mcpServers:\n  fake:\n    command: /no/such/server\n    required: true\n  extra:\n    command: ${process.execPath}\n    args: [${fake}]\n`);
  const host = startHost({
    world: echoWorld,
    script: [answer({ _tag: "Text", text: "Hello." })],
    configFlags: { mcpConfig: [], strictMcpConfig: false, permissionMode: "acceptEdits" },
  });
  const { app } = sdkClient();
  mkdirSync(host.cwd, { recursive: true });
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [fakeMcp("fake")] });
    const draftWrote = existsSync(sessionFolderOf(host.directory, created.sessionId));
    await ctx.request("session/prompt", say(created.sessionId, "Hi."));
    return { created, draftWrote };
  });
  await host.stop();
  const { sessionId } = result.created;
  expect(result.created.configOptions?.find((option) => option.id === "permission_mode")).toMatchObject({ currentValue: "acceptEdits" });
  expect(host.contexts[0]?.tools.map((tool) => tool.name as string)).toEqual([
    "echo",
    "mcp__fake__echo",
    "mcp__fake__roots",
    "mcp__fake__slow",
    "mcp__extra__echo",
    "mcp__extra__roots",
    "mcp__extra__slow",
  ]);
  expect(result.draftWrote).toBe(false);
  const written = JSON.parse(readFileSync(join(sessionFolderOf(host.directory, sessionId), "effective-settings.json"), "utf8"));
  expect(written.layers.map((layer: { readonly name: string }) => layer.name)).toEqual([
    "the ACP host's defaults",
    join(testFolder(), "home", ".config", "labkit", "policies.yml"),
    "the command line",
    "the client's MCP servers",
    "the client's MCP servers",
  ]);
  expect(written.mcpServers).toMatchObject([
    { name: "fake", command: process.execPath, args: [fake], required: false, cwd: host.cwd },
    { name: "extra", command: process.execPath, required: false },
  ]);
  expect(written.from["mcpServers.fake.command"]).toBe("the client's MCP servers");
  expect(written.lists.toolCalls).toEqual([{ name: "permissions", use: "permissions", settings: { mode: "acceptEdits" } }]);
  expect(written.host).toMatchObject({ permissionMode: "acceptEdits", canAsk: true, world: "the host's own" });
});

test("a server the configuration says is required that does not connect refuses session/new, session/load and session/resume, naming it, and leaves nothing open", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hello." })] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    // A session made before the configuration needed the server.
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(sessionId, "Hi."));
    await ctx.request("session/close", { sessionId });
    userFile("mcpServers:\n  needed:\n    command: /no/such/server\n    required: true\n");
    return {
      created: await failure(ctx.request("session/new", { cwd: host.cwd, mcpServers: [] })),
      loaded: await failure(ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] })),
      resumed: await failure(ctx.request("session/resume", { sessionId, cwd: host.cwd, mcpServers: [] })),
      // Nothing was left of the refused load: loading again is refused for the server, not as already loaded.
      again: await failure(ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] })),
    };
  });
  await host.stop();
  for (const refused of [result.created, result.loaded, result.resumed, result.again]) {
    expect(refused).toMatchObject({ code: -32603, data: { servers: ["needed"] } });
    expect(refused?.message).toStartWith("The session needs MCP servers that are not running: needed (it failed: its process could not be started:");
  }
});

test("a server that cannot be started leaves the session running: the model is told it is not running and the session records it failed; /mcp says how each server is; a server over ACP is refused, as the host does not offer it; two servers whose tools would share a name are -32602", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hello." })] });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [{ name: "missing", command: "/no/such/server", args: [], env: [] }] });
    const proxied = await failure(ctx.request("session/new", { cwd: host.cwd, mcpServers: [{ type: "acp", name: "proxied", serverId: "s-1" }] }));
    await ctx.request("session/prompt", say(sessionId, "Hi."));
    await ctx.request("session/prompt", say(sessionId, "/mcp"));
    await ctx.request("session/prompt", say(sessionId, "/mcp reconnect nobody"));
    const clashing = await failure(ctx.request("session/new", { cwd: host.cwd, mcpServers: [fakeMcp("a.b"), fakeMcp("a_b")] }));
    return { sessionId, clashing, proxied };
  });
  await host.stop();
  const notice = host.contexts[0]?.messages.at(-1);
  expect(notice?.role).toBe("instruction");
  const told = notice?.parts.flatMap((part) => (part._tag === "Text" ? [part.text as string] : [])) ?? [];
  expect(told).toHaveLength(1);
  expect(told[0]).toStartWith("The MCP server missing is not running, so its tools cannot be called: it failed: its process could not be started:");
  const said = log.updates.flatMap((update) => (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []));
  expect(said.at(-2)).toStartWith("missing: it failed: its process could not be started:");
  expect(said.at(-1)).toBe("No MCP server of this session is named nobody.");
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  expect(observed(facts).filter((fact) => fact.observation._tag === "McpServerChanged").map((fact) => fact.observation)).toMatchObject([
    { server: "missing", state: { _tag: "Failed" } },
  ]);
  expect(result.proxied).toMatchObject({ code: -32602, data: { capability: "agentCapabilities.mcpCapabilities.acp" } });
  expect(result.clashing).toMatchObject({ code: -32602, message: "The MCP servers a.b and a_b would offer their tools under one name, mcp__a_b" });
});

test("by default a response after a tool call with thinking but no answer is asked again; the client gets the answer, not the feedback, and end_turn", async () => {
  const host = startHost({
    world: echoWorld,
    retries: "the host's default",
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
    "session_info_update",
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

test("a turn whose one retry has no answer either answers end_turn, with no answer message", async () => {
  const host = startHost({
    world: echoWorld,
    retries: 1,
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

/** A world like `echoWorld` whose runs are recorded in `runs`; given `hold`, a run says so on it and never ends. */
const runsWorld = (runs: Array<string>, hold?: Deferred.Deferred<void>): World => ({
  open: () =>
    Effect.succeed({
      system: "Test.",
      sources: [
        {
          tools: [echoTool],
          run: (name, input): Effect.Effect<ToolOutcome> =>
            Effect.suspend(() => {
              runs.push(name);
              return hold === undefined ? Effect.succeed({ _tag: "Succeeded", output: input }) : Deferred.succeed(hold, undefined).pipe(Effect.andThen(Effect.never));
            }),
        },
      ],
      present: presentFrom([echoTool]),
    }),
});

/** What `session/load` replays of `facts` with `echoWorld`'s presentation, as JSON carries it. */
const replayOf = (facts: ReadonlyArray<Fact>): Array<Update> =>
  JSON.parse(JSON.stringify(Effect.runSync(project(facts, { mode: "replay", present: presentFrom([echoTool]) })).updates)) as Array<Update>;

/** A `session/update` notification as the agent wrote it to the wire. */
const isUpdateNotification = (
  message: Record<string, unknown>,
): message is { readonly method: "session/update"; readonly params: { readonly update: Update } } =>
  message["method"] === "session/update" && typeof message["params"] === "object" && message["params"] !== null && "update" in message["params"];

/**
 * The updates the agent wrote before it answered a `session/load` or `session/resume` (the first answer with config options). The
 * client's own handlers may run a tick after its request resolves, so the wire, not the client's log, is the witness of "before".
 */
const updatesBeforeAnswer = (host: HostRun): Array<Update> => {
  const answered = host.wire.findIndex((message) => typeof message["result"] === "object" && message["result"] !== null && "configOptions" in message["result"]);
  expect(answered).toBeGreaterThan(0);
  return host.wire.slice(0, answered).flatMap((message) => (isUpdateNotification(message) ? [message.params.update] : []));
};

/** The updates the host sends of a session it started from its facts, after its answer. */
const announced = ["available_commands_update", "session_info_update", "usage_update"];

/** A session made and prompted once with `echoWorld`, in a host that then stops: what a later process finds stored. */
const storedSession = async (text: string, pieces: ReadonlyArray<ReadonlyArray<Piece>>) => {
  const host = startHost({ world: echoWorld, script: pieces.map((each) => answer(...each)) });
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, text));
    return created.sessionId;
  });
  await host.stop();
  return { sessionId, cwd: host.cwd, directory: host.directory, file: storeFileOf(host.directory, sessionId) };
};

const echoTurn: ReadonlyArray<ReadonlyArray<Piece>> = [
  [
    { _tag: "Thinking", text: "Echo it first." },
    { _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "ping" } },
  ],
  [{ _tag: "Text", text: "Echoed." }],
];

test("initialize advertises session/load and the session methods close, list and resume, and not fork", async () => {
  const host = startHost();
  const { initialized } = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    const answered = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "an-sdk-client", version: "1.0.0" } });
    return { initialized: answered };
  });
  await host.stop();
  expect(initialized.agentCapabilities?.loadSession).toBe(true);
  expect(initialized.agentCapabilities?.sessionCapabilities).toMatchObject({ close: {}, list: {}, resume: {} });
  expect(initialized.agentCapabilities?.sessionCapabilities?.fork ?? undefined).toBeUndefined();
});

test("the first prompt writes the session's record, its working folder and the prompt's text as its title, and sends session_info_update; /export on a draft writes nothing", async () => {
  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Hi." })] });
  const { app, log } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(sessionId, "/export"));
    const afterExport = existsSync(host.directory);
    await ctx.request("session/prompt", say(sessionId, "  Plan\tthe   week:\n  three  goals  "));
    return { sessionId, afterExport };
  });
  await host.stop();
  expect(result.afterExport).toBe(false);
  expect(JSON.parse(readFileSync(join(host.directory, result.sessionId, "host.json"), "utf8"))).toEqual({ cwd: host.cwd, title: "Plan the week: three goals" });
  expect(kinds(log.updates)).toEqual(["available_commands_update", "agent_message_chunk", "session_info_update", "agent_message_chunk", "usage_update"]);
  expect(log.updates.find((update) => update.sessionUpdate === "session_info_update")).toMatchObject({
    title: "Plan the week: three goals",
    updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  });
  expect(host.logged.find((each) => each.key === logKeys.record.written)).toMatchObject({
    level: "Info",
    annotations: { session: result.sessionId, connection: expect.any(String) },
    details: { cwd: host.cwd, titled: true },
  });
});

test("with only the host's defaults, a session's world is given this process's environment without its credential variables", async () => {
  process.env["LABKIT_ACP_TEST_TOKEN"] = "inherited";
  process.env["LABKIT_ACP_TEST_PLAIN"] = "plain";
  const given: Array<Environment | undefined> = [];
  const recording: World = { open: (opening) => Effect.sync(() => given.push(opening.environment)).pipe(Effect.andThen(echoWorld.open(opening))) };
  const host = startHost({ world: recording, script: [answer({ _tag: "Text", text: "Hi." })] });
  await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(sessionId, "Hello"));
  });
  await host.stop();
  expect(given.length).toBeGreaterThan(0);
  for (const environment of given) {
    expect(environment?.["LABKIT_ACP_TEST_PLAIN"]).toBe("plain");
    expect(environment).not.toHaveProperty("LABKIT_ACP_TEST_TOKEN");
  }
});

test("session/load in a new process replays the stored turn in order before its answer, answers with the config options, then sends the commands, title and usage; a later prompt is live, repeats nothing and reaches the model with the earlier turn", async () => {
  const stored = await storedSession("Echo ping", echoTurn);
  const replay = replayOf(await factsOn(stored.file));
  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Second." })] });
  const { app, log, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const loaded = await ctx.request("session/load", { sessionId: stored.sessionId, cwd: host.cwd, mcpServers: [] });
    await until((updates) => updates.length >= replay.length + announced.length);
    const beforePrompt = log.updates.length;
    const prompted = await ctx.request("session/prompt", say(stored.sessionId, "Again"));
    return { loaded, beforePrompt, prompted };
  });
  await host.stop();
  expect(kinds(replay)).toEqual(["user_message_chunk", "agent_thought_chunk", "tool_call:pending", "tool_call_update:in_progress", "tool_call_update:completed", "agent_message_chunk"]);
  // On the wire, the agent wrote each stored update once, in the projection's order, and all of them before the answer.
  const written = updatesBeforeAnswer(host);
  expect(written).toHaveLength(replay.length);
  expect(written).toMatchObject(replay);
  expect(log.updates.slice(0, replay.length)).toMatchObject(replay);
  expect(kinds(log.updates.slice(replay.length, result.beforePrompt))).toEqual(announced);
  expect(log.updates[replay.length + 1]).toMatchObject({ title: "Echo ping", updatedAt: expect.any(String) });
  expect(result.loaded.configOptions?.find((option) => option.id === "model")).toMatchObject({ currentValue: "openai/gpt-6-sol" });
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(kinds(log.updates.slice(result.beforePrompt))).toEqual(["agent_message_chunk", "usage_update"]);
  expect(host.targets).toHaveLength(1);
  const sent = JSON.stringify(host.contexts[0]?.messages);
  expect(sent).toContain("Echo ping");
  expect(sent).toContain("Echoed.");
  expect(endings(await factsOn(stored.file))).toEqual(["Completed", "Completed"]);
  // What its configuration resolved to is written when it is loaded.
  expect(JSON.parse(readFileSync(join(sessionFolderOf(host.directory, stored.sessionId), "effective-settings.json"), "utf8"))).toMatchObject({
    host: { model: "openai/gpt-6-sol", permissionMode: "default" },
  });
  expect(host.logged.filter((each) => each.level === "Warn" || each.level === "Error" || each.level === "Fatal")).toEqual([]);
  expect(host.logged.find((each) => each.key === logKeys.session.loaded)).toMatchObject({
    level: "Info",
    annotations: { session: stored.sessionId, connection: expect.any(String), request: expect.anything() },
    details: { cwd: host.cwd, file: stored.file, replayed: replay.length, turnsLeftRunning: [], tools: ["echo"] },
  });
});

test("a session started by session/load or by session/resume offers permission_mode at the launcher's mode, not the mode it had when it was closed, and a mode set after it decides its next tool call", async () => {
  const write = (call: string) => answer({ _tag: "ToolCall", call, tool: "write_file", input: { path: "a.txt", content: call } });
  const first = startHost({ script: [write("w-1"), answer({ _tag: "Text", text: "One." })] });
  const stored = await sdkClient().app.connectWith(first.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: first.cwd, mcpServers: [] });
    // Closed in a mode other than the launcher's: a reopened session does not have it.
    await ctx.request("session/set_config_option", { sessionId: created.sessionId, configId: "permission_mode", value: "bypassPermissions" });
    await ctx.request("session/prompt", say(created.sessionId, "Write one"));
    return created.sessionId;
  });
  await first.stop();
  const option = (options: ReadonlyArray<acp.SessionConfigOption> | null | undefined) => options?.find((each) => each.id === "permission_mode");
  for (const method of ["session/load", "session/resume"] as const) {
    const name = method.slice("session/".length);
    const host = startHost({ script: [write(`${name}-2`), answer({ _tag: "Text", text: "Two." }), write(`${name}-3`), answer({ _tag: "Text", text: "Three." })] });
    const { app, log } = sdkClient();
    const result = await app.connectWith(host.stream, async (ctx) => {
      await initialize(ctx);
      const started =
        method === "session/load"
          ? await ctx.request("session/load", { sessionId: stored, cwd: host.cwd, mcpServers: [] })
          : await ctx.request("session/resume", { sessionId: stored, cwd: host.cwd });
      const changed = await ctx.request("session/set_config_option", { sessionId: stored, configId: "permission_mode", value: "bypassPermissions" });
      await ctx.request("session/prompt", say(stored, "Write two"));
      await ctx.request("session/set_config_option", { sessionId: stored, configId: "permission_mode", value: "default" });
      await ctx.request("session/prompt", say(stored, "Write three"));
      return { started, changed };
    });
    await host.stop();
    expect(option(result.started.configOptions)).toMatchObject({ category: "mode", currentValue: "default" });
    expect(option(result.changed.configOptions)).toMatchObject({ currentValue: "bypassPermissions" });
    // In bypass mode the write ran without a question; back in the default mode the next one was asked about.
    expect(log.asked.map((asked) => asked.toolCall.toolCallId)).toEqual([`${name}-3`]);
    expect(log.files.filter((each) => each.method === "fs/write_text_file").map((each) => each.content)).toEqual([`${name}-2`, `${name}-3`]);
  }
});

test("loading a session whose process ended with a tool call running ends that turn, with no tool run and no model request; the call is replayed once, as failed, and the next prompt works", async () => {
  const held = Deferred.makeUnsafe<void>();
  const first = startHost({ world: runsWorld([], held), script: [answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "ping" } })] });
  const sessionId = await sdkClient().app.connectWith(first.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: first.cwd, mcpServers: [] });
    void failure(ctx.request("session/prompt", say(created.sessionId, "Echo ping")));
    await Effect.runPromise(Deferred.await(held));
    await first.hangUp();
    return created.sessionId;
  });
  await first.ended;
  const file = storeFileOf(first.directory, sessionId);
  expect(endings(await factsOn(file))).toEqual([]);

  const runs: Array<string> = [];
  const host = startHost({ world: runsWorld(runs), script: [answer({ _tag: "Text", text: "Fresh." })] });
  const { app, log, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] });
    const atLoad = { targets: host.targets.length, runs: runs.length, facts: await factsOn(file) };
    await until((updates) => updates.some((update) => update.sessionUpdate === "usage_update"));
    const prompted = await ctx.request("session/prompt", say(sessionId, "Again"));
    return { atLoad, prompted };
  });
  await host.stop();
  const { atLoad } = result;
  expect(atLoad.targets).toBe(0);
  expect(atLoad.runs).toBe(0);
  expect(observed(atLoad.facts).map((fact) => fact.observation._tag)).toContain("TurnInterrupted");
  expect(endings(atLoad.facts)).toEqual(["Interrupted"]);
  const replay = replayOf(atLoad.facts);
  expect(log.updates.slice(0, replay.length)).toMatchObject(replay);
  expect(kinds(replay)).toContain("tool_call_update:failed");
  expect(kinds(log.updates).filter((kind) => kind === "tool_call_update:failed")).toHaveLength(1);
  expect(kinds(log.updates).filter((kind) => kind === "tool_call:pending")).toHaveLength(1);
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(host.targets).toHaveLength(1);
  expect(runs).toEqual([]);
  expect(endings(await factsOn(file))).toEqual(["Interrupted", "Completed"]);
  const ended = host.logged.find((each) => each.key === logKeys.session.turnLeftRunningEnded);
  expect(ended).toMatchObject({ level: "Info", annotations: { session: sessionId, turn: expect.any(String) } });
  expect(host.logged.find((each) => each.key === logKeys.session.loaded)).toMatchObject({
    details: { replayed: replay.length, turnsLeftRunning: [ended?.annotations["turn"]] },
  });
});

test("loading a session whose process ended with a model request in flight and no call under way ends the turn, with no model request made; the replay shows its input alone, and the next prompt works", async () => {
  const started = Deferred.makeUnsafe<void>();
  const first = startHost({ world: echoWorld, script: [held("Working on it.", started)] });
  const sessionId = await sdkClient().app.connectWith(first.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: first.cwd, mcpServers: [] });
    void failure(ctx.request("session/prompt", say(created.sessionId, "Think about it")));
    await Effect.runPromise(Deferred.await(started));
    await first.hangUp();
    return created.sessionId;
  });
  await first.ended;
  const file = storeFileOf(first.directory, sessionId);
  expect(endings(await factsOn(file))).toEqual([]);

  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Fresh." })] });
  const { app, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] });
    const atLoad = { targets: host.targets.length, facts: await factsOn(file) };
    await until((updates) => updates.some((update) => update.sessionUpdate === "usage_update"));
    const prompted = await ctx.request("session/prompt", say(sessionId, "Again"));
    return { atLoad, prompted };
  });
  await host.stop();
  expect(result.atLoad.targets).toBe(0);
  expect(endings(result.atLoad.facts)).toEqual(["Interrupted"]);
  expect(observed(result.atLoad.facts).map((fact) => fact.observation._tag)).not.toContain("ToolCallArrived");
  // What the stream sent before the process ended was never recorded, and ACP has no update for an interrupted turn: the client has the input alone.
  expect(kinds(updatesBeforeAnswer(host))).toEqual(["user_message_chunk"]);
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(endings(await factsOn(file))).toEqual(["Interrupted", "Completed"]);
});

test("loading a session whose process ended with the turn's second request in flight replays the first request as it ran, and the request under way adds nothing", async () => {
  const started = Deferred.makeUnsafe<void>();
  const first = startHost({
    world: echoWorld,
    script: [answer({ _tag: "Thinking", text: "Echo it first." }, { _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "ping" } }), held("Working on it.", started)],
  });
  const sessionId = await sdkClient().app.connectWith(first.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: first.cwd, mcpServers: [] });
    void failure(ctx.request("session/prompt", say(created.sessionId, "Echo ping")));
    await Effect.runPromise(Deferred.await(started));
    await first.hangUp();
    return created.sessionId;
  });
  await first.ended;
  const file = storeFileOf(first.directory, sessionId);
  const stored = await factsOn(file);
  expect(endings(stored)).toEqual([]);
  // The first request was answered and its call ran; the second was made and never answered.
  const left = observed(stored).map((fact) => fact.observation._tag);
  expect(left.filter((tag) => tag === "ModelRequestDispatched")).toHaveLength(2);
  expect(left.filter((tag) => tag === "ModelResponded")).toHaveLength(1);
  expect(left.lastIndexOf("ModelRequestDispatched")).toBeGreaterThan(left.lastIndexOf("ModelResponded"));

  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Fresh." })] });
  const { app, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] });
    const atLoad = { targets: host.targets.length, facts: await factsOn(file) };
    await until((updates) => updates.some((update) => update.sessionUpdate === "usage_update"));
    const prompted = await ctx.request("session/prompt", say(sessionId, "Again"));
    return { atLoad, prompted };
  });
  await host.stop();
  const { atLoad } = result;
  expect(atLoad.targets).toBe(0);
  expect(endings(atLoad.facts)).toEqual(["Interrupted"]);
  // The request under way is given the harness's response: nothing arrived of it, and how it ended is not known.
  const responses = atLoad.facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "ModelResponded" ? [fact.observation] : []));
  expect(responses.map((response) => response.ending._tag)).toEqual(["Complete", "Indeterminate"]);
  expect(responses.at(-1)?.parts).toEqual([]);
  expect(observed(atLoad.facts).at(-1)).toMatchObject({ origin: { _tag: "Harness", part: "resume" }, observation: { _tag: "ModelResponded" } });
  const written = updatesBeforeAnswer(host);
  expect(kinds(written)).toEqual(["user_message_chunk", "agent_thought_chunk", "tool_call:pending", "tool_call_update:in_progress", "tool_call_update:completed"]);
  expect(written).toEqual(replayOf(atLoad.facts));
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(endings(await factsOn(file))).toEqual(["Interrupted", "Completed"]);
});

test("loading a session whose process ended with a request in flight and a call it had made still running records that call once, in the response the harness gives, and replays it once: announced, started, failed", async () => {
  const started = Deferred.makeUnsafe<void>();
  const toolBegan = Deferred.makeUnsafe<void>();
  const first = startHost({
    world: runsWorld([], toolBegan),
    script: [heldAfterCall({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "ping" } }, started)],
  });
  const sessionId = await sdkClient().app.connectWith(first.stream, async (ctx) => {
    await initialize(ctx, {});
    const created = await ctx.request("session/new", { cwd: first.cwd, mcpServers: [] });
    void failure(ctx.request("session/prompt", say(created.sessionId, "Echo ping")));
    await Effect.runPromise(Effect.all([Deferred.await(started), Deferred.await(toolBegan)]));
    await first.hangUp();
    return created.sessionId;
  });
  await first.ended;
  const file = storeFileOf(first.directory, sessionId);
  const stored = await factsOn(file);
  // The call arrived while the response streamed and began to run; neither it nor the response ended.
  const left = observed(stored).map((fact) => fact.observation._tag);
  expect(left).toEqual(expect.arrayContaining(["ToolCallArrived", "ToolCallDispatched"]));
  expect(left.filter((tag) => tag === "ToolEnded" || tag === "ModelResponded")).toEqual([]);
  expect(endings(stored)).toEqual([]);

  const runs: Array<string> = [];
  const host = startHost({ world: runsWorld(runs), script: [answer({ _tag: "Text", text: "Fresh." })] });
  const { app, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId, cwd: host.cwd, mcpServers: [] });
    const atLoad = { targets: host.targets.length, runs: runs.length, facts: await factsOn(file) };
    await until((updates) => updates.some((update) => update.sessionUpdate === "usage_update"));
    const prompted = await ctx.request("session/prompt", say(sessionId, "Again"));
    return { atLoad, prompted };
  });
  await host.stop();
  const { atLoad } = result;
  expect(atLoad.targets).toBe(0);
  expect(atLoad.runs).toBe(0);
  // The call's end comes first, then the response the harness gives, which holds the call that had arrived.
  const recorded = observed(atLoad.facts.slice(stored.length));
  expect(recorded.map((fact) => fact.observation._tag)).toEqual(["TurnInterrupted", "ToolEnded", "ModelResponded"]);
  expect(recorded.map((fact) => fact.observation)).toMatchObject([
    { _tag: "TurnInterrupted" },
    { _tag: "ToolEnded", call: "echo-1", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } },
    { _tag: "ModelResponded", ending: { _tag: "Indeterminate" }, parts: [{ _tag: "ToolCall", call: "echo-1", tool: "echo" }] },
  ]);
  expect(endings(atLoad.facts)).toEqual(["Interrupted"]);
  const written = updatesBeforeAnswer(host);
  expect(kinds(written)).toEqual(["user_message_chunk", "tool_call:pending", "tool_call_update:in_progress", "tool_call_update:failed"]);
  expect(written.filter((update) => update.sessionUpdate === "tool_call")).toHaveLength(1);
  expect(written).toEqual(replayOf(atLoad.facts));
  expect(written.at(-1)).toMatchObject({ toolCallId: "echo-1", content: [{ type: "content", content: { type: "text", text: "How it ended was not observed" } }] });
  expect(result.prompted.stopReason).toBe("end_turn");
  expect(runs).toEqual([]);
  expect(endings(await factsOn(file))).toEqual(["Interrupted", "Completed"]);
});

test("session/resume starts the stored session and replays nothing, then sends the commands, title and usage; the next prompt reaches the model with the earlier turn, and the record keeps its working folder", async () => {
  const stored = await storedSession("Echo ping", echoTurn);
  // Written at the session's first prompt: removed, so that the resume is what writes it.
  rmSync(join(sessionFolderOf(stored.directory, stored.sessionId), "effective-settings.json"));
  const elsewhere = join(testFolder(), "elsewhere");
  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Second." })] });
  const { app, log, until } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const resumed = await ctx.request("session/resume", { sessionId: stored.sessionId, cwd: elsewhere });
    await until((updates) => updates.length >= announced.length);
    const beforePrompt = log.updates.length;
    const prompted = await ctx.request("session/prompt", say(stored.sessionId, "Again"));
    return { resumed, beforePrompt, prompted };
  });
  await host.stop();
  expect(kinds(log.updates.slice(0, result.beforePrompt))).toEqual(announced);
  expect(log.updates[0]).toMatchObject({ availableCommands: [{ name: "export" }, { name: "mcp" }] });
  expect(log.updates[1]).toMatchObject({ title: "Echo ping" });
  expect(result.resumed.configOptions?.find((option) => option.id === "model")).toMatchObject({ currentValue: "openai/gpt-6-sol" });
  expect(kinds(log.updates.slice(result.beforePrompt))).toEqual(["agent_message_chunk", "usage_update"]);
  expect(JSON.stringify(host.contexts[0]?.messages)).toContain("Echoed.");
  expect(JSON.parse(readFileSync(join(host.directory, stored.sessionId, "host.json"), "utf8"))).toEqual({ cwd: stored.cwd, title: "Echo ping" });
  // What its configuration resolved to is written when it is resumed.
  expect(existsSync(join(sessionFolderOf(host.directory, stored.sessionId), "effective-settings.json"))).toBe(true);
  expect(host.logged.find((each) => each.key === logKeys.session.resumed)).toMatchObject({
    level: "Info",
    annotations: { session: stored.sessionId },
    details: { cwd: elsewhere, replayed: 0, turnsLeftRunning: [] },
  });
});

test("session/list gives the sessions with a record, latest first, by working folder and a page at a time; a session with no record is not listed but loads; a cursor it did not give is -32602", async () => {
  const host = startHost({ world: echoWorld, pageSize: 2, script: ["One.", "Two.", "Three.", "Four."].map((text) => answer({ _tag: "Text", text })) });
  const elsewhere = join(testFolder(), "elsewhere");
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const made: Array<string> = [];
    for (const [cwd, text] of [
      [host.cwd, "First"],
      [elsewhere, "Second"],
      [host.cwd, "Third"],
      [host.cwd, "Made by the CLI"],
    ] as const) {
      const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
      await ctx.request("session/prompt", say(sessionId, text));
      made.push(sessionId);
    }
    // Each session's facts last written a minute after the one before's: the list's order is by that time.
    made.forEach((sessionId, index) => {
      const at = new Date(Date.UTC(2026, 0, 1, 12, index));
      utimesSync(storeFileOf(host.directory, sessionId), at, at);
    });
    rmSync(join(host.directory, made[3] ?? "", "host.json"));
    const firstPage = await ctx.request("session/list", {});
    const secondPage = await ctx.request("session/list", { cursor: firstPage.nextCursor ?? null });
    const here = await ctx.request("session/list", { cwd: host.cwd });
    const bad = await failure(ctx.request("session/list", { cursor: "not-a-cursor" }));
    return { made, firstPage, secondPage, here, bad };
  });
  await host.stop();

  // Each listed session by the order it was made in: 0 is First, 3 the one with no record.
  const made = (sessions: ReadonlyArray<{ readonly sessionId: string }>) => sessions.map((each) => result.made.indexOf(each.sessionId));

  expect(made(result.firstPage.sessions)).toEqual([2, 1]);
  expect(result.firstPage.sessions[0]).toMatchObject({ cwd: host.cwd, title: "Third", updatedAt: expect.any(String) });
  expect(result.firstPage.sessions[1]).toMatchObject({ cwd: elsewhere, title: "Second" });
  expect(result.firstPage.nextCursor).toEqual(expect.any(String));
  expect(made(result.secondPage.sessions)).toEqual([0]);
  expect(result.secondPage.nextCursor ?? undefined).toBeUndefined();
  expect(made(result.here.sessions)).toEqual([2, 0]);
  expect(result.bad).toMatchObject({ code: -32602, message: expect.stringContaining("not-a-cursor") });
  const listed = host.logged.filter((each) => each.key === logKeys.session.listed);
  expect(listed.map((each) => each.details)).toEqual([
    { cwd: null, returned: 2, more: true },
    { cwd: null, returned: 1, more: false },
    { cwd: host.cwd, returned: 2, more: false },
  ]);
  expect(listed[0]).toMatchObject({ level: "Info", annotations: { connection: expect.any(String) } });
  expect(host.logged.find((each) => each.key === logKeys.session.notListed)).toMatchObject({ level: "Warn", details: { cursor: "not-a-cursor" } });

  const later = startHost({ world: echoWorld });
  const { app, log, until } = sdkClient();
  const loaded = await app.connectWith(later.stream, async (ctx) => {
    await initialize(ctx, {});
    const answered = await ctx.request("session/load", { sessionId: result.made[3] ?? "", cwd: host.cwd, mcpServers: [] });
    await until((updates) => updates.some((update) => update.sessionUpdate === "session_info_update"));
    return answered;
  });
  await later.stop();
  expect(loaded.configOptions).toBeDefined();
  expect(log.updates.find((update) => update.sessionUpdate === "session_info_update")).toMatchObject({ title: null });
  expect(later.logged.filter((each) => each.level === "Warn" || each.level === "Error" || each.level === "Fatal")).toEqual([]);
});

test("a session directory that cannot be read answers session/list -32603 with the cause, and logs it as an error", async () => {
  writeFileSync(join(testFolder(), "sessions"), "not a folder");
  const host = startHost();
  const refused = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    return failure(ctx.request("session/list", {}));
  });
  await host.stop();
  expect(refused).toMatchObject({ code: -32603, message: expect.stringContaining(host.directory) });
  expect(host.logged.find((each) => each.key === logKeys.session.notListed)).toMatchObject({
    level: "Error",
    details: { directory: host.directory, doing: "reading the session directory", cause: expect.stringMatching(/\S/) },
  });
});

test("session/load of an unknown session is -32002, a relative cwd -32602, a session already loaded -32602, and one whose facts another process holds -32000, which leaves nothing open", async () => {
  const stored = await storedSession("One", [[{ _tag: "Text", text: "One." }]]);
  writeFileSync(`${stored.file}.lock`, String(process.pid));
  const host = startHost({ world: echoWorld });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const load = (sessionId: string, cwd = host.cwd) => ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    const unknown = await failure(load("no-such-session"));
    const relative = await failure(load(stored.sessionId, "work"));
    const locked = await failure(load(stored.sessionId));
    rmSync(`${stored.file}.lock`);
    const loaded = await load(stored.sessionId);
    const again = await failure(load(stored.sessionId));
    const resumed = await failure(ctx.request("session/resume", { sessionId: stored.sessionId, cwd: host.cwd }));
    return { unknown, relative, locked, loaded, again, resumed };
  });
  await host.stop();
  expect(result.unknown).toMatchObject({ code: -32002, data: { sessionId: "no-such-session" } });
  expect(result.relative).toMatchObject({ code: -32602, message: "cwd must be an absolute path: work" });
  expect(result.locked).toMatchObject({ code: -32000, message: expect.stringContaining(`is open in another process (pid ${process.pid})`) });
  expect(result.loaded.configOptions).toBeDefined();
  expect(result.again).toMatchObject({ code: -32602, message: expect.stringContaining("already loaded") });
  expect(result.resumed).toMatchObject({ code: -32602, message: expect.stringContaining("already loaded") });
  expect(host.logged.find((each) => each.key === logKeys.session.notStored)).toMatchObject({
    level: "Warn",
    annotations: { session: "no-such-session", connection: expect.any(String) },
    details: { doing: "session/load", file: storeFileOf(host.directory, "no-such-session") },
  });
  expect(host.logged.find((each) => each.key === logKeys.session.notLoaded)).toMatchObject({
    level: "Error",
    annotations: { session: stored.sessionId, connection: expect.any(String) },
    details: { file: stored.file, cause: expect.stringContaining("another process") },
  });
  expect(host.logged.filter((each) => each.key === logKeys.session.refused).map((each) => each.details)).toMatchObject([
    { doing: "session/load", cwd: "work" },
    { doing: "session/load", cause: expect.stringContaining("already loaded") },
    { doing: "session/resume", cause: expect.stringContaining("already loaded") },
  ]);
  expect(host.logged.filter((each) => each.key === logKeys.session.loaded)).toHaveLength(1);
});

test("an editor that writes files and does not read them is offered write_file, not edit_file", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hi." })] });
  const { app } = sdkClient();
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, { fs: { readTextFile: false, writeTextFile: true } });
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Hello"));
    return created.sessionId;
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toEqual(["write_file", "update_plan"]);
});

test("a file read over 256 KiB is cut before a character, not inside it; a call's title names its command before its path", async () => {
  const content = `${"a".repeat(maxFileBytes - 1)}é and more`;
  const host = startHost({
    script: [
      answer(
        { _tag: "ToolCall", call: "read-1", tool: "read_file", input: { path: "big.txt" } },
        { _tag: "ToolCall", call: "plan-1", tool: "update_plan", input: { command: "ls", path: "a.txt" } },
      ),
      answer({ _tag: "Text", text: "Done." }),
    ],
  });
  const { app, log } = sdkClient(undefined, { [join(testFolder(), "work", "big.txt")]: content });
  const sessionId = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Read it"));
    return created.sessionId;
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  const read = observed(facts).flatMap((fact) => (fact.observation._tag === "ToolEnded" && fact.observation.call === "read-1" ? [fact.observation.outcome] : []))[0];
  if (read?._tag !== "Succeeded") throw new Error(`read_file did not succeed: ${JSON.stringify(read)}`);
  const omitted = Buffer.byteLength(content) - (maxFileBytes - 1);
  expect(asText(read.output)).toBe(`${"a".repeat(maxFileBytes - 1)}\n[Cut at 256 KiB: ${omitted} bytes left out. Read the rest with line and limit.]`);
  const announced = log.updates.find((update) => update.sessionUpdate === "tool_call" && update.toolCallId === "plan-1");
  expect(announced !== undefined && "title" in announced ? announced.title : undefined).toBe("update_plan: ls");
});

test("a call that ends while its permission request is out, its turn cancelled, has the request cancelled at the client", async () => {
  const host = startHost({
    script: [answer({ _tag: "ToolCall", call: "write-1", tool: "write_file", input: { path: "a.txt", content: "hi" } }), answer({ _tag: "Text", text: "Done." })],
  });
  const asked = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const app = acp
    .client({ name: "an-sdk-client" })
    .onRequest("session/request_permission", (ctx) => {
      asked.resolve();
      return new Promise<acp.RequestPermissionResponse>((resolve) =>
        ctx.signal.addEventListener("abort", () => {
          aborted.resolve();
          resolve({ outcome: { outcome: "cancelled" } });
        }),
      );
    })
    .onNotification("session/update", () => {});
  const cancelled = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const prompt = ctx.request("session/prompt", say(sessionId, "Write it"));
    await asked.promise;
    await ctx.notify("session/cancel", { sessionId });
    await prompt;
    return Promise.race([aborted.promise.then(() => true), Bun.sleep(2000).then(() => false)]);
  });
  await host.stop();
  expect(cancelled).toBe(true);
});

test("changes made while a session's first turn runs are held as one, made when it ends: the later model and permission mode, and every setting, the later's winning", async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const host = startHost({
    world: echoWorld,
    script: [heldCall({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "1" } }, started, release), answer({ _tag: "Text", text: "One." })],
  });
  const { app } = sdkClient();
  const result = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const first = ctx.request("session/prompt", say(sessionId, "One"));
    await Effect.runPromise(Deferred.await(started));
    const changes: ReadonlyArray<readonly [string, string]> = [
      ["permission_mode", "acceptEdits"],
      ["model", "openai/gpt-6-luna"],
      ["effort", "low"],
      ["max_output_tokens", "8192"],
      ["max_output_tokens", "4096"],
      ["permission_mode", "bypassPermissions"],
    ];
    for (const [configId, value] of changes) await ctx.request("session/set_config_option", { sessionId, configId, value });
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await first;
    // No turn runs now: this change is made at once, after the held one.
    const after = await ctx.request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
    return { sessionId, after };
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, result.sessionId));
  expect(observed(facts).flatMap((fact) => (fact.observation._tag === "ModelChangeArrived" ? [fact.observation] : [])) as unknown).toMatchObject([
    { provider: "openai", model: "gpt-6-luna", settings: { effort: "low", maxOutputTokens: 4096 } },
    { provider: "openai", model: "gpt-6-luna", settings: { effort: "high" } },
  ]);
  expect(result.after.configOptions.find((option) => option.id === "permission_mode")).toMatchObject({ currentValue: "bypassPermissions" });
});

test("an embedded file with no media type is text/plain when it is text and application/octet-stream when it is bytes; a prompt with no files attaches none", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Seen." }), answer({ _tag: "Text", text: "Hi." })] });
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [
        { type: "text", text: "What are these?" },
        { type: "resource", resource: { uri: "file:///work/notes", text: "Notes" } },
        { type: "resource", resource: { uri: "file:///work/data", blob: Buffer.from([1, 2, 3]).toString("base64") } },
      ],
    });
    await ctx.request("session/prompt", say(created.sessionId, "Hello"));
    return created.sessionId;
  });
  await host.stop();
  const inputs = observed(await factsOn(storeFileOf(host.directory, sessionId))).flatMap((fact) => (fact.observation._tag === "InputArrived" ? [fact.observation] : []));
  expect(inputs[0]).toMatchObject({ attachments: [{ mediaType: "text/plain", name: "notes" }, { mediaType: "application/octet-stream", name: "data" }] });
  expect(inputs[1] !== undefined && "attachments" in inputs[1]).toBe(false);
});

test("the local world offers the workspace tools, and the settings written say the world is local", async () => {
  const host = startHost({ world: "local", script: [answer({ _tag: "Text", text: "Hi." })] });
  const sessionId = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const created = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(created.sessionId, "Hello"));
    return created.sessionId;
  });
  await host.stop();
  const facts = await factsOn(storeFileOf(host.directory, sessionId));
  expect((await Effect.runPromise(immutableToolCatalogOf(facts))).map((tool): string => tool.name)).toContain("list_dir");
  const written = JSON.parse(readFileSync(join(sessionFolderOf(host.directory, sessionId), "effective-settings.json"), "utf8"));
  expect(written.host).toMatchObject({ world: "local" });
});

test("a session/load of a session still starting on this connection is -32602", async () => {
  const stored = await storedSession("Echo ping", echoTurn);
  const opening = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const slowWorld: World = {
    open: (given) => Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(echoWorld.open(given))),
  };
  const host = startHost({ world: slowWorld });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const first = ctx.request("session/load", { sessionId: stored.sessionId, cwd: host.cwd, mcpServers: [] });
    await Effect.runPromise(Deferred.await(opening));
    const second = await failure(ctx.request("session/load", { sessionId: stored.sessionId, cwd: host.cwd, mcpServers: [] }));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await first;
    return second;
  });
  await host.stop();
  expect(result).toMatchObject({ code: -32602, message: expect.stringContaining("already loaded") });
});

/** A request that says it started, waits for `release`, then answers with `pieces`. */
const after = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>, ...pieces: ReadonlyArray<Piece>): Reply => (turn, target) =>
  Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(answer(...pieces)(turn, target)));

/** Appends to a session's facts file the input `text` from the user, with no turn started for it: as a process that ended between the two leaves it. */
const inputLeftWaiting = async (file: string, text: string) => {
  const seq = (await factsOn(file)).length + 1;
  const line = { _tag: "Observed", seq, time: new Date().toISOString(), origin: { _tag: "User", via: "acp" }, observation: { _tag: "InputArrived", from: { _tag: "User" }, text } };
  writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(line)}\n`);
};

test("a prompt is answered only after the client has every update of its turn, however long the feed takes to send them", async () => {
  // The presentation of a call's end takes 300 ms, so the feed sends the turn's last updates after its end is recorded.
  const slowWorld: World = {
    open: () =>
      Effect.succeed({
        system: "Test.",
        sources: [{ tools: [echoTool], run: (_name, input) => Effect.succeed({ _tag: "Succeeded", output: input }) }],
        present: (call, outcome) => (outcome === undefined ? presentFrom([echoTool])(call) : Effect.sleep("300 millis").pipe(Effect.andThen(presentFrom([echoTool])(call, outcome)))),
      }),
  };
  const host = startHost({ world: slowWorld, script: [answer({ _tag: "ToolCall", call: "echo-1", tool: "echo", input: { say: "4" } }), answer({ _tag: "Text", text: "Done." })] });
  const prompted = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return ctx.request("session/prompt", say(sessionId, "Echo 4."));
  });
  await host.stop();
  expect(prompted.stopReason).toBe("end_turn");
  const answeredAt = host.wire.findIndex((message) => typeof message["result"] === "object" && message["result"] !== null && "stopReason" in message["result"]);
  const lastUpdateAt = host.wire.reduce((last, message, at) => (isUpdateNotification(message) && message.params.update.sessionUpdate === "agent_message_chunk" ? at : last), -1);
  const completedAt = host.wire.findIndex((message) => isUpdateNotification(message) && message.params.update.sessionUpdate === "tool_call_update" && message.params.update.status === "completed");
  expect(completedAt).toBeGreaterThan(0);
  expect(lastUpdateAt).toBeGreaterThan(completedAt);
  expect(answeredAt).toBeGreaterThan(lastUpdateAt);
});

test("a change of model held while a turn the host went on with ran is made before the next prompt's turn starts, which asks the new model", async () => {
  const stored = await storedSession("One", [[{ _tag: "Text", text: "One." }]]);
  await inputLeftWaiting(stored.file, "Two");
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const host = startHost({ world: echoWorld, script: [after(started, release, { _tag: "Text", text: "Two." }), answer({ _tag: "Text", text: "Three." })] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId: stored.sessionId, cwd: host.cwd, mcpServers: [] });
    // The input left waiting starts its turn once the session goes on; the change arrives while it runs.
    await Effect.runPromise(Deferred.await(started));
    await ctx.request("session/set_config_option", { sessionId: stored.sessionId, configId: "model", value: "openai/gpt-6-luna" });
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await eventually(stored.file, (facts) => endings(facts).length === 2);
    return ctx.request("session/prompt", say(stored.sessionId, "Three"));
  });
  await host.stop();
  expect(result.stopReason).toBe("end_turn");
  expect(host.targets).toEqual(["openai/gpt-6-sol", "openai/gpt-6-luna"]);
});

test("loading a session whose facts end with input that no turn took starts its turn live, once the feed has started", async () => {
  const stored = await storedSession("One", [[{ _tag: "Text", text: "One." }]]);
  await inputLeftWaiting(stored.file, "Are you there?");
  const host = startHost({ world: echoWorld, script: [answer({ _tag: "Text", text: "Yes." })] });
  const { app, log } = sdkClient();
  await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    await ctx.request("session/load", { sessionId: stored.sessionId, cwd: host.cwd, mcpServers: [] });
    await eventually(stored.file, (facts) => endings(facts).length === 2);
  });
  await host.stop();
  expect(endings(await factsOn(stored.file))).toEqual(["Completed", "Completed"]);
  expect(host.targets).toHaveLength(1);
  expect(log.updates).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Yes." } });
});

test("session/list gives at most 50 sessions a page unless the host says otherwise, and a cursor for the rest", async () => {
  const host = startHost();
  for (let index = 0; index < 51; index++) {
    const folder = sessionFolderOf(host.directory, `s-${String(index).padStart(2, "0")}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "facts.jsonl"), "");
    writeFileSync(join(folder, "host.json"), JSON.stringify({ cwd: host.cwd }));
  }
  const page = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    return ctx.request("session/list", {});
  });
  await host.stop();
  expect(page.sessions).toHaveLength(50);
  expect(typeof page.nextCursor).toBe("string");
});

test("a session's record that cannot be written at its first prompt fails the prompt with -32603, and the session stays a draft", async () => {
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hello." })] });
  const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    // A folder where the record's file belongs: the record cannot be written.
    mkdirSync(join(sessionFolderOf(host.directory, sessionId), "host.json"), { recursive: true });
    const refused = await failure(ctx.request("session/prompt", say(sessionId, "Hi.")));
    const exported = await ctx.request("session/prompt", say(sessionId, "/export"));
    return { sessionId, refused, exported };
  });
  await host.stop();
  expect(result.refused).toMatchObject({ code: -32603 });
  expect(result.refused?.message).toStartWith("The session could not be opened:");
  expect(existsSync(storeFileOf(host.directory, result.sessionId))).toBe(false);
  expect(host.targets).toEqual([]);
  expect(host.logged.find((each) => each.key === logKeys.session.notOpened)).toMatchObject({ level: "Error", details: { doing: "writing the session's record at its first prompt" } });
});

test("a configuration that cannot be used refuses session/new with -32603, naming the problem", async () => {
  userFile("nonsense: 1\n");
  const host = startHost();
  const refused = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    return failure(ctx.request("session/new", { cwd: host.cwd, mcpServers: [] }));
  });
  await host.stop();
  expect(refused).toMatchObject({ code: -32603 });
  expect(refused?.message).toStartWith("The configuration cannot be used:");
});

test("a session refused for a required server that is not running ends the servers it started: a server at a URL has its session ended", async () => {
  userFile("mcpServers:\n  needed:\n    command: /no/such/server\n    required: true\n");
  const web = startFakeHttpServer({ transport: "http" });
  const host = startHost();
  try {
    const result = await sdkClient().app.connectWith(host.stream, async (ctx) => {
      await initialize(ctx, {});
      const refused = await failure(ctx.request("session/new", { cwd: host.cwd, mcpServers: [{ type: "http", name: "web", url: web.url, headers: [] }] }));
      for (let tries = 0; web.deleted.length === 0 && tries < 100; tries++) await Bun.sleep(10);
      return { refused, deleted: web.deleted.length };
    });
    await host.stop();
    expect(result.refused).toMatchObject({ code: -32603, data: { servers: ["needed"] } });
    expect(result.deleted).toBe(1);
  } finally {
    web.stop();
  }
});

test("with retries set to 0, an incomplete turn is not asked again: it answers end_turn after one request", async () => {
  const host = startHost({ world: echoWorld, retries: 0, script: [answer({ _tag: "Thinking", text: "The answer is 4." })] });
  const prompted = await sdkClient().app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx, {});
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    return ctx.request("session/prompt", say(sessionId, "What is 2 + 2?"));
  });
  await host.stop();
  expect(prompted.stopReason).toBe("end_turn");
  expect(host.targets).toHaveLength(1);
});

test("a permission mode set while a turn runs applies when the turn ends: the turn's own call is still asked about, the next turn's is not", async () => {
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const host = startHost({
    script: [after(started, release, writeNotes("call-1")), answer({ _tag: "Text", text: "Written." }), answer(writeNotes("call-2")), answer({ _tag: "Text", text: "Written again." })],
  });
  const { app, log } = sdkClient();
  await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    const first = ctx.request("session/prompt", say(sessionId, "Write hello."));
    await Effect.runPromise(Deferred.await(started));
    await ctx.request("session/set_config_option", { sessionId, configId: "permission_mode", value: "bypassPermissions" });
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await first;
    await ctx.request("session/prompt", say(sessionId, "Write it again."));
  });
  await host.stop();
  expect(log.asked.map((asked) => asked.toolCall.toolCallId)).toEqual(["call-1"]);
});

test("a call with properties its tool does not take runs without them and says which; with strict tool input it is refused", async () => {
  const call: Piece = { _tag: "ToolCall", call: "call-1", tool: "write_file", input: { path: "notes.txt", content: "hello", mode: "0644" } };
  const run = async (strictToolInput: boolean) => {
    const host = startHost({ strictToolInput, script: [answer(call), answer({ _tag: "Text", text: "Done." })] });
    const { app, log } = sdkClient();
    await app.connectWith(host.stream, async (ctx) => {
      await initialize(ctx);
      const { sessionId } = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
      await ctx.request("session/prompt", say(sessionId, "Write hello."));
    });
    await host.stop();
    return { ended: log.updates.find((update) => update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")), files: log.files };
  };
  const lenient = await run(false);
  expect(lenient.ended).toMatchObject({ status: "completed" });
  expect(JSON.stringify(lenient.ended)).toContain("[Not inputs of write_file, so ignored: mode.]");
  expect(lenient.files.map((each) => each.method)).toEqual(["fs/write_text_file"]);
  const strict = await run(true);
  expect(strict.ended).toMatchObject({ status: "failed" });
  expect(JSON.stringify(strict.ended)).toContain("write_file does not take this input");
  expect(strict.files).toEqual([]);
});

test("session/new starts with the model the configuration names; its overrides decide the efforts offered, and what the session knows of the model", async () => {
  const folder = join(testFolder(), "home", ".config", "labkit");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "models.yml"), "model: openai/gpt-6-luna\nmodels:\n  openai/gpt-6-luna:\n    efforts: [low, high]\n    context: 5000\n");
  const host = startHost({ script: [answer({ _tag: "Text", text: "Hello." })] });
  const { app, log } = sdkClient();
  const created = await app.connectWith(host.stream, async (ctx) => {
    await initialize(ctx);
    const made = await ctx.request("session/new", { cwd: host.cwd, mcpServers: [] });
    await ctx.request("session/prompt", say(made.sessionId, "Hi."));
    return made;
  });
  await host.stop();
  expect(created.configOptions?.find((option) => option.id === "model")).toMatchObject({ currentValue: "openai/gpt-6-luna" });
  const effort = created.configOptions?.find((option) => option.id === "effort");
  expect(effort?.type === "select" ? effort.options.flatMap((each) => ("value" in each ? [each.value] : [])) : []).toEqual(["not_sent", "low", "high"]);
  expect(host.targets).toEqual(["openai/gpt-6-luna"]);
  // The session's own knowledge of the model has the override: its context window is the override's.
  expect(log.updates.find((update) => update.sessionUpdate === "usage_update")).toMatchObject({ size: 5000 });
});
