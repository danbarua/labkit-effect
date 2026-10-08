/**
 * The ACP host: an agent of protocol v1 (`Agent.implement`) whose sessions run on the core. A
 * launcher runs `makeHost(options)` with `Agent.run` or `Agent.runStdio`.
 *
 * Per connection the host holds the sessions it made or started, each a draft or open
 * (`docs/agent-acp.md`):
 *
 * - `session/new` mints the id (ACP's `sessionId` and the core's `SessionId`), reads the session's
 *   configuration, opens its world (`world.ts`), starts its MCP servers, and makes a draft with the
 *   model to start with. Nothing is written. Its answer carries the config options; after the
 *   answer, `available_commands_update` offers `/export` and `/mcp`.
 * - `session/set_config_option` changes the draft. On an open session it goes through the
 *   configuration gate: made at once between turns, held until the turn ends otherwise. The answer
 *   is every option as the configuration will be, sent too as `config_option_update` once the feed
 *   has taken what the change recorded: a model changed between turns has its `usage_update` (the
 *   new window) sent before the options.
 * - `session/prompt` opens a draft (turn zero: the session's record, `host.json`, with its working
 *   folder and the first prompt's text as its title; its folder in the session directory; its
 *   services; `SessionOpened`; then `session_info_update` with the title) and runs the turn with
 *   `Session.prompt`. The session's feed (`feed.ts`) sends the turn's updates, `usage_update` among
 *   them, and asks permission. Once the feed has taken the turn's facts, the host answers with the
 *   turn's stop (`stopOf`), after a `notice` that explains a stop of `max_tokens` or `refusal`
 *   (`noticeOf`) to a client that advertised notices. `/export` and `/mcp` are answered without the
 *   model.
 * - `session/load` starts a stored session on this connection from its facts file, with the world
 *   opened for the `cwd` and the MCP servers asked. A turn that its facts left running is ended, not
 *   continued. Its facts are replayed through the projection (`replay`) before the answer, and the
 *   feed continues from the state they leave. `session/resume` does the same and replays nothing.
 *   After either answer: `available_commands_update`, `session_info_update` and, through the feed,
 *   `usage_update`.
 * - `session/list` lists the stored sessions that have the host's record (`session-record.ts`).
 * - `session/cancel` is `Session.cancel`, and so is a prompt request that the client cancels
 *   (`$/cancel_request`). A prompt interrupted by the end of the connection leaves its turn running
 *   in the facts, as the core allows: the host does not end it.
 * - `session/close` interrupts the turn under way and closes the session's scope.
 *
 * The end of the connection closes every session's scope.
 */

import { blobsFolderOf, type Brand, defaultBrand, envPrefixOf, folderOf } from "../agent-host/brand.ts";
import { type ConfigFlags, launchLayers } from "../agent-host/launch.ts";
import { writeEffectiveSettings } from "../agent-config/effective.ts";
import { type Configuration, type LayerSource, loadConfiguration } from "../agent-config/file.ts";
import { seamLayer, seamListsOf } from "../agent-config/seams.ts";
import { removeCredentials, processEnvironmentWith } from "../agent-process/environment.ts";
import { describe } from "../agent-mcp/server-machine.ts";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessSpawner } from "effect/process";
import { Clock, Context, type Duration, Effect, Exit, Fiber, FileSystem, HashMap, HashSet, Layer, Option, type Path, Ref, Schema, Scope, Semaphore, Stream } from "effect";
import * as Agent from "effective-acp/agent";
import { ErrorCode, type JsonRpcErrorObject } from "effective-acp/json-rpc";
import * as Protocol from "effective-acp/protocol";
import type { ContentBlock, McpServer, SessionConfigOption, SessionUpdate, StopReason } from "effective-acp/schema/v1";
import { SessionId as AcpSessionId } from "effective-acp/schema/v1";
import { type Asked, askable, keyVariables, ModelCatalog, targetOf } from "../agent-host/catalog.ts";
import { sessionFolderOf, storeFileOf } from "../agent-host/directory.ts";
import type { BlobRef } from "../agent-machine/blob.ts";
import { MediaType } from "../agent-machine/received.ts";
import { Blobs, BlobsInFolder, type BlobStore } from "../agent-session/blobs.ts";
import { chooseModel, defaultModel, type Draft, draftOf, opening, optionsOfDraft, withSettings, withDefaults } from "../agent-host/draft.ts";
import { markdownOf } from "../agent-host/export.ts";
import { KnownWithLocalServer, localServer, SettlingWithLocalServer } from "../agent-host/local-server.ts";
import { readRecord, RecordFailed, recordedSessions, recordFileOf, writeRecord } from "../agent-host/record.ts";
import { foldersOf, SessionServices } from "../agent-host/services.ts";
import { additionalDirectoriesOf } from "../agent-config/builtins.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { leftRunning } from "../agent-machine/left-running.ts";
import { InputText, SessionId, type TurnId } from "../agent-machine/names.ts";
import { changed } from "../agent-machine/settings.ts";
import type { Target, ToolRunner } from "../agent-session/contracts.ts";
import { SourcedToolRunner, ToolSources, toolsOf } from "../agent-session/tool-sources.ts";
import { FileBackedSessionStore } from "../agent-session/file-session-store.ts";
import { endTurnLeftRunning, openSession, type Services, type Session } from "../agent-session/loop.ts";
import type { SessionStore, SessionStoreFailed } from "../agent-session/session-store.ts";
import { harnessParts, reportedBy } from "../agent-session/origin.ts";
import { outcomeAsText } from "../agent-session/tool-output.ts";
import { Notices } from "../agent-context/assemble.ts";
import { mcpCommand as mcpSaid } from "../agent-mcp/command.ts";
import { type GivenServer, type McpServers, startMcpServers } from "../agent-mcp/servers.ts";
import { namespaceOf } from "../agent-mcp/source.ts";
import { modelOf } from "../agent-session/configuration/session-setup.ts";
import { optionsFor, type Options } from "../agent-session/configuration/options.ts";
import { type ConfigurationGate, makeConfigurationGate } from "../agent-session/configuration/gate.ts";
import { KnownModels, knownCapabilities, ModelOverrides, withOverrides } from "../agent-session/configuration/well-known-models.ts";
import { type Change, changeOf, configOptions, InvalidChange, permissionId, permissionModeOf, permissionOption } from "./config-options.ts";
import { PermissionMode } from "../agent-policy/permissions.ts";
import { acpUser, type Feed, startFeed } from "./feed.ts";
import { logKeys } from "./log-keys.ts";
import { presentFrom, type ProjectionState, project, start } from "./projection.ts";
import { acpHost, InvalidCursor, pageOf, readSessionRecord, recordFor } from "./session-record.ts";
import { noticeOf, stopOf } from "./stop-reason.ts";
import { editorWorld, type World, type WorldSession, workspaceWorld } from "./world.ts";

export interface HostOptions<R = never> {
  /** The session directory's root (`agent-host/directory.ts`). Each session that had a turn is a folder in it. */
  readonly directory: string;
  /**
   * Where the sessions' tools come from: `"editor"` (`editorWorld`, the default), `"local"`
   * (`workspaceWorld`, a stopgap that bypasses the editor; the launcher's `--local-tools`), or a
   * world of the host's own.
   */
  readonly world?: "editor" | "local" | World<R> | undefined;
  /** The model that sessions start with, as `provider/model` (the launcher's `--model`); the catalog's first model when left out. */
  readonly model?: string | undefined;
  /**
   * The launcher's options that make each session's configuration (`agent-host/launch.ts`):
   * `--permission-mode` (the mode sessions start in; the user can change it), `--max-turns`,
   * `--max-budget-usd`, `--settings`, `--setting-sources`, `--mcp-config` and `--strict-mcp-config`.
   */
  readonly configFlags?: ConfigFlags | undefined;
  /** The home whose `.config/<brand>` is the user's configuration folder; this process's when left out. */
  readonly home?: string | undefined;
  /**
   * How many times a turn whose response had thinking but no answer is asked again for it (the
   * launcher's `--retries`; 0 means never); 1 when left out. The host's defaults list
   * `retryIncomplete` with this number.
   */
  readonly retries?: number | undefined;
  /**
   * Whether a tool call whose input has properties its tool does not take is refused (the
   * launcher's `--strict-tool-input`). If not (the default), the call runs without them, and its
   * result names the properties that were ignored.
   */
  readonly strictToolInput?: boolean | undefined;
  /** Folders that count as inside every session's working folder (the launcher's `--add-dir`), before those a session's request names. */
  readonly additionalFolders?: ReadonlyArray<string> | undefined;
  /**
   * The maximum number of model requests in one turn, unless the configuration gives another
   * (`--max-turns`): the request beyond it is vetoed, and the prompt ends with the stop reason
   * `max_turn_requests` (`agent-policy/max-turn-requests.ts`); 1000 when left out. The host's
   * defaults list `maxTurnRequests` with this limit.
   */
  readonly maxTurnRequests?: number | undefined;
  /** How long an MCP server has to start and answer `initialize`; 30 seconds when left out. */
  readonly mcpConnectTimeout?: Duration.Input | undefined;
  /**
   * What a session runs with, given its world's tool runner, over the session's store, before its
   * configuration's seam lists; `SessionServices` when left out.
   */
  readonly services?: ((runner: Layer.Layer<ToolRunner>) => Layer.Layer<Services, never, SessionStore>) | undefined;
  /** The maximum number of sessions on one page of `session/list`; 50 when left out. */
  readonly pageSize?: number | undefined;
  /** The name the agent goes by (`agent-host/brand.ts`): it names the folder `/export` writes to, and is the name the host gives MCP servers. */
  readonly brand?: Brand | undefined;
}

/**
 * Returns the ACP host's defaults, the first of a session's configuration layers (`agent-host/launch.ts`):
 *
 * - `permissions` on tool calls;
 * - the limit on a turn's model requests (`maxTurnRequests`, 1000 when not given);
 * - `retryIncomplete` on the turn's end, asking a turn with thinking and no answer again `retries`
 *   times (1 when not given; with 0, no turn-end hook);
 * - `credentials` on the command environment: the model's commands receive the environment without
 *   its credentials.
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
 * Returns one of the client's MCP servers as a configuration layer writes it: a command run in the
 * session's working folder, or a URL. MCP over ACP (`type: acp`) is not offered (`mcpCapabilities`),
 * so it is written as it is, and the configuration refuses it.
 */
const writtenOf = (cwd: string, server: McpServer) => {
  const pairs = (each: ReadonlyArray<{ readonly name: string; readonly value: string }>) => Object.fromEntries(each.map(({ name, value }) => [name, value]));
  if ("command" in server) return { command: server.command, args: [...server.args], env: pairs(server.env), cwd };
  if (server.type === "http" || server.type === "sse") return { type: server.type, url: server.url, headers: pairs(server.headers) };
  return { type: server.type };
};

/**
 * Returns the client's MCP servers for a session in `cwd`, as the last two layers. The first layer
 * removes the configuration's servers of the same names, so each of the client's servers replaces
 * the configuration's whole.
 */
const clientLayers = (cwd: string, servers: ReadonlyArray<McpServer>): ReadonlyArray<LayerSource> => {
  if (servers.length === 0) return [];
  const name = "the client's MCP servers";
  return [
    { name, trusted: true, value: { mcpServers: Object.fromEntries(servers.map((server) => [server.name, null])) } },
    { name, trusted: true, value: { mcpServers: Object.fromEntries(servers.map((server) => [server.name, writtenOf(cwd, server)])) } },
  ];
};

/** Returns the mode a session starts in: the `mode` of the `permissions` entry its tool calls list; `default` when none. */
const startingModeOf = (configuration: Configuration): PermissionMode => {
  const mode = (configuration.lists.toolCalls?.find((entry) => entry.plugin.use === "permissions")?.settings as { readonly mode?: unknown } | undefined)?.mode;
  return Schema.is(PermissionMode)(mode) ? mode : "default";
};

/** A session's configuration, and the layers it was made from. */
type Configured = Configuration & { readonly layers: ReadonlyArray<LayerSource> };

/** The `/export` command, which the host answers without the model. */
const exportCommandOf = (brand: Brand) => ({ name: "export", description: `Write this session's transcript as Markdown to ${folderOf(brand)}/exports/<session>.md in the working folder.` });

/** The `/mcp` command, which reports the state of each of the session's MCP servers and can start one again. */
const mcpCommand = { name: "mcp", description: "Say how this session's MCP servers are; `reconnect <server>` starts one again.", input: { hint: "reconnect <server>" } };

const rpcError = (code: number, message: string, data?: unknown): JsonRpcErrorObject => ({ code, message, ...(data === undefined ? {} : { data }) });

/** An open session: the core's session, the services its operations run with, its scope and its feed. */
interface Opened {
  readonly session: Session;
  readonly context: Context.Context<Services>;
  readonly scope: Scope.Closeable;
  readonly feed: Feed;
  /** When the user's changes are made: at once between turns, else held until the turn ends (the configuration gate, `agent-session/configuration/gate.ts`). */
  readonly gate: ConfigurationGate<HeldChange, SessionStoreFailed>;
}

/** What a user changes of an open session: its model and settings, and its permission mode. */
interface HeldChange {
  readonly model?: Change | undefined;
  readonly permissionMode?: PermissionMode | undefined;
}

/** Merges two held changes: the later model and permission mode, and the settings of both, the later's settings winning. */
const mergeHeld = (held: HeldChange, next: HeldChange): HeldChange => ({
  model: mergedModel(held.model, next.model),
  permissionMode: next.permissionMode ?? held.permissionMode,
});

/** Merges two model changes: the later model, and the settings of both, the later's settings winning. */
const mergedModel = (held: Change | undefined, next: Change | undefined): Change | undefined => {
  if (next === undefined) return held;
  if (held === undefined) return next;
  return { ...next, ...(held.settings === undefined && next.settings === undefined ? {} : { settings: { ...held.settings, ...next.settings } }) };
};

/** Returns the model that the next turn will ask, with the held change applied, if there is one. */
const withHeld = (configured: Target, held: HeldChange | undefined): Target => {
  const change = held?.model;
  if (change === undefined) return configured;
  const settings = changed(configured.settings ?? {}, change.settings ?? {});
  return { provider: change.provider, model: change.model, ...(Object.keys(settings).length === 0 ? {} : { settings }) };
};

/** The state of a session this connection holds: a draft until its first prompt, then open. */
type EntryState = { readonly _tag: "Draft"; readonly draft: Draft } | { readonly _tag: "Open"; readonly opened: Opened };

/** A session this connection holds: one it made (a draft until its first prompt, then open), or one it started from its facts (open). */
interface Entry {
  readonly id: AcpSessionId;
  readonly cwd: string;
  /** The folders the client named with the working folder (`additionalDirectories`), absolute. */
  readonly additional: ReadonlyArray<string>;
  /** Its world, with the MCP servers' tools after the world's own. */
  readonly world: WorldSession;
  /** The entry's scope, from `session/new` (or load, or resume) to `session/close`: its MCP servers, and its open session's scope, are in it. */
  readonly scope: Scope.Closeable;
  readonly mcp: McpServers;
  /** Held while the draft opens and while a configuration change is applied, so that neither change is lost. */
  readonly lock: Semaphore.Semaphore;
  readonly state: Ref.Ref<EntryState>;
  /** The prompt running, if one is. */
  readonly prompt: Ref.Ref<Fiber.Fiber<unknown, unknown> | undefined>;
  /** The permission mode. The host keeps it; the policy reads it at each call; the user changes it. It starts as the configuration says. */
  readonly permissionMode: Ref.Ref<PermissionMode>;
  /** The session's configuration: its seam lists, and its MCP servers. */
  readonly configuration: Configured;
}

/**
 * Returns the model that the next turn will ask: the one `modelOf` returns, with each change that
 * arrived and is not yet taken (a change that arrives during a turn waits for a step or the turn's
 * end).
 */
const configuredOf = (facts: ReadonlyArray<Fact>): Effect.Effect<Target> =>
  Effect.map(modelOf(facts), (now) => {
    const taken = new Set(facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "ModelChangeTaken" ? [fact.decision.change] : [])));
    return facts.reduce<Target>((target, fact) => {
      if (fact._tag !== "Observed" || fact.observation._tag !== "ModelChangeArrived" || taken.has(fact.seq)) return target;
      const change = fact.observation;
      const settings = changed(target.settings ?? {}, change.settings ?? {});
      return { provider: change.provider, model: change.model, ...(Object.keys(settings).length === 0 ? {} : { settings }) };
    }, now);
  });

/** Returns the text of a prompt: its text blocks, and each resource link as a line. */
const promptText = (prompt: ReadonlyArray<ContentBlock>): string => prompt.flatMap(linesOf).join("\n");

/** Returns the lines a block adds to the prompt's text: a text block's text, a resource link as a Markdown link; nothing for a file. */
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

/** Returns the last part of `uri`'s path, as a file's name. */
const nameIn = (uri: string | null | undefined): string | undefined => {
  const last = uri?.split(/[/\\]/).filter((part) => part !== "").at(-1);
  return last === undefined || last === "" ? undefined : decodeURIComponent(last);
};

/** Stores what a block attaches to the input (an image, or an embedded resource) in the blob store, and returns its references. */
const attachmentsOf = (blobs: BlobStore, block: ContentBlock): Effect.Effect<ReadonlyArray<BlobRef>> => {
  if (block.type === "image") return Effect.map(blobs.store(Buffer.from(block.data, "base64"), MediaType.make(block.mimeType), nameIn(block.uri)), (stored): ReadonlyArray<BlobRef> => [stored]);
  if (block.type !== "resource") return Effect.succeed([]);
  const resource = block.resource;
  const bytes = "text" in resource ? new TextEncoder().encode(resource.text) : Buffer.from(resource.blob, "base64");
  const mediaType = resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream");
  return Effect.map(blobs.store(bytes, MediaType.make(mediaType), nameIn(resource.uri)), (stored): ReadonlyArray<BlobRef> => [stored]);
};

/**
 * Returns the input that a prompt's blocks make: its text (`promptText`), and each image and
 * embedded resource (an editor's file, as text or bytes) stored in the session's blob store and
 * attached by reference.
 */
const promptInput = (prompt: ReadonlyArray<ContentBlock>) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs;
    const attachments = (yield* Effect.forEach(prompt, (block) => attachmentsOf(blobs, block))).flat();
    return { text: InputText.make(promptText(prompt)), ...(attachments.length === 0 ? {} : { attachments }) };
  });

/** Returns the variable that names the model sessions start with, as `brand`'s launcher reads it. */
const modelVariableOf = (brand: Brand): string => `${envPrefixOf(brand)}ACP_MODEL`;

/** Returns the error message of `session/new` when no model can be asked. */
const noModelOf = (brand: Brand) =>
  `No model to ask: set ${Object.values(keyVariables).join(", ")} for a provider's models, or start the local server at ${localServer}, or name one with ${modelVariableOf(brand)} as provider/model.`;

/** Returns when a change of the model or its settings applies, in the log's words. */
const whenApplied = (when: "draft" | "made" | "held"): string => {
  switch (when) {
    case "draft":
      return "to the draft";
    case "made":
      return "now: no turn runs";
    case "held":
      return "when the turn ends";
    default:
      return when satisfies never;
  }
};

/** Returns the world that a host's sessions open: the editor's, unless the options name the local disk's or give a world of their own. */
const worldOf = <R>(world: HostOptions<R>["world"]): World<R> | World<FileSystem.FileSystem> => {
  if (world === undefined || world === "editor") return editorWorld;
  return world === "local" ? workspaceWorld : world;
};

/** Returns the world's name as `effective-settings.json` records it. */
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
      sessionCapabilities: { close: {}, list: {}, resume: {}, additionalDirectories: {} },
      mcpCapabilities: { http: true, sse: true },
    },
    handlers: (connection) =>
      Effect.gen(function* () {
        const connectionScope = yield* Scope.Scope;
        const connectionId = crypto.randomUUID().slice(0, 8);
        // What is known of each model, and how its settings apply: the local server is asked once per connection.
        const modelKnowledge = yield* Layer.buildWithScope(Layer.mergeAll(KnownWithLocalServer, SettlingWithLocalServer), connectionScope);
        const entries = yield* Ref.make(HashMap.empty<string, Entry>());
        /** The sessions that `session/load` or `session/resume` is starting: not yet among `entries`, and not to be started twice. */
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

        /**
         * Whether the client advertised notices (`clientCapabilities.session.notices`; omitted or
         * null: not). ACP lets an agent send a `notice` only to a client that did, and
         * `effective-acp` refuses one to a client that did not.
         */
        const noticesAdvertised = connection.profile.client.capabilities.session?.notices != null;

        /**
         * Sends the notice that explains the stop of `turn`'s prompt (`noticeOf`), after every other
         * update of the turn and before the prompt's answer. A notice is a live event, not history:
         * `session/load` replays none. A client that did not advertise notices is sent none.
         */
        const stopNotice = (sessionId: AcpSessionId, facts: ReadonlyArray<Fact>, turn: TurnId, stopReason: StopReason) =>
          Effect.gen(function* () {
            const notice = yield* noticeOf(facts, turn, stopReason);
            if (notice === undefined) return;
            if (!noticesAdvertised) return yield* Effect.logDebug(logKeys.notice.notAdvertised, { stopReason });
            yield* send(sessionId, notice);
            yield* Effect.logInfo(logKeys.notice.sent, { stopReason, title: notice.title });
          }).pipe(Effect.annotateLogs({ turn }));

        /** What is known of models for a session configured as `configuration`: the connection's knowledge, with the configuration's overrides (`models:`) over it. */
        const knowledgeOf = (configuration: Configured) =>
          Context.add(modelKnowledge, KnownModels, withOverrides(configuration.models, Context.get(modelKnowledge, KnownModels)));

        const capabilitiesOf = (target: { readonly provider: Asked["provider"]; readonly model: Asked["model"] }, configuration: Configured) =>
          knownCapabilities(target.provider, target.model).pipe(Effect.provideContext(knowledgeOf(configuration)));

        /**
         * Returns the configuration of a session in `cwd` whose client names `servers`: the host's defaults, the
         * launcher's layers with `cwd` as the project, then the client's servers. A configuration that cannot be used
         * refuses the request (-32603).
         *
         * `cwd` counts as a trusted folder (`agent-host/trust.ts`): the editor opened the session in a workspace that
         * it trusts, and that trust is the boundary. So the project's files that `--setting-sources` names are read as
         * the user's own.
         */
        const configurationFor = (cwd: string, servers: ReadonlyArray<McpServer>, doing: string): Effect.Effect<Configured, JsonRpcErrorObject, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            const flags = options.configFlags ?? { mcpConfig: [], strictMcpConfig: false };
            const layers = [
              ...(yield* launchLayers(cwd, defaults, flags, { name: brand.name, projectTrusted: true, ...(options.home === undefined ? {} : { home: options.home }) })),
              ...clientLayers(cwd, servers),
            ];
            return { ...(yield* loadConfiguration(layers)), layers };
          }).pipe(
            // ConfigInvalid; FolderNotTrusted does not arise, since a session's folder is trusted, and would be refused alike.
            Effect.catch((error) =>
              Effect.logWarning(logKeys.session.refused, { doing, cwd, cause: "the configuration cannot be used", problem: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The configuration cannot be used: ${error.message}`))),
              ),
            ),
          );

        /** Returns the environment that a command the model runs on the local disk receives, as the configuration composes it. */
        const environmentFor = (configuration: Configured) => processEnvironmentWith(seamListsOf(configuration, { canAsk: true }).commandEnvironment ?? [removeCredentials()]);

        /** Writes what a session's configuration resolved to, with what the host says beside it, to the session's folder. */
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
         * Starts the MCP servers of a session in `cwd` at once, in a scope of the entry's own (`startMcpServers`), and returns
         * the world with their tools after its own. The servers are the configuration's, the client's among them.
         *
         * - Two servers whose tools would be offered under one name are refused (-32602) before anything is started.
         * - A server that the configuration says is required and that is not running once the servers have settled refuses
         *   the request (-32603), and the servers are stopped.
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
              // A call is shown with an MCP server's result as text, whether or not the server is still running, and with its details.
              present: (call, outcome, mode) => {
                const sent = outcome === undefined ? undefined : outcomeAsText(outcome);
                return catalog.some((tool) => tool.name === call.tool) ? mcpPresent(call, sent, mode) : opened.present(call, sent, mode);
              },
            };
            return { world, scope, mcp };
            }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
          });

        /** Answers `/mcp` with each MCP server and its state, and `/mcp reconnect <server>` by starting it again and reporting how it went, in a message. */
        const mcpOf = (entry: Entry, words: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const say = (text: string) => send(entry.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
            const offered = (yield* toolsOf(entry.world.sources)).catalog.map((tool) => tool.name as string);
            yield* say(yield* mcpSaid(entry.mcp, words, offered));
            return { stopReason: "end_turn" as const };
          });

        /** Submits a user's change to the open session's gate; a change that could not be recorded is -32603. */
        const submitted = (opened: Opened, change: HeldChange, configId: string) =>
          opened.gate.submit(change).pipe(
            Effect.catchTag("SessionStoreFailed", (error) =>
              Effect.logError(logKeys.config.refused, { configId, doing: "recording the change", cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The change could not be recorded: ${error.message}`))),
              ),
            ),
          );

        /** Makes the change that the open session's gate holds, if no turn runs; a change that could not be recorded is logged as an error. */
        const settled = (entry: Entry) =>
          Effect.flatMap(Ref.get(entry.state), (state) =>
            state._tag === "Open"
              ? state.opened.gate.settle.pipe(
                  Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.config.refused, { doing: "recording a change held until the turn ended", cause: error.message })),
                )
              : Effect.void,
          );

        /** Returns the session's configuration as it will be from the next turn, held changes included, and its config options. */
        const configurationOf = (entry: Entry) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(entry.state);
            const held = state._tag === "Open" ? yield* state.opened.gate.held : undefined;
            const configured: Options =
              state._tag === "Draft"
                ? yield* optionsOfDraft(state.draft)
                : yield* optionsFor(withHeld(yield* Effect.flatMap(state.opened.session.facts, configuredOf), held));
            const models = yield* askable;
            const limit = (yield* capabilitiesOf(configured, entry.configuration))?.output;
            return {
              configured,
              models,
              limit,
              options: [...configOptions(configured, models, limit), permissionOption(held?.permissionMode ?? (yield* Ref.get(entry.permissionMode)))] as ReadonlyArray<SessionConfigOption>,
            };
          }).pipe(Effect.provideContext(knowledgeOf(entry.configuration)));

        /**
         * The model that `session/new` starts with: the one the launcher names (`--model`), else the one the session's
         * configuration names (`model:`), else the catalog's first; or the error saying why there is none.
         */
        const startingModelOf = (configuration: Configured): Effect.Effect<Asked, JsonRpcErrorObject, ModelCatalog> => {
          const named = options.model ?? configuration.model;
          if (named === undefined) return Effect.filterOrFail(defaultModel, (model): model is Asked => model !== undefined, () => rpcError(ErrorCode.InternalError, noModelOf(brand)));
          const namer = options.model === undefined ? "The configuration's model" : modelVariableOf(brand);
          return targetOf(named).pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "ModelNotFound":
                  return rpcError(ErrorCode.InternalError, `${namer} names ${error.name}, which no source has${error.close.length === 0 ? "" : `; close: ${error.close.join(", ")}`}.`);
                case "KeyNotSet":
                  return rpcError(ErrorCode.InternalError, `${namer} names a model of ${error.provider}: set ${error.variable}.`);
                case "SourceNotAnswering":
                  return rpcError(ErrorCode.InternalError, `${namer} names a model of ${error.provider}, whose server at ${error.at ?? "?"} does not answer.`);
              }
            }),
          );
        };

        /**
         * Starts the session `id` over its facts file, in a scope of its own forked from the entry's: its services, the core's
         * session, then `go`. `go` starts the session's feed (`follow`, from the projection state it passes) at the point from
         * which the feed is to send what is recorded. Any failure closes the scope, so nothing is left open.
         */
        const startSession = <A extends { readonly feed: Feed }, E, X>(
          id: AcpSessionId,
          world: WorldSession,
          permissionMode: Ref.Ref<PermissionMode>,
          parent: { readonly scope: Scope.Scope; readonly mcp: McpServers; readonly configuration: Configured; readonly cwd: string; readonly additional: ReadonlyArray<string> },
          go: (session: Session, context: Context.Context<Services>, follow: (initial: ProjectionState) => Effect.Effect<Feed>) => Effect.Effect<A, E, X>,
        ) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(parent.scope);
            return yield* Effect.gen(function* () {
              const file = storeFileOf(options.directory, id);
              // The blobs (inputs' images and files, stored outputs) are kept in the brand's blobs folder, which every session and host
              // shares, so a session continued from its facts has them; a session made before then also reads those in its own folder.
              const blobs = BlobsInFolder(blobsFolderOf(brand, options.home), [join(sessionFolderOf(options.directory, id), "blobs")]);
              // The configuration's seam lists, with permission following the session's mode (`FromHost.permissionMode`). Its tool
              // sources are not used: the session's tools are the world's and its MCP servers'.
              const additionalFolders = [...(options.additionalFolders ?? []), ...parent.additional];
              // The path inputs of the tools the session runs with now, which a session recorded before they were named lacks.
              const { catalog: live } = yield* toolsOf(world.sources);
              const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(parent.configuration, {
                canAsk: true,
                permissionMode: Ref.get(permissionMode),
                workingFolder: parent.cwd,
                additionalFolders,
                toolPaths: (name) => live.find((tool) => tool.name === name)?.paths,
              });
              const runner = SourcedToolRunner.pipe(Layer.provide(Layer.succeed(ToolSources, world.sources)));
              // The model is told of the session's MCP servers that are not running (`McpServers.notices`).
              const notices = Layer.mergeAll(
                Layer.succeed(Notices, [parent.mcp.notices]),
                // What is known of models is the catalog's, with the configuration's overrides (`models:`) over it.
                Layer.succeed(ModelOverrides, parent.configuration.models),
              );
              const layer = Layer.mergeAll(services(runner).pipe(Layer.provide(notices)), seamLayer(lists), blobs).pipe(Layer.provideMerge(FileBackedSessionStore(file)));
              const context = yield* Layer.buildWithScope(layer, scope);
              // Every span of the session carries its working folder and this host, as its record holds them.
              const session = yield* openSession.pipe(Effect.provideContext(context), Effect.annotateSpans({ host: acpHost, cwd: parent.cwd }), Scope.provide(scope));

              const follow = (initial: ProjectionState) =>
                startFeed({
                  sessionId: id,
                  session,
                  context,
                  present: world.present,
                  folders: foldersOf(parent.cwd, [...additionalFolders, ...additionalDirectoriesOf(parent.configuration)]),
                  connection,
                  annotations: { connection: connectionId, session: id },
                  initial,
                }).pipe(
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
              // Once the session's facts have their opening, its MCP servers' states, and each change of them, are recorded (`McpServers.changes`).
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
         * Opens the entry's draft at its first prompt (turn zero): writes its record (`host.json`: the working folder, and the
         * title from `text`) and `effective-settings.json`, starts its services in a scope of its own and its feed, records
         * `SessionOpened`, then sends `session_info_update`.
         */
        const open = (entry: Entry, draft: Draft, text: string) =>
          Effect.gen(function* () {
            const failed = (doing: string) => (error: { readonly message: string }) =>
              Effect.logError(logKeys.session.notOpened, { doing, cause: error.message }).pipe(
                Effect.andThen(Effect.fail(rpcError(ErrorCode.InternalError, `The session could not be opened: ${error.message}`))),
              );

            const record = recordFor(entry.cwd, text, entry.additional);
            yield* writeRecord(options.directory, entry.id, record).pipe(Effect.catch(failed("writing the session's record at its first prompt")));
            yield* Effect.logInfo(logKeys.record.written, { file: recordFileOf(options.directory, entry.id), cwd: record.cwd, titled: record.title !== undefined });
            yield* settingsWritten(entry.id, entry.configuration, yield* Ref.get(entry.permissionMode), `${draft.model.provider}/${draft.model.model}`);
            const opened = yield* startSession(entry.id, entry.world, entry.permissionMode, { scope: entry.scope, mcp: entry.mcp, configuration: entry.configuration, cwd: entry.cwd, additional: entry.additional }, (session, context, follow) =>
              Effect.gen(function* () {
                // The feed starts first: the session has no facts yet, so the feed sends everything from the opening on, live.
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

        /** Answers `/export`: writes the transcript to `<cwd>/.<brand>/exports/<id>.md`, and says where in a message. */
        const exportOf = (entry: Entry) =>
          Effect.gen(function* () {
            const say = (text: string) => send(entry.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
            const state = yield* Ref.get(entry.state);
            if (state._tag === "Draft") {
              yield* say("Nothing to export: this session has had no turn yet.");
              return { stopReason: "end_turn" as const };
            }
            const path = join(entry.cwd, folderOf(brand), "exports", `${entry.id}.md`);
            const markdown = markdownOf(yield* state.opened.session.facts);
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

        /** Records the interruption of the turn under way, and logs it, as a client's `session/cancel` does. */
        const cancelTurn = (entry: Entry, by: string) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(entry.state);
            if (state._tag === "Draft") return;
            const { session, context } = state.opened;
            const turn = yield* session.turn;
            yield* Effect.logInfo(logKeys.cancel.requested, { by, ...(turn === undefined ? { underWay: false } : { turn }) });
            yield* session.cancel.pipe(Effect.provideContext(context), reportedBy(acpUser));
          }).pipe(
            Effect.catchTag("SessionStoreFailed", (error) =>
              Effect.logError(logKeys.prompt.failed, { doing: "recording the turn's interruption", cause: error.message }),
            ),
          );

        /** Opens the draft if it is one, runs the turn, waits for the feed to take the turn's facts (its usage among their updates), and returns the stop. */
        const turnOf = (entry: Entry, text: string, blocks: ReadonlyArray<ContentBlock>) =>
          Effect.gen(function* () {
            const began = yield* Clock.currentTimeMillis;
            const opened = yield* entry.lock.withPermit(
              Effect.gen(function* () {
                const state = yield* Ref.get(entry.state);
                if (state._tag === "Open") return state.opened;
                const made = yield* open(entry, state.draft, text);
                yield* Ref.set(entry.state, { _tag: "Open", opened: made });
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
            // Every update of the turn, its usage included, is sent before the answer.
            yield* feed.caughtUp;
            const stop = stopOf(facts, turn);
            const took = (yield* Clock.currentTimeMillis) - began;
            if (stop === undefined) return yield* Effect.die(new Error(`Turn ${turn} has no stop though it ended`));
            if ("error" in stop) {
              yield* Effect.logWarning(logKeys.prompt.settled, { error: stop.error.message, code: stop.error.code, ms: took }).pipe(Effect.annotateLogs({ turn }));
              return yield* Effect.fail(stop.error);
            }
            yield* stopNotice(entry.id, facts, turn, stop.stopReason);
            yield* Effect.logInfo(logKeys.prompt.settled, { stopReason: stop.stopReason, ms: took }).pipe(Effect.annotateLogs({ turn }));
            return { stopReason: stop.stopReason };
          });

        /** Returns the title in the session's record; undefined when it has no record (the CLI made it), or a record that does not read, which is logged. */
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

        /** Sends what the host sends of a session started from its facts, once the client knows it: the commands, its title and last write, and, through the feed, its usage. */
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
            yield* opened.feed.usage;
          });

        /**
         * Handles `session/load` or `session/resume`: starts the stored session on this connection, with the world opened for `cwd` and
         * `mcpServers`.
         *
         * 1. A turn that its facts left running is ended, with nothing run again.
         * 2. On load, the facts as they are then are sent as the projection replays them, before the answer.
         * 3. The feed continues from the state they leave, so nothing is sent twice.
         * 4. Only then does the session go on (`goOn`): input left waiting starts its turn, which the feed sends.
         * 5. The connection holds the entry once it has started. After the answer, the host sends `announce`.
         */
        const reopen = (
          method: "session/load" | "session/resume",
          params: { readonly sessionId: AcpSessionId; readonly cwd: string; readonly additionalDirectories: ReadonlyArray<string>; readonly mcpServers: ReadonlyArray<McpServer> },
        ) =>
          Effect.gen(function* () {
            const { sessionId, cwd, mcpServers } = params;
            const additional = params.additionalDirectories;
            if (!isAbsolute(cwd)) {
              yield* Effect.logWarning(logKeys.session.refused, { doing: method, cwd, cause: "the working folder is not an absolute path" });
              return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `cwd must be an absolute path: ${cwd}`));
            }
            const notAbsolute = additional.find((folder) => !isAbsolute(folder));
            if (notAbsolute !== undefined) {
              yield* Effect.logWarning(logKeys.session.refused, { doing: method, cwd, additionalDirectories: additional, cause: "an additional directory is not an absolute path" });
              return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `additionalDirectories must be absolute paths: ${notAbsolute}`));
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
              const worldAlone = yield* (world as World<R | FileSystem.FileSystem>).open({
                sessionId,
                cwd,
                additionalFolders: sessionFolders(cwd, additional, configuration),
                mcpServers,
                connection,
                strictInput: options.strictToolInput ?? false,
                environment: environmentFor(configuration),
              });
              const { world: sessionWorld, scope, mcp } = yield* withServers(cwd, worldAlone, configuration, method);
              return yield* Effect.gen(function* () {
              // The policy reads the session's mode at each call; the mode starts as the configuration says.
              const initialMode = startingModeOf(configuration);
              const mode = yield* Ref.make(initialMode);
              const opened = yield* startSession(sessionId, sessionWorld, mode, { scope, mcp, configuration, cwd, additional }, (session, context, follow) =>
                Effect.gen(function* () {
                  const left = leftRunning(yield* session.facts);
                  if (left !== undefined) {
                    yield* endTurnLeftRunning(session).pipe(Effect.provideContext(context));
                    yield* Effect.logInfo(logKeys.session.turnLeftRunningEnded, { stopping: left.stopping, requests: left.requests.length }).pipe(
                      Effect.annotateLogs({ turn: left.turn }),
                    );
                  }
                  const replayed = yield* project(yield* session.facts, { mode: "replay", present: sessionWorld.present });
                  if (method === "session/load") yield* Effect.forEach(replayed.updates, (update) => send(sessionId, update), { discard: true });
                  const feed = yield* follow(replayed.state);
                  if (left === undefined) yield* session.goOn.pipe(Effect.provideContext(context));
                  return { feed, replayed: method === "session/load" ? replayed.updates.length : 0, left: left?.turn };
                }),
              ).pipe(Effect.catch(notStarted("starting the stored session")));
              const entry: Entry = {
                id: sessionId,
                cwd,
                additional,
                world: sessionWorld,
                scope,
                mcp,
                lock: yield* Semaphore.make(1),
                state: yield* Ref.make<EntryState>({ _tag: "Open", opened }),
                prompt: yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined),
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
                tools: (yield* toolsOf(sessionWorld.sources)).catalog.map((tool) => tool.name),
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

        // The folders a session counts as inside its working folder, absolute: the launcher's, the session's, then the settings'.
        const sessionFolders = (cwd: string, additional: ReadonlyArray<string>, configuration: Configured): ReadonlyArray<string> =>
          foldersOf(cwd, [...(options.additionalFolders ?? []), ...additional, ...additionalDirectoriesOf(configuration)]).additional ?? [];

        const handlers: Agent.AgentHandlers<Protocol.V1Version, ModelCatalog | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | R> = {
          "session/new": ({ cwd, mcpServers, additionalDirectories }) =>
            traced(
              Effect.gen(function* () {
                if (!isAbsolute(cwd)) {
                  yield* Effect.logWarning(logKeys.session.refused, { cwd, cause: "the working folder is not an absolute path" });
                  return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `cwd must be an absolute path: ${cwd}`));
                }
                const additional = additionalDirectories ?? [];
                const notAbsolute = additional.find((folder) => !isAbsolute(folder));
                if (notAbsolute !== undefined) {
                  yield* Effect.logWarning(logKeys.session.refused, { cwd, additionalDirectories: additional, cause: "an additional directory is not an absolute path" });
                  return yield* Effect.fail(rpcError(ErrorCode.InvalidParams, `additionalDirectories must be absolute paths: ${notAbsolute}`));
                }
                const configuration = yield* configurationFor(cwd, mcpServers, "session/new");
                const model = yield* startingModelOf(configuration).pipe(
                  Effect.tapError((error) => Effect.logWarning(logKeys.session.refused, { cwd, cause: error.message })),
                );
                const id = AcpSessionId.make(crypto.randomUUID());
                const worldAlone = yield* (world as World<R | FileSystem.FileSystem>).open({
                  sessionId: id,
                  cwd,
                  additionalFolders: sessionFolders(cwd, additional, configuration),
                  mcpServers,
                  connection,
                  strictInput: options.strictToolInput ?? false,
                  environment: environmentFor(configuration),
                });
                const { world: sessionWorld, scope, mcp } = yield* withServers(cwd, worldAlone, configuration, "session/new");
                return yield* Effect.gen(function* () {
                const capabilities = yield* capabilitiesOf(model, configuration);
                const { catalog } = yield* toolsOf(sessionWorld.sources);
                const draft = withDefaults(
                  draftOf({ model, tools: catalog, ...(sessionWorld.system === undefined ? {} : { system: sessionWorld.system }) }),
                  capabilities,
                );
                const entry: Entry = {
                  id,
                  cwd,
                  additional,
                  world: sessionWorld,
                  scope,
                  mcp,
                  lock: yield* Semaphore.make(1),
                  state: yield* Ref.make<EntryState>({ _tag: "Draft", draft }),
                  prompt: yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined),
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

          "session/load": ({ sessionId, cwd, mcpServers, additionalDirectories }) =>
            traced(reopen("session/load", { sessionId, cwd, mcpServers, additionalDirectories: additionalDirectories ?? [] }), sessionId),

          "session/resume": ({ sessionId, cwd, mcpServers, additionalDirectories }) =>
            traced(reopen("session/resume", { sessionId, cwd, mcpServers: mcpServers ?? [], additionalDirectories: additionalDirectories ?? [] }), sessionId),

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
                      // The entry's lock is held: its state does not change meanwhile.
                      const state = yield* Ref.get(entry.state);
                      const applies = state._tag === "Draft" ? "made" : yield* submitted(state.opened, { permissionMode: mode }, configId);
                      if (state._tag === "Draft") yield* Ref.set(entry.permissionMode, mode);
                      yield* Effect.logInfo(logKeys.config.changed, { configId, value: mode, applies: applies === "made" ? "now: no turn runs" : "when the turn ends" });
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
                    const before = yield* Ref.get(entry.state);
                    if (before._tag === "Draft") {
                      const draft = before.draft;
                      const moved =
                        change.provider === draft.model.provider && change.model === draft.model.model
                          ? draft
                          : chooseModel(draft, { provider: change.provider, model: change.model });
                      yield* Ref.set(entry.state, { _tag: "Draft", draft: change.settings === undefined ? moved : withSettings(moved, change.settings) });
                    }
                    const state = yield* Ref.get(entry.state);
                    const applies = state._tag === "Draft" ? "draft" : yield* submitted(state.opened, { model: change }, configId);
                    yield* Effect.logInfo(logKeys.config.changed, {
                      configId,
                      value: params.value,
                      applies: whenApplied(applies),
                    });
                    return { configOptions: (yield* configurationOf(entry)).options };
                  }),
                ).pipe(
                  // The options are sent as an update too: a client may draw its controls from updates alone (labkit's does). Once the
                  // feed has taken what the change recorded, so a model changed between turns has its usage (its window) sent first.
                  Effect.tap(({ configOptions }) =>
                    Effect.gen(function* () {
                      const state = yield* Ref.get(entry.state);
                      if (state._tag === "Open") yield* state.opened.feed.caughtUp;
                      yield* send(entry.id, { sessionUpdate: "config_option_update", configOptions });
                    }),
                  ),
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
                const self = yield* Effect.fiber;
                // Taken only when no prompt runs: the check and the taking are one change.
                const running = yield* Ref.modify(entry.prompt, (now) => (now === undefined ? [false, self] : [true, now]));
                if (running) {
                  yield* Effect.logWarning(logKeys.prompt.refused, { cause: "a prompt is running" });
                  return yield* Effect.fail(rpcError(-32000, `Session ${sessionId} already has an active prompt`));
                }
                // A change held while a turn ran without a prompt of this connection's (a turn continued at load) is made before this prompt's turn starts.
                yield* settled(entry);
                // A prompt of one block that is a command is answered by the host itself; any other prompt is a turn.
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
                  Effect.ensuring(Ref.set(entry.prompt, undefined).pipe(Effect.andThen(settled(entry)))),
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
                if ((yield* Ref.get(entry.state))._tag === "Open") {
                  yield* cancelTurn(entry, "session/close");
                  const running = yield* Ref.get(entry.prompt);
                  if (running !== undefined) yield* Fiber.await(running);
                }
                // The entry's scope holds its MCP servers and its open session's scope: closing it ends them all.
                yield* Scope.close(entry.scope, Exit.void);
                yield* Effect.logInfo(logKeys.session.closed, { was: (yield* Ref.get(entry.state))._tag === "Open" ? "open" : "a draft" });
                return {};
              }),
              sessionId,
            ),
        };
        return handlers;
      }),
  });
};
