/**
 * The ACP host: an agent of protocol v1 (`Agent.implement`) whose sessions run on the core. A
 * launcher runs `makeHost(options)` with `Agent.run` or `Agent.runStdio`.
 *
 * Per connection the host holds the sessions it made, each a draft or open:
 *
 * - `session/new` mints the id (ACP's `sessionId` and the core's `SessionId`), opens the session's
 *   world (`world.ts`), and makes a draft with the model to start with: nothing is written. Its
 *   answer carries the config options; `available_commands_update` (`/export`) follows it, once the
 *   client knows the session.
 * - `session/set_config_option` changes the draft, or, once open, is `ModelChangeArrived` from the
 *   user through ACP, taken at the next turn (agent-machine M1). The answer is every option as the
 *   configuration will be.
 * - `session/prompt` opens a draft (turn zero: the session's record, `host.json`, with its working
 *   folder and the first prompt's text as its title; its folder in the session directory, its
 *   services, `SessionOpened`; then `session_info_update` with the title) and runs the turn with
 *   `Session.prompt`. The session's feed (`feed.ts`) sends the turn's updates and asks permission;
 *   once it has taken the turn's end the host sends `usage_update` and answers with the turn's stop
 *   (`stopOf`). `/export` alone writes the transcript to `<cwd>/.<brand>/exports/<sessionId>.md`
 *   without asking the model, and opens no draft.
 * - `session/load` starts a stored session on this connection: its facts file, with the world
 *   opened for the `cwd` and MCP servers asked. A turn its facts left running is ended, not gone
 *   on with. Its facts are replayed through the projection (`replay`) before the answer, and the
 *   feed goes on from the state they leave. `session/resume` does the same and replays nothing.
 *   After either answer: `available_commands_update`, `session_info_update` and `usage_update`.
 * - `session/list` lists the stored sessions that have the host's record (`session-record.ts`).
 * - `session/cancel` is `Session.cancel`; so is a prompt request the client cancels
 *   (`$/cancel_request`). A prompt interrupted by the end of the connection leaves its turn running
 *   in the facts, as the core allows: the host does not end it.
 * - `session/close` stops the turn under way and closes the session's scope.
 *
 * The connection's end closes every session's scope.
 */

import { type Brand, defaultBrand, envPrefixOf, folderOf } from "../agent-host/brand.ts";
import { type ConfigFlags, launchLayers } from "../agent-host/launch.ts";
import { writeEffectiveSettings } from "../agent-config/effective.ts";
import { type Configuration, type LayerSource, loadConfiguration } from "../agent-config/file.ts";
import { seamLayer, seamListsOf } from "../agent-config/seams.ts";
import { credentialsLeftOut, environmentOf } from "../agent-process/environment.ts";
import { describe } from "../agent-mcp/server-machine.ts";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessSpawner } from "effect/process";
import { Clock, type Context, type Duration, Effect, Exit, Fiber, FileSystem, HashMap, HashSet, Layer, Option, type Path, Ref, Schema, Scope, Semaphore, Stream } from "effect";
import * as Agent from "effective-acp/agent";
import { ErrorCode, type JsonRpcErrorObject } from "effective-acp/json-rpc";
import * as Protocol from "effective-acp/protocol";
import type { ContentBlock, McpServer, SessionConfigOption, SessionUpdate } from "effective-acp/schema/v1";
import { SessionId as AcpSessionId } from "effective-acp/schema/v1";
import { type Asked, askable, keyVariables, ModelCatalog, targetOf } from "../agent-host/catalog.ts";
import { sessionFolderOf, storeFileOf } from "../agent-host/directory.ts";
import type { BlobRef } from "../agent-machine/blob.ts";
import { MediaType } from "../agent-machine/received.ts";
import { Blobs, BlobsInFolder, type BlobStore } from "../agent-session/blobs.ts";
import { chooseModel, defaultModel, type Draft, draftOf, opening, optionsOfDraft, saySettings, withDefaults } from "../agent-host/draft.ts";
import { markdownOf } from "../agent-host/export.ts";
import { KnownWithLocalServer, localServer, SettlingWithLocalServer } from "../agent-host/local-server.ts";
import { readRecord, RecordFailed, recordedSessions, recordFileOf, writeRecord } from "../agent-host/record.ts";
import { SessionServices } from "../agent-host/services.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { leftRunning } from "../agent-machine/left-running.ts";
import { InputText, SessionId, type TurnId } from "../agent-machine/names.ts";
import type { Target, ToolRunner } from "../agent-session/contracts.ts";
import { SourcedToolRunner, ToolSources, toolsOf } from "../agent-session/tool-sources.ts";
import { FileBackedSessionStore } from "../agent-session/file-session-store.ts";
import { endTurnLeftRunning, openSession, type Services, type Session } from "../agent-session/loop.ts";
import type { SessionStore, SessionStoreFailed } from "../agent-session/session-store.ts";
import { harnessParts, reportedBy } from "../agent-session/origin.ts";
import { outcomeAsSent } from "../agent-session/tool-output.ts";
import { Notices } from "../agent-context/assemble.ts";
import { mcpCommand as mcpSaid } from "../agent-mcp/command.ts";
import { type GivenServer, type McpServers, startMcpServers } from "../agent-mcp/servers.ts";
import { namespaceOf } from "../agent-mcp/source.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { optionsFor, type Options } from "../agent-session/configuration/options.ts";
import { type ConfigurationGate, makeConfigurationGate } from "../agent-session/configuration/gate.ts";
import { knownCapabilities } from "../agent-session/configuration/well-known-models.ts";
import { type Change, changeOf, configOptions, InvalidChange, permissionId, permissionModeOf, permissionOption } from "./config-options.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";
import { acpUser, type Feed, startFeed } from "./feed.ts";
import { logKeys } from "./log-keys.ts";
import { presentFrom, type ProjectionState, project, start } from "./projection.ts";
import { InvalidCursor, pageOf, readSessionRecord, recordFor } from "./session-record.ts";
import { stopOf } from "./stop-reason.ts";
import { usageUpdate } from "./usage.ts";
import { editorWorld, type World, type WorldSession, workspaceWorld } from "./world.ts";

export interface HostOptions<R = never> {
  /** The session directory's root (`agent-host/directory.ts`): each session that had a turn is a folder in it. */
  readonly directory: string;
  /**
   * Where the sessions' tools come from: `"editor"` (`editorWorld`, the default), `"local"`
   * (`workspaceWorld`, a stopgap that bypasses the editor; the launcher's `--local-tools`), or a
   * world of the host's own.
   */
  readonly world?: "editor" | "local" | World<R> | undefined;
  /** The model sessions start with, as `provider/model` (the launcher's `--model`); left out, the first the catalog lists. */
  readonly model?: string | undefined;
  /**
   * The launcher's options that make each session's configuration (`agent-host/launch.ts`):
   * `--permission-mode` (the mode sessions start in; the user can change it), `--max-turns`,
   * `--max-budget-usd`, `--settings`, `--setting-sources`, `--mcp-config` and `--strict-mcp-config`.
   */
  readonly configFlags?: ConfigFlags | undefined;
  /** The home whose `.config/<brand>/policies.yml` is the user's file; this process's when left out. */
  readonly home?: string | undefined;
  /**
   * How many times a turn whose response had thinking but no answer is asked again for it (the
   * launcher's `--retries`; 0 asks never); 1 when left out. The host's defaults list
   * `retryIncomplete` with it.
   */
  readonly retries?: number | undefined;
  /**
   * Whether a tool call whose input has properties its tool does not take is refused (the
   * launcher's `--strict-tool-input`); if not (the default), it runs without them, and its result
   * says which were ignored.
   */
  readonly strictToolInput?: boolean | undefined;
  /**
   * The most model requests one turn makes unless the configuration says (`--max-turns`): the
   * request beyond it is vetoed, and the prompt ends with the stop reason `max_turn_requests`
   * (`agent-policy/max-turn-requests.ts`); 1000 when left out. The host's defaults list
   * `maxTurnRequests` with it.
   */
  readonly maxTurnRequests?: number | undefined;
  /** How long an MCP server a client names has to start and answer `initialize`; 30 seconds when left out. */
  readonly mcpConnectTimeout?: Duration.Input | undefined;
  /**
   * What a session runs with, given its world's tool runner, over the session's store, before its
   * configuration's seam lists; `SessionServices` when left out.
   */
  readonly services?: ((runner: Layer.Layer<ToolRunner>) => Layer.Layer<Services, never, SessionStore>) | undefined;
  /** The most sessions one page of `session/list` gives; 50 when left out. */
  readonly pageSize?: number | undefined;
  /** The name the agent goes by (`agent-host/brand.ts`): where `/export` writes, and what it calls itself to MCP servers. */
  readonly brand?: Brand | undefined;
}

/**
 * The ACP host's defaults, the first of a session's layers (`agent-host/launch.ts`): permission on
 * tool calls; the limit on a turn's model requests (`maxTurnRequests`, 1000 when not given); a turn
 * with thinking and no answer asked again for it `retries` times (1 when not given; with 0, no
 * turn-end hook); the model's commands given the environment without its credentials.
 */
export const acpDefaults = (options: { readonly retries?: number | undefined; readonly maxTurnRequests?: number | undefined }): LayerSource => {
  const retries = options.retries ?? 1;
  return {
    name: "the ACP host's defaults",
    trusted: true,
    value: {
      toolCalls: ["permissions"],
      modelRequests: ["maxTurnRequests"],
      commandEnvironment: ["credentials"],
      ...(retries === 0 ? {} : { turnEnd: ["retryIncomplete"], maxHolds: retries }),
      plugins: {
        ...(options.maxTurnRequests === undefined ? {} : { maxTurnRequests: { limit: options.maxTurnRequests } }),
        ...(retries === 0 ? {} : { retryIncomplete: { retries } }),
      },
    },
  };
};

/**
 * One of the client's MCP servers as a layer writes it: run in the session's folder, or at its URL.
 * MCP over ACP (`type: acp`) is not offered (`mcpCapabilities`): written as it is, the
 * configuration refuses it.
 */
const writtenOf = (cwd: string, server: McpServer) => {
  const pairs = (each: ReadonlyArray<{ readonly name: string; readonly value: string }>) => Object.fromEntries(each.map(({ name, value }) => [name, value]));
  if ("command" in server) return { command: server.command, args: [...server.args], env: pairs(server.env), cwd };
  if (server.type === "http" || server.type === "sse") return { type: server.type, url: server.url, headers: pairs(server.headers) };
  return { type: server.type };
};

/**
 * The client's MCP servers for a session in `cwd`, as the last layers: the first takes out the
 * configuration's servers of the same names, so the client's replaces each whole.
 */
const clientLayers = (cwd: string, servers: ReadonlyArray<McpServer>): ReadonlyArray<LayerSource> => {
  if (servers.length === 0) return [];
  const name = "the client's MCP servers";
  return [
    { name, trusted: true, value: { mcpServers: Object.fromEntries(servers.map((server) => [server.name, null])) } },
    { name, trusted: true, value: { mcpServers: Object.fromEntries(servers.map((server) => [server.name, writtenOf(cwd, server)])) } },
  ];
};

/** The mode a session starts in: the setting of the `permissions` its tool calls list; `default` when none. */
const startingModeOf = (configuration: Configuration): PermissionMode => {
  const mode = (configuration.lists.toolCalls?.find((entry) => entry.plugin.use === "permissions")?.settings as { readonly mode?: unknown } | undefined)?.mode;
  return Schema.is(PermissionMode)(mode) ? mode : "default";
};

/** A session's configuration, and the layers it was made from. */
type Configured = Configuration & { readonly layers: ReadonlyArray<LayerSource> };

/** The command the host runs itself, without the model. */
const exportCommandOf = (brand: Brand) => ({ name: "export", description: `Write this session's transcript as Markdown to ${folderOf(brand)}/exports/<session>.md in the working folder.` });

/** The command that says how the session's MCP servers are, and starts one again. */
const mcpCommand = { name: "mcp", description: "Say how this session's MCP servers are; `reconnect <server>` starts one again.", input: { hint: "reconnect <server>" } };

const rpcError = (code: number, message: string, data?: unknown): JsonRpcErrorObject => ({ code, message, ...(data === undefined ? {} : { data }) });

/** An open session: the core's, the services its operations run with, its scope and its feed. */
interface Opened {
  readonly session: Session;
  readonly context: Context.Context<Services>;
  readonly scope: Scope.Closeable;
  readonly feed: Feed;
  /** When the user's changes are made: at once between turns, else held until the turn ends (agent-session G1–G3). */
  readonly gate: ConfigurationGate<HeldChange, SessionStoreFailed>;
}

/** What a user changes of an open session: its model and settings, and its permission mode. */
interface HeldChange {
  readonly model?: Change | undefined;
  readonly permissionMode?: PermissionMode | undefined;
}

/** Two changes as one: the later's model and permission mode, and the settings of both, the later's winning. */
const mergeHeld = (held: HeldChange, next: HeldChange): HeldChange => ({
  model: mergedModel(held.model, next.model),
  permissionMode: next.permissionMode ?? held.permissionMode,
});

/** Two model changes as one: the later's model, and the settings of both, the later's winning. */
const mergedModel = (held: Change | undefined, next: Change | undefined): Change | undefined => {
  if (next === undefined) return held;
  if (held === undefined) return next;
  return { ...next, ...(held.settings === undefined && next.settings === undefined ? {} : { settings: { ...held.settings, ...next.settings } }) };
};

/** The model the facts will ask from the next turn, with the change held, if any. */
const withHeld = (configured: Target, held: HeldChange | undefined): Target => {
  const change = held?.model;
  if (change === undefined) return configured;
  const settings = { ...configured.settings, ...change.settings };
  return { provider: change.provider, model: change.model, ...(Object.keys(settings).length === 0 ? {} : { settings }) };
};

/** A session this connection holds: one it made, a draft until its first prompt and then open, or one it started from its facts, open. */
interface Entry {
  readonly id: AcpSessionId;
  readonly cwd: string;
  /** Its world, with the MCP servers' tools after the world's own. */
  readonly world: WorldSession;
  /** The entry's scope, from `session/new` (or load, or resume) to `session/close`: its MCP servers, and its open session's scope, are in it. */
  readonly scope: Scope.Closeable;
  readonly mcp: McpServers;
  /** Held while the draft opens and while a configuration change is taken, so neither is lost. */
  readonly lock: Semaphore.Semaphore;
  state: { readonly _tag: "Draft"; readonly draft: Draft } | { readonly _tag: "Open"; readonly opened: Opened };
  /** The prompt running, if one is. */
  prompt: Fiber.Fiber<unknown, unknown> | undefined;
  /** How tool calls are allowed: the host's to keep, read at each call, changed by the user; it starts as the configuration says. */
  readonly permissionMode: Ref.Ref<PermissionMode>;
  /** The session's configuration (AG25): its seam lists, and its MCP servers. */
  readonly configuration: Configured;
}

/**
 * The model the facts will ask from the next turn: the one `modelOf` gives, with each change that
 * arrived and is not taken yet (a change taken during a turn waits for a step or the turn's end).
 */
const configuredOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> =>
  Effect.map(modelOf(facts), (now) => {
    const taken = new Set(facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : [])));
    return facts.reduce<Target>((target, fact) => {
      if (fact._tag !== "Observed" || fact.observation._tag !== "ModelChangeArrived" || taken.has(fact.seq)) return target;
      const change = fact.observation;
      const settings = { ...target.settings, ...change.settings };
      return { provider: change.provider, model: change.model, ...(Object.keys(settings).length === 0 ? {} : { settings }) };
    }, now);
  });

/** The text a prompt gives the session: its text blocks, and each resource link as a line. */
const promptText = (prompt: ReadonlyArray<ContentBlock>): string => prompt.flatMap(linesOf).join("\n");

/** The text a block gives the prompt's text: a text block's text, a resource link as a line; nothing of a file. */
const linesOf = (block: ContentBlock): ReadonlyArray<string> => {
  switch (block.type) {
    case "text":
      return [block.text];
    case "resource_link":
      return [`[${block.name}](${block.uri})`];
    case "image":
    case "audio":
    case "resource":
      return [];
    default:
      return block satisfies never;
  }
};

/** The last part of `uri`'s path, as a file's name. */
const nameIn = (uri: string | null | undefined): string | undefined => {
  const last = uri?.split(/[/\\]/).filter((part) => part !== "").at(-1);
  return last === undefined || last === "" ? undefined : decodeURIComponent(last);
};

/** What a block attaches to the input: an image, or an embedded resource, put in the blob store. */
const attachmentsOf = (blobs: BlobStore, block: ContentBlock): Effect.Effect<ReadonlyArray<BlobRef>> => {
  if (block.type === "image") return Effect.map(blobs.store(Buffer.from(block.data, "base64"), MediaType.make(block.mimeType), nameIn(block.uri)), (stored): ReadonlyArray<BlobRef> => [stored]);
  if (block.type !== "resource") return Effect.succeed([]);
  const resource = block.resource;
  const bytes = "text" in resource ? new TextEncoder().encode(resource.text) : Buffer.from(resource.blob, "base64");
  const mediaType = resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream");
  return Effect.map(blobs.store(bytes, MediaType.make(mediaType), nameIn(resource.uri)), (stored): ReadonlyArray<BlobRef> => [stored]);
};

/**
 * The input a prompt's blocks give: its text (`promptText`), and each image and embedded resource
 * (an editor's file, as text or bytes) put in the session's blob store and attached by reference.
 */
const promptInput = (prompt: ReadonlyArray<ContentBlock>) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const attachments = (yield* Effect.forEach(prompt, (block) => attachmentsOf(blobs, block))).flat();
    return { text: InputText.make(promptText(prompt)), ...(attachments.length === 0 ? {} : { attachments }) };
  });

/** The variable that names the model sessions start with, as `brand`'s launcher reads it. */
const modelVariableOf = (brand: Brand): string => `${envPrefixOf(brand)}ACP_MODEL`;

/** What `session/new` says when no model can be asked. */
const noModelOf = (brand: Brand) =>
  `No model to ask: set ${Object.values(keyVariables).join(", ")} for a provider's models, or start the local server at ${localServer}, or name one with ${modelVariableOf(brand)} as provider/model.`;

/** When a change of the model or its settings applies, as the log says it. */
const whenApplied = (said: "draft" | "made" | "held"): string => {
  switch (said) {
    case "draft":
      return "to the draft";
    case "made":
      return "now: no turn runs";
    case "held":
      return "when the turn ends";
    default:
      return said satisfies never;
  }
};

/** The world a host's sessions open: the editor's unless it says the local disk's, or gives its own. */
const worldOf = <R>(world: HostOptions<R>["world"]): World<R> | World<FileSystem.FileSystem> => {
  if (world === undefined || world === "editor") return editorWorld;
  return world === "local" ? workspaceWorld : world;
};

/** The world as the settings written name it. */
const worldKindOf = <R>(world: HostOptions<R>["world"]): string => {
  if (world === undefined) return "editor";
  return typeof world === "string" ? world : "the host's own";
};

/**
 * The ACP host as an implementation of protocol v1. It needs the model catalog (`ModelCatalog`),
 * the file system (session folders, exports) and what the world needs.
 */
export const makeHost = <R = never>(options: HostOptions<R>) => {
  const world = worldOf(options.world);
  const services = options.services ?? SessionServices;
  const brand = options.brand ?? defaultBrand;
  const defaults = acpDefaults(options);
  const worldKind = worldKindOf(options.world);
  return Agent.implement<Protocol.V1Version, ModelCatalog | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | R>(Protocol.v1, {
    capabilities: {
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      loadSession: true,
      sessionCapabilities: { close: {}, list: {}, resume: {} },
      mcpCapabilities: { http: true, sse: true },
    },
    handlers: (connection) =>
      Effect.gen(function* () {
        const connectionScope = yield* Scope.Scope;
        const connectionId = crypto.randomUUID().slice(0, 8);
        // What is known of each model, and how its settings apply: the local server asked once per connection.
        const known = yield* Layer.buildWithScope(Layer.mergeAll(KnownWithLocalServer, SettlingWithLocalServer), connectionScope);
        const entries = yield* Ref.make(HashMap.empty<string, Entry>());
        /** The sessions `session/load` or `session/resume` is starting: not yet among `entries`, and not to be started twice. */
        const starting = yield* Ref.make(HashSet.empty<string>());

        const traced = <A, E, X>(effect: Effect.Effect<A, E, X>, session?: string) =>
          effect.pipe(Effect.annotateLogs({ connection: connectionId, ...(session === undefined ? {} : { session }) }));

        const entryOf = (sessionId: string): Effect.Effect<Entry, JsonRpcErrorObject> =>
          Effect.flatMap(Ref.get(entries), (all) =>
            Option.match(HashMap.get(all, sessionId), {
              onSome: Effect.succeed,
              onNone: () =>
                Effect.logWarning(logKeys.session.unknown, { sessionId }).pipe(
                  Effect.andThen(Effect.fail(rpcError(ErrorCode.ResourceNotFound, `Session ${sessionId} not found on this connection`, { sessionId }))),
                ),
            }),
          );

        const send = (sessionId: AcpSessionId, update: SessionUpdate) =>
          connection
            .notify("session/update", { sessionId, update })
            .pipe(Effect.catch((error) => Effect.logWarning(logKeys.update.notSent, { kind: update.sessionUpdate, cause: error.message })));

        const capabilitiesOf = (target: { readonly provider: Asked["provider"]; readonly model: Asked["model"] }) =>
          knownCapabilities(target.provider, target.model).pipe(Effect.provideContext(known));

        /** The configuration of the session as it will be from the next turn, with what a change is taken against. */
        /**
         * The configuration of a session in `cwd` whose client names `servers` (AG25): the host's defaults, the launcher's
         * layers with `cwd` as the project, then the client's servers. One that cannot be used refuses the request.
         */
        const configurationFor = (cwd: string, servers: ReadonlyArray<McpServer>, doing: string): Effect.Effect<Configured, JsonRpcErrorObject, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            const flags = options.configFlags ?? { mcpConfig: [], strictMcpConfig: false };
            const layers = [...(yield* launchLayers(cwd, defaults, flags, { name: brand.name, ...(options.home === undefined ? {} : { home: options.home }) })), ...clientLayers(cwd, servers)];
            return { ...(yield* loadConfiguration(layers)), layers };
          }).pipe(
            Effect.catchTag("ConfigInvalid", (error) =>
              Effect.logWarning(logKeys.session.refused, { doing, cwd, cause: "the configuration cannot be used", problem: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The configuration cannot be used: ${error.message}`))),
              ),
            ),
          );

        /** What a command the model runs on the local disk is given of the environment: what the configuration composes. */
        const environmentFor = (configuration: Configured) => environmentOf(seamListsOf(configuration, { canAsk: true }).commandEnvironment ?? [credentialsLeftOut()]);

        /** Writes what a session's configuration resolved to, with what the host says beside it, to the session's folder (AG25). */
        const settingsWritten = (id: AcpSessionId, configuration: Configured, permissionMode: PermissionMode, model: string) =>
          writeEffectiveSettings(sessionFolderOf(options.directory, id), configuration.layers, configuration, {
            model,
            permissionMode,
            canAsk: true,
            strictToolInput: options.strictToolInput ?? false,
            world: worldKind,
          }).pipe(
            Effect.tap((path) => Effect.logInfo(logKeys.settings.written, { path })),
            Effect.catch((error) => Effect.logWarning(logKeys.settings.notWritten, { folder: sessionFolderOf(options.directory, id), cause: error.message })),
          );

        /**
         * The MCP servers of a session in `cwd`, started at once in a scope of the entry's own, and the world with their tools
         * after its own (agent-mcp MK1): the configuration's, the client's among them (AG25), and those the client names at a URL,
         * which are not supported. Two servers whose tools would be offered under one name are -32602, before anything is
         * started. A server the configuration says is required that is not running once they have settled refuses the request,
         * and the servers are stopped (AG26).
         */
        const withServers = (cwd: string, opened: WorldSession, configuration: Configured, doing: string) =>
          Effect.gen(function* () {
            const given = configuration.mcpServers.map(
              (server): GivenServer => ({ server: "url" in server ? server : { ...server, cwd: server.cwd ?? cwd }, connectTimeout: server.connectTimeout }),
            );
            const names = given.map((each) => each.server.name);
            const namespaces = names.map(namespaceOf);
            const twice = namespaces.find((each, index) => namespaces.indexOf(each) !== index);
            if (twice !== undefined) {
              const named = names.filter((name) => namespaceOf(name) === twice);
              yield* Effect.logWarning(logKeys.session.refused, { doing, cwd, cause: "two MCP servers would offer their tools under one name", servers: named, namespace: twice });
              return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `The MCP servers ${named.join(" and ")} would offer their tools under one name, ${twice}`, { servers: named }));
            }
            const scope = yield* Scope.fork(connectionScope);
            return yield* Effect.gen(function* () {
            const mcp = yield* startMcpServers(given, [{ uri: pathToFileURL(cwd).href, name: basename(cwd) }], {
              connectTimeout: options.mcpConnectTimeout,
              clientInfo: { name: brand.name, version: brand.version },
            }).pipe(
              Scope.provide(scope),
            );
            const states = yield* mcp.states;
            const missing = configuration.mcpServers.flatMap((server) => {
              const state = states.find((each) => each.name === server.name)?.state;
              return server.required && state !== undefined && state._tag !== "Ready" ? [{ name: server.name, said: describe(state) }] : [];
            });
            if (missing.length > 0) {
              yield* Effect.logWarning(logKeys.session.refused, { doing, cwd, cause: "a required MCP server is not running", servers: missing });
              return yield* Effect.fail(
                rpcError(ErrorCode.InternalError, `The session needs MCP servers that are not running: ${missing.map((server) => `${server.name} (${server.said})`).join("; ")}.`, {
                  servers: missing.map((server) => server.name),
                }),
              );
            }
            const { catalog } = yield* toolsOf(mcp.sources);
            const mcpPresent = presentFrom(catalog);
            const world: WorldSession = {
              system: opened.system,
              sources: [...opened.sources, ...mcp.sources],
              // A call is shown with its result as the model is sent it: an MCP server's as text, whether or not the server is here now.
              present: (call, outcome) => {
                const sent = outcome === undefined ? undefined : outcomeAsSent(outcome);
                return catalog.some((tool) => tool.name === call.tool) ? mcpPresent(call, sent) : opened.present(call, sent);
              },
            };
            return { world, scope, mcp };
            }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
          });

        /** `/mcp`: each MCP server and its state; `/mcp reconnect <server>` starts it again and says how it went. Said in a message. */
        const mcpOf = (entry: Entry, words: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const say = (text: string) => send(entry.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
            const offered = (yield* toolsOf(entry.world.sources)).catalog.map((tool) => tool.name as string);
            yield* say(yield* mcpSaid(entry.mcp, words, offered));
            return { stopReason: "end_turn" as const };
          });

        /** Gives a user's change to the open session's gate; a change that could not be recorded is -32603. */
        const submitted = (opened: Opened, change: HeldChange, configId: string) =>
          opened.gate.submit(change).pipe(
            Effect.catchTag("SessionStoreFailed", (error) =>
              Effect.logError(logKeys.config.refused, { configId, doing: "recording the change", cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The change could not be recorded: ${error.message}`))),
              ),
            ),
          );

        /** Makes the change the open session's gate holds, if no turn runs; one that could not be recorded is logged. */
        const settled = (entry: Entry) =>
          entry.state._tag === "Open"
            ? entry.state.opened.gate.settle.pipe(
                Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.config.refused, { doing: "recording a change held until the turn ended", cause: error.message })),
              )
            : Effect.void;

        const configurationOf = (entry: Entry) =>
          Effect.gen(function* () {
            const held = entry.state._tag === "Open" ? yield* entry.state.opened.gate.held : undefined;
            const configured: Options =
              entry.state._tag === "Draft"
                ? yield* optionsOfDraft(entry.state.draft)
                : yield* optionsFor(withHeld(yield* Effect.flatMap(entry.state.opened.session.facts, configuredOf), held));
            const models = yield* askable;
            const limit = (yield* capabilitiesOf(configured))?.output;
            return {
              configured,
              models,
              limit,
              options: [...configOptions(configured, models, limit), permissionOption(held?.permissionMode ?? (yield* Ref.get(entry.permissionMode)))] as ReadonlyArray<SessionConfigOption>,
            };
          }).pipe(Effect.provideContext(known));

        /** The model `session/new` starts with, or why there is none. */
        const startingModel: Effect.Effect<Asked, JsonRpcErrorObject, ModelCatalog> =
          options.model === undefined
            ? Effect.filterOrFail(defaultModel, (model): model is Asked => model !== undefined, () => rpcError(ErrorCode.InternalError, noModelOf(brand)))
            : targetOf(options.model).pipe(
                Effect.mapError((error) => {
                  switch (error._tag) {
                    case "ModelNotFound":
                      return rpcError(
                        ErrorCode.InternalError,
                        `${modelVariableOf(brand)} names ${error.name}, which no source has${error.close.length === 0 ? "" : `; close: ${error.close.join(", ")}`}.`,
                      );
                    case "KeyNotSet":
                      return rpcError(ErrorCode.InternalError, `${modelVariableOf(brand)} names a model of ${error.provider}: set ${error.variable}.`);
                    case "SourceNotAnswering":
                      return rpcError(ErrorCode.InternalError, `${modelVariableOf(brand)} names a model of ${error.provider}, whose server at ${error.at ?? "?"} does not answer.`);
                  }
                }),
              );

        /**
         * Starts the session `id` over its facts file in a scope of its own, forked from the connection's: its services, the core's
         * session, then what `go` does with them. `go` starts the session's feed (`follow`, from the projection's state it gives) at the
         * point from which the feed is to send what is recorded. Whatever fails closes the scope: nothing is left open.
         */
        const startSession = <A extends { readonly feed: Feed }, E, X>(
          id: AcpSessionId,
          world: WorldSession,
          permissionMode: Ref.Ref<PermissionMode>,
          parent: { readonly scope: Scope.Scope; readonly mcp: McpServers; readonly configuration: Configured },
          go: (session: Session, context: Context.Context<Services>, follow: (initial: ProjectionState) => Effect.Effect<Feed>) => Effect.Effect<A, E, X>,
        ) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(parent.scope);
            return yield* Effect.gen(function* () {
              const file = storeFileOf(options.directory, id);
              // The session's blobs (its inputs' images and files) are kept in its folder, so a session gone on from its facts has them.
              const blobs = BlobsInFolder(join(sessionFolderOf(options.directory, id), "blobs"));
              // The configuration's seam lists, permission following the session's mode (agent-config CF2); its tool sources are not
              // offered: the session's are the world's and its MCP servers'.
              const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(parent.configuration, { canAsk: true, permissionMode: Ref.get(permissionMode) });
              const runner = SourcedToolRunner.pipe(Layer.provide(Layer.succeed(ToolSources, world.sources)));
              // The model is told of the session's MCP servers that are not running (agent-mcp MK2).
              const notices = Layer.succeed(Notices, [parent.mcp.notices]);
              const layer = Layer.mergeAll(services(runner).pipe(Layer.provide(notices)), seamLayer(lists), blobs).pipe(Layer.provideMerge(FileBackedSessionStore(file)));
              const context = yield* Layer.buildWithScope(layer, scope);
              const session = yield* openSession.pipe(Effect.provideContext(context), Scope.provide(scope));

              const follow = (initial: ProjectionState) =>
                startFeed({ sessionId: id, session, context, present: world.present, connection, annotations: { connection: connectionId, session: id }, initial }).pipe(
                  Scope.provide(scope),
                );

              const gate = yield* makeConfigurationGate<HeldChange, SessionStoreFailed>({
                running: Effect.map(session.turn, (turn) => turn !== undefined),
                merge: mergeHeld,
                make: (change) =>
                  Effect.gen(function* () {
                    if (change.permissionMode !== undefined) yield* Ref.set(permissionMode, change.permissionMode);
                    if (change.model !== undefined)
                      yield* session.observe({ _tag: "ModelChangeArrived", ...change.model }).pipe(Effect.provideContext(context), reportedBy(acpUser));
                    yield* Effect.logInfo(logKeys.config.made, { model: change.model, permissionMode: change.permissionMode });
                  }),
              });
              const made = yield* go(session, context, follow);
              // Once the session's facts have their opening: its MCP servers' states, and each change of them (agent-mcp MK3).
              yield* parent.mcp.changes.pipe(
                Stream.runForEach((change) =>
                  session.observe(change).pipe(
                    Effect.provideContext(context),
                    reportedBy(harnessParts.mcpServers),
                    Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.mcp.notRecorded, { server: change.server, state: change.state, cause: error.message })),
                  ),
                ),
                Effect.forkIn(scope),
              );
              return { ...made, session, context, scope, gate };
            }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
          });

        /**
         * Opens the entry's draft at its first prompt (turn zero): its record (`host.json`: the working folder, and the title `text`
         * gives), its folder, its services in a scope of its own, its feed, then `SessionOpened`; then `session_info_update`.
         */
        const open = (entry: Entry, draft: Draft, text: string) =>
          Effect.gen(function* () {
            const failed = (doing: string) => (error: { readonly message: string }) =>
              Effect.logError(logKeys.session.notOpened, { doing, cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session could not be opened: ${error.message}`))),
              );

            const record = recordFor(entry.cwd, text);
            yield* writeRecord(options.directory, entry.id, record).pipe(Effect.catch(failed("writing the session's record at its first prompt")));
            yield* Effect.logInfo(logKeys.record.written, { file: recordFileOf(options.directory, entry.id), cwd: record.cwd, titled: record.title !== undefined });
            yield* settingsWritten(entry.id, entry.configuration, yield* Ref.get(entry.permissionMode), `${draft.model.provider}/${draft.model.model}`);
            const opened = yield* startSession(entry.id, entry.world, entry.permissionMode, { scope: entry.scope, mcp: entry.mcp, configuration: entry.configuration }, (session, context, follow) =>
              Effect.gen(function* () {
                // The feed first: the session has no facts yet, and it sends everything from the opening on, live.
                const feed = yield* follow(start);
                yield* session.observe(opening(draft, SessionId.make(entry.id))).pipe(Effect.provideContext(context), reportedBy(acpUser));
                return { feed };
              }),
            ).pipe(Effect.catch(failed("opening the draft at its first prompt")));
            yield* Effect.logInfo(logKeys.session.opened, { file: storeFileOf(options.directory, entry.id), model: `${draft.model.provider}/${draft.model.model}` });
            const now = new Date(yield* Clock.currentTimeMillis).toISOString();
            yield* send(entry.id, { sessionUpdate: "session_info_update", title: record.title ?? null, updatedAt: now });
            return opened satisfies Opened;
          });

        /** `/export`: the transcript to `<cwd>/.<brand>/exports/<id>.md`, said in a message. */
        const exportOf = (entry: Entry) =>
          Effect.gen(function* () {
            const say = (text: string) => send(entry.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
            if (entry.state._tag === "Draft") {
              yield* say("Nothing to export: this session has had no turn yet.");
              return { stopReason: "end_turn" as const };
            }
            const path = join(entry.cwd, folderOf(brand), "exports", `${entry.id}.md`);
            const markdown = markdownOf(yield* entry.state.opened.session.facts);
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(join(entry.cwd, folderOf(brand), "exports"), { recursive: true }).pipe(
              Effect.andThen(fs.writeFileString(path, markdown)),
              Effect.catch((error) =>
                Effect.logError(logKeys.export.failed, { path, doing: "writing the transcript", cause: error.message }).pipe(
                  Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The transcript could not be written to ${path}: ${error.message}`))),
                ),
              ),
            );
            yield* Effect.logInfo(logKeys.export.written, { path, bytes: Buffer.byteLength(markdown) });
            yield* say(`Exported this session to ${path}`);
            return { stopReason: "end_turn" as const };
          });

        /** Records the turn's interruption, and logs it, as a client's `session/cancel` does. */
        const cancelTurn = (entry: Entry, by: string) =>
          Effect.gen(function* () {
            if (entry.state._tag === "Draft") return;
            const { session, context } = entry.state.opened;
            const turn = yield* session.turn;
            yield* Effect.logInfo(logKeys.cancel.requested, { by, ...(turn === undefined ? { underWay: false } : { turn }) });
            yield* session.cancel.pipe(Effect.provideContext(context), reportedBy(acpUser));
          }).pipe(
            Effect.catchTag("SessionStoreFailed", (error) =>
              Effect.logError(logKeys.prompt.failed, { doing: "recording the turn's interruption", cause: error.message }),
            ),
          );

        /** Opens the draft if it is one, runs the turn, waits for the feed to take its end, sends the usage and gives the stop. */
        const turnOf = (entry: Entry, text: string, blocks: ReadonlyArray<ContentBlock>) =>
          Effect.gen(function* () {
            const began = yield* Clock.currentTimeMillis;
            const opened = yield* entry.lock.withPermit(
              Effect.gen(function* () {
                if (entry.state._tag === "Open") return entry.state.opened;
                const made = yield* open(entry, entry.state.draft, text);
                entry.state = { _tag: "Open", opened: made };
                return made;
              }),
            );
            const { session, context, feed } = opened;
            yield* Effect.logInfo(logKeys.prompt.admitted, { characters: text.length });
            const input = yield* promptInput(blocks).pipe(Effect.provideContext(context));
            yield* session.prompt(input).pipe(
              Effect.provideContext(context),
              reportedBy(acpUser),
              Effect.catchTag("SessionStoreFailed", (error) =>
                Effect.logError(logKeys.prompt.failed, { doing: "recording the turn", cause: error.message }).pipe(
                  Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session's facts could not be written: ${error.message}`))),
                ),
              ),
            );
            const facts = yield* session.facts;
            // The prompt returns at its turn's end, and no other turn starts meanwhile: one prompt runs at a time.
            const turn = facts.reduce<TurnId | undefined>((last, fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? fact.decision.turn : last), undefined);
            if (turn === undefined) return yield* Effect.die(new Error("A prompt returned with no turn ended"));
            yield* feed.turnEnded(turn);
            const usage = yield* usageUpdate(facts).pipe(Effect.provideContext(context));
            if (usage !== undefined) {
              yield* send(entry.id, usage);
              yield* Effect.logDebug(logKeys.usage.sent, { used: usage.used, size: usage.size });
            }
            const stop = stopOf(facts, turn);
            const took = (yield* Clock.currentTimeMillis) - began;
            if (stop === undefined) return yield* Effect.die(new Error(`Turn ${turn} has no stop though it ended`));
            if ("error" in stop) {
              yield* Effect.logWarning(logKeys.prompt.settled, { error: stop.error.message, code: stop.error.code, ms: took }).pipe(Effect.annotateLogs({ turn }));
              return yield* Effect.fail(stop.error);
            }
            yield* Effect.logInfo(logKeys.prompt.settled, { stopReason: stop.stopReason, ms: took }).pipe(Effect.annotateLogs({ turn }));
            return { stopReason: stop.stopReason };
          });

        /** The title in the session's record: none when it has no record (the CLI made it), or one that does not read, which is logged. */
        const recordedTitle = (sessionId: AcpSessionId) => {
          const file = recordFileOf(options.directory, sessionId);
          return readRecord(options.directory, sessionId).pipe(
            Effect.flatMap((record) => {
              const read = record === undefined ? undefined : readSessionRecord(record);
              return record !== undefined && read === undefined
                ? Effect.fail(new RecordFailed({ file, message: `${file} is not a session record: it has no cwd` }))
                : Effect.succeed(read?.title);
            }),
            Effect.catch((error) =>
              Effect.logWarning(logKeys.record.unreadable, { file, cause: error.message, consequence: "the session's title is not sent" }).pipe(Effect.as(undefined)),
            ),
          );
        };

        /** What the host sends of a session started from its facts once the client knows it: the commands, its title and last write, and its usage. */
        const announce = (entry: Entry, opened: Opened) =>
          Effect.gen(function* () {
            yield* send(entry.id, { sessionUpdate: "available_commands_update", availableCommands: [exportCommandOf(brand), mcpCommand] });
            const title = yield* recordedTitle(entry.id);
            const fs = yield* FileSystem.FileSystem;
            const written = yield* fs.stat(storeFileOf(options.directory, entry.id)).pipe(
              Effect.map((info) => Option.getOrUndefined(info.mtime)),
              Effect.orElseSucceed(() => undefined),
            );
            const updatedAt = written ?? new Date(yield* Clock.currentTimeMillis);
            yield* send(entry.id, { sessionUpdate: "session_info_update", title: title ?? null, updatedAt: updatedAt.toISOString() });
            const usage = yield* Effect.flatMap(opened.session.facts, usageUpdate).pipe(Effect.provideContext(opened.context));
            if (usage !== undefined) {
              yield* send(entry.id, usage);
              yield* Effect.logDebug(logKeys.usage.sent, { used: usage.used, size: usage.size });
            }
          });

        /**
         * `session/load` or `session/resume`: the stored session started on this connection, with the world opened for `cwd` and
         * `mcpServers`. A turn its facts left running is ended, with nothing run again. On load the facts, as they are then, are sent as
         * the projection replays them, before the answer. The feed goes on from the state they leave, so nothing is sent twice; only then
         * does the session go on (input left waiting starts its turn, which the feed sends). The entry is held once it started; after the
         * answer the host sends what it sends of a session (`announce`).
         */
        const reopen = (
          method: "session/load" | "session/resume",
          params: { readonly sessionId: AcpSessionId; readonly cwd: string; readonly mcpServers: ReadonlyArray<McpServer> },
        ) =>
          Effect.gen(function* () {
            const { sessionId, cwd, mcpServers } = params;
            if (!isAbsolute(cwd)) {
              yield* Effect.logWarning(logKeys.session.refused, { doing: method, cwd, cause: "the working folder is not an absolute path" });
              return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `cwd must be an absolute path: ${cwd}`));
            }
            if (HashMap.has(yield* Ref.get(entries), sessionId) || HashSet.has(yield* Ref.get(starting), sessionId)) {
              yield* Effect.logWarning(logKeys.session.refused, { doing: method, cause: "the session is already loaded on this connection" });
              return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `Session ${sessionId} is already loaded on this connection`, { sessionId }));
            }
            const file = storeFileOf(options.directory, sessionId);

            const notStarted = (doing: string) => (error: { readonly message: string }) =>
              Effect.logError(logKeys.session.notLoaded, { doing: `${method}: ${doing}`, file, cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(-32000, `Session ${sessionId} could not be started: ${error.message}`, { sessionId }))),
              );

            const stored = yield* (yield* FileSystem.FileSystem).exists(file).pipe(Effect.catch(notStarted("looking for the session's facts file")));
            if (!stored) {
              yield* Effect.logWarning(logKeys.session.notStored, { doing: method, file, cause: "the session directory has no facts file for the session" });
              return yield* Effect.fail(rpcError(ErrorCode.ResourceNotFound, `Session ${sessionId} not found in ${options.directory}`, { sessionId }));
            }
            yield* Ref.update(starting, (all) => HashSet.add(all, sessionId));
            return yield* Effect.gen(function* () {
              const configuration = yield* configurationFor(cwd, mcpServers, method);
              const own = yield* (world as World<R | FileSystem.FileSystem>).open({
                sessionId,
                cwd,
                mcpServers,
                connection,
                strictInput: options.strictToolInput ?? false,
                environment: environmentFor(configuration),
              });
              const { world: its, scope, mcp } = yield* withServers(cwd, own, configuration, method);
              return yield* Effect.gen(function* () {
              // The policy reads the session's mode at each call; it starts as the configuration says.
              const initialMode = startingModeOf(configuration);
              const mode = yield* Ref.make(initialMode);
              const opened = yield* startSession(sessionId, its, mode, { scope, mcp, configuration }, (session, context, follow) =>
                Effect.gen(function* () {
                  const left = leftRunning(yield* session.facts);
                  if (left !== undefined) {
                    yield* endTurnLeftRunning(session).pipe(Effect.provideContext(context));
                    yield* Effect.logInfo(logKeys.session.turnLeftRunningEnded, { stopping: left.stopping, requests: left.requests.length }).pipe(
                      Effect.annotateLogs({ turn: left.turn }),
                    );
                  }
                  const replayed = project(yield* session.facts, { mode: "replay", present: its.present });
                  if (method === "session/load") yield* Effect.forEach(replayed.updates, (update) => send(sessionId, update), { discard: true });
                  const feed = yield* follow(replayed.state);
                  if (left === undefined) yield* session.goOn.pipe(Effect.provideContext(context));
                  return { feed, replayed: method === "session/load" ? replayed.updates.length : 0, left: left?.turn };
                }),
              ).pipe(Effect.catch(notStarted("starting the stored session")));
              const entry: Entry = {
                id: sessionId,
                cwd,
                world: its,
                scope,
                mcp,
                lock: yield* Semaphore.make(1),
                state: { _tag: "Open", opened },
                prompt: undefined,
                permissionMode: mode,
                configuration,
              };
              yield* Ref.update(entries, (all) => HashMap.set(all, sessionId, entry));
              const now = yield* configuredOf(yield* opened.session.facts);
              yield* settingsWritten(sessionId, configuration, initialMode, `${now.provider}/${now.model}`);
              const { options: configured } = yield* configurationOf(entry);
              yield* Effect.logInfo(method === "session/load" ? logKeys.session.loaded : logKeys.session.resumed, {
                cwd,
                file,
                facts: (yield* opened.session.facts).length,
                replayed: opened.replayed,
                turnsLeftRunning: opened.left === undefined ? [] : [opened.left],
                tools: (yield* toolsOf(its.sources)).catalog.map((tool) => tool.name),
                mcpServers: mcpServers.length,
              });
              // The updates follow the response: the response is written before this handler's fiber ends.
              const self = yield* Effect.fiber;
              yield* Effect.forkIn(Fiber.await(self).pipe(Effect.andThen(announce(entry, opened)), Effect.annotateLogs({ session: sessionId })), connectionScope);
              return { configOptions: configured };
              }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
            }).pipe(
              Effect.ensuring(Ref.update(starting, (all) => HashSet.remove(all, sessionId))),
            );
          });

        const handlers: Agent.AgentHandlers<Protocol.V1Version, ModelCatalog | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | R> = {
          "session/new": ({ cwd, mcpServers }) =>
            traced(
              Effect.gen(function* () {
                if (!isAbsolute(cwd)) {
                  yield* Effect.logWarning(logKeys.session.refused, { cwd, cause: "the working folder is not an absolute path" });
                  return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `cwd must be an absolute path: ${cwd}`));
                }
                const model = yield* startingModel.pipe(
                  Effect.tapError((error) => Effect.logWarning(logKeys.session.refused, { cwd, cause: error.message })),
                );
                const configuration = yield* configurationFor(cwd, mcpServers, "session/new");
                const id = AcpSessionId.make(crypto.randomUUID());
                const own = yield* (world as World<R | FileSystem.FileSystem>).open({
                  sessionId: id,
                  cwd,
                  mcpServers,
                  connection,
                  strictInput: options.strictToolInput ?? false,
                  environment: environmentFor(configuration),
                });
                const { world: opened, scope, mcp } = yield* withServers(cwd, own, configuration, "session/new");
                return yield* Effect.gen(function* () {
                const capabilities = yield* capabilitiesOf(model);
                const { catalog } = yield* toolsOf(opened.sources);
                const draft = withDefaults(
                  draftOf({ model, tools: catalog, ...(opened.system === undefined ? {} : { system: opened.system }) }),
                  capabilities,
                );
                const entry: Entry = {
                  id,
                  cwd,
                  world: opened,
                  scope,
                  mcp,
                  lock: yield* Semaphore.make(1),
                  state: { _tag: "Draft", draft },
                  prompt: undefined,
                  permissionMode: yield* Ref.make(startingModeOf(configuration)),
                  configuration,
                };
                yield* Ref.update(entries, (all) => HashMap.set(all, id, entry));
                const { options: configured } = yield* configurationOf(entry);
                yield* Effect.logInfo(logKeys.session.created, {
                  cwd,
                  model: `${model.provider}/${model.model}`,
                  tools: catalog.map((tool) => tool.name),
                  mcpServers: mcpServers.length,
                }).pipe(Effect.annotateLogs({ session: id }));
                // The update follows the response: the response is written before this handler's fiber ends.
                const self = yield* Effect.fiber;
                yield* Effect.forkIn(
                  Fiber.await(self).pipe(
                    Effect.andThen(send(id, { sessionUpdate: "available_commands_update", availableCommands: [exportCommandOf(brand), mcpCommand] })),
                    Effect.annotateLogs({ session: id }),
                  ),
                  connectionScope,
                );
                return { sessionId: id, configOptions: configured };
                }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
              }),
            ),

          "session/load": ({ sessionId, cwd, mcpServers }) => traced(reopen("session/load", { sessionId, cwd, mcpServers }), sessionId),

          "session/resume": ({ sessionId, cwd, mcpServers }) => traced(reopen("session/resume", { sessionId, cwd, mcpServers: mcpServers ?? [] }), sessionId),

          "session/list": (params) =>
            traced(
              Effect.gen(function* () {
                const stored = yield* recordedSessions(options.directory).pipe(
                  Effect.catchTag("DirectoryUnreadable", (error) =>
                    Effect.logError(logKeys.session.notListed, { directory: options.directory, doing: "reading the session directory", cause: error.message }).pipe(
                      Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session directory ${options.directory} could not be read: ${error.message}`))),
                    ),
                  ),
                );
                const page = pageOf(stored, params, options.pageSize ?? 50);
                if (page instanceof InvalidCursor) {
                  yield* Effect.logWarning(logKeys.session.notListed, { cursor: page.cursor, cause: "the cursor is not one session/list gave" });
                  return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `Invalid cursor ${page.cursor}: it is not one session/list gave`, { cursor: page.cursor }));
                }
                yield* Effect.logInfo(logKeys.session.listed, { cwd: params.cwd ?? null, returned: page.sessions.length, more: typeof page.nextCursor === "string" });
                return page;
              }),
            ),

          "session/set_config_option": (params) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(params.sessionId);
                const { configId } = params;
                return yield* entry.lock.withPermit(
                  Effect.gen(function* () {
                    if (configId === permissionId) {
                      const mode = typeof params.value === "string" ? permissionModeOf(params.value) : new InvalidChange({ reason: `Option ${configId} takes a value of a select.` });
                      if (mode instanceof InvalidChange) {
                        yield* Effect.logWarning(logKeys.config.refused, { configId, value: params.value, cause: mode.reason });
                        return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, mode.reason, { configId }));
                      }
                      const said = entry.state._tag === "Draft" ? "made" : yield* submitted(entry.state.opened, { permissionMode: mode }, configId);
                      if (entry.state._tag === "Draft") yield* Ref.set(entry.permissionMode, mode);
                      yield* Effect.logInfo(logKeys.config.changed, { configId, value: mode, applies: said === "made" ? "now: no turn runs" : "when the turn ends" });
                      return { configOptions: (yield* configurationOf(entry)).options };
                    }
                    const now = yield* configurationOf(entry);
                    const change =
                      typeof params.value === "string"
                        ? changeOf(configId, params.value, now.configured, now.models, now.limit)
                        : new InvalidChange({ reason: `Option ${configId} takes a value of a select, not ${JSON.stringify(params.value)}.` });
                    if (change instanceof InvalidChange) {
                      yield* Effect.logWarning(logKeys.config.refused, { configId, value: params.value, cause: change.reason });
                      return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, change.reason, { configId }));
                    }
                    if (entry.state._tag === "Draft") {
                      const draft = entry.state.draft;
                      const moved =
                        change.provider === draft.model.provider && change.model === draft.model.model
                          ? draft
                          : chooseModel(draft, { provider: change.provider, model: change.model });
                      entry.state = { _tag: "Draft", draft: change.settings === undefined ? moved : saySettings(moved, change.settings) };
                    }
                    const said = entry.state._tag === "Draft" ? "draft" : yield* submitted(entry.state.opened, { model: change }, configId);
                    yield* Effect.logInfo(logKeys.config.changed, {
                      configId,
                      value: params.value,
                      applies: whenApplied(said),
                    });
                    return { configOptions: (yield* configurationOf(entry)).options };
                  }),
                ).pipe(
                  // The options are sent as an update too: a client may draw its controls from updates alone (labkit's does).
                  Effect.tap(({ configOptions }) => send(entry.id, { sessionUpdate: "config_option_update", configOptions })),
                );
              }),
              params.sessionId,
            ),

          "session/prompt": ({ sessionId, prompt }) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(sessionId);
                const text = promptText(prompt);
                yield* Effect.logInfo(logKeys.prompt.received, { blocks: prompt.map((block) => block.type), characters: text.length });
                if (entry.prompt !== undefined) {
                  yield* Effect.logWarning(logKeys.prompt.refused, { cause: "a prompt is running" });
                  return yield* Effect.fail(rpcError(-32000, `Session ${sessionId} already has an active prompt`));
                }
                const self = yield* Effect.fiber;
                entry.prompt = self;
                // A change held while a turn ran with no prompt of this connection's (one gone on with at load) is made before this one starts.
                yield* settled(entry);
                // A prompt of one block that is a command the host answers itself; any other is a turn.
                const command = prompt.length === 1 ? text.trim() : undefined;
                const run = (() => {
                  if (command === "/export") return exportOf(entry);
                  if (command === "/mcp" || command?.startsWith("/mcp ") === true) return mcpOf(entry, command.split(/\s+/).slice(1));
                  return turnOf(entry, text, prompt).pipe(
                    Effect.onInterrupt(() =>
                      Effect.flatMap(connection.open, (open) =>
                        open
                          ? Effect.logInfo(logKeys.prompt.interrupted, { by: "the client", turn: "cancelled" }).pipe(Effect.andThen(cancelTurn(entry, "$/cancel_request")))
                          : Effect.logInfo(logKeys.prompt.interrupted, { by: "the end of the connection", turn: "left running" }),
                      ),
                    ),
                  );
                })();
                return yield* run.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      entry.prompt = undefined;
                    }).pipe(Effect.andThen(settled(entry))),
                  ),
                );
              }),
              sessionId,
            ),

          "session/cancel": ({ sessionId }) =>
            traced(
              Effect.gen(function* () {
                const entry = HashMap.get(yield* Ref.get(entries), sessionId);
                if (Option.isNone(entry)) return yield* Effect.logWarning(logKeys.session.unknown, { sessionId, doing: "session/cancel" });
                yield* cancelTurn(entry.value, "session/cancel");
              }),
              sessionId,
            ),

          "session/close": ({ sessionId }) =>
            traced(
              Effect.gen(function* () {
                const entry = yield* entryOf(sessionId);
                yield* Ref.update(entries, (all) => HashMap.remove(all, sessionId));
                if (entry.state._tag === "Open") {
                  yield* cancelTurn(entry, "session/close");
                  if (entry.prompt !== undefined) yield* Fiber.await(entry.prompt);
                }
                // The entry's scope holds its MCP servers and its open session's scope: closing it ends them all.
                yield* Scope.close(entry.scope, Exit.void);
                yield* Effect.logInfo(logKeys.session.closed, { was: entry.state._tag === "Open" ? "open" : "a draft" });
                return {};
              }),
              sessionId,
            ),
        };
        return handlers;
      }),
  });
};
