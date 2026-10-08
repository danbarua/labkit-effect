/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say about a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
 * The session's machinery (its store, record, opening and continuing) is `withSession`
 * (`agent-host/with-session.ts`); what this module adds are the CLI's bolt-ons.
 *
 * The tools work in the folder the CLI runs in (`agent-tools/workspace.ts`): `read_file` and
 * `list_dir` read it, `write_file` and `edit_file` change it, and `run_command` runs a shell command
 * in it. When the folder is the root of a git repository, the git tools (`agent-tools/git.ts`) come
 * next, bound to it. Then come the tools of the MCP servers the configuration names
 * (`configuration.ts`). The system prompt starts with the line that names that folder as the working
 * folder, which the tool descriptions refer to, and the line that says it is a repository's root
 * when it is one; the `--system-prompt` and `--append-system-prompt` text follows. The
 * policies and turn-end hooks come from the configuration (`agent-config`); by default, permission
 * follows `--permission-mode`.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Array as Arr, Effect, type FileSystem, Layer, Order, Predicate, Stream } from "effect";
import { ModelOverrides } from "../../agent-session/configuration/well-known-models.ts";
import { writeEffectiveSettings } from "../../agent-config/effective.ts";
import type { Configuration, LayerSource } from "../../agent-config/file.ts";
import { seamLayer, seamListsOf } from "../../agent-config/seams.ts";
import { describe } from "../../agent-mcp/server-machine.ts";
import { removeCredentials, processEnvironmentWith } from "../../agent-process/environment.ts";
import { type GivenServer, type McpServers, startMcpServers } from "../../agent-mcp/servers.ts";
import type { Asked } from "../../agent-host/catalog.ts";
import { blobsFolderOf, Brand, logsFolderOf, sessionsFolderOf } from "../../agent-host/brand.ts";
import { BlobsInFolder, BlobsInMemory } from "../../agent-session/blobs.ts";
import { sessionFolderOf } from "../../agent-host/directory.ts";
import { SessionServices } from "../../agent-host/services.ts";
import { type BoltOn, type Host, withSession } from "../../agent-host/with-session.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, type TurnId, Via } from "../../agent-machine/names.ts";
import type { SettingsChange } from "../../agent-machine/settings.ts";
import { gitTools, isRepositoryRoot } from "../../agent-tools/git.ts";
import { additionalDirectoriesOf, commandToolsOf } from "../../agent-config/builtins.ts";
import type { ToolSpec } from "../../agent-session/contracts.ts";
import { foldersOf } from "../../agent-host/services.ts";
import { recordingChanges } from "../../agent-host/recorded-changes.ts";
import { workspaceTools } from "../../agent-tools/workspace.ts";
import type { Session } from "../../agent-session/loop.ts";
import { SourcedToolRunner } from "../../agent-session/tool-sources.ts";
import { SessionStoreFailed } from "../../agent-session/session-store.ts";
import { harnessParts, reportedBy } from "../../agent-session/origin.ts";
import { invalid } from "./invalid.ts";
import { logKeys } from "./log-keys.ts";

export interface Config {
  readonly sessionId: string;
  readonly target: Asked;
  /** The settings given on the command line: a new session opens with them, and a continued session applies them as a change. */
  readonly settings: SettingsChange;
  /** The `--system-prompt` and `--append-system-prompt` text, which follows the line that names the working folder. */
  readonly system: string | undefined;
  /**
   * The facts of the session being continued (`--continue`, `--resume`). The session keeps its
   * opening; a model or settings here that differ from its own are applied as a change.
   */
  readonly continues?: ReadonlyArray<Fact>;
  /** Whether the session is saved to its file, or kept in memory only (`--no-session-persistence`, starting from `continues`). */
  readonly persist: boolean;
  /** The session's policies, turn-end hooks and MCP servers (`configuration.ts`), and the layers they came from. */
  readonly configuration: Configuration & { readonly layers: ReadonlyArray<LayerSource> };
  /** Whether someone can answer a permission question: true for the REPL at a terminal. */
  readonly canAsk: boolean;
  /** The folders that count as inside the working folder for this session (`--add-dir`). */
  readonly additionalFolders: ReadonlyArray<string>;
  /**
   * Whether a tool call with input properties the tool does not define is refused
   * (`--strict-tool-input`); otherwise it runs without them, and its result names the ones ignored.
   */
  readonly strictToolInput: boolean;
}

/**
 * The folder where the CLI saves sessions (`agent-host/directory.ts`): the brand's sessions folder,
 * which the ACP host shares (`agent-host/brand.ts`). A session's folder holds its facts, its record
 * (`cliRecord`) and the settings it resolved to.
 */
export const storeFolderOf = (brand: Brand): string => sessionsFolderOf(brand);

/** The file a session's log is written to, in the brand's logs folder. */
export const logFileOf = (brand: Brand, sessionId: string): string => join(logsFolderOf(brand), `cli-${sessionId}.log`);

/** The host that a record names when the CLI made the session. */
const cliHost = "cli";

/** What the CLI records of a session besides its facts (`agent-host/record.ts`): that the CLI made it, and its working folder. */
export const cliRecord = (cwd: string) => ({ host: cliHost, cwd });

/** Whether a stored session's record says that the CLI made it in the working folder `cwd`. */
export const madeIn = (record: unknown, cwd: string): boolean => Predicate.isReadonlyObject(record) && record["host"] === cliHost && record["cwd"] === cwd;

/**
 * The workspace tools for the working folder; their commands run with the environment the
 * configuration builds (`commandEnvironment`).
 */
const workspaceOf = (config: Config) =>
  workspaceTools(process.cwd(), {
    strictInput: config.strictToolInput,
    additional: foldersOf(process.cwd(), [...config.additionalFolders, ...additionalDirectoriesOf(config.configuration)]).additional ?? [],
    environment: processEnvironmentWith(seamListsOf(config.configuration, { canAsk: config.canAsk }).commandEnvironment ?? [removeCredentials()]),
  });

/** The git tools bound to the working folder, when it is the root of a git repository; undefined otherwise. */
const gitOf = (config: Config) => (isRepositoryRoot(process.cwd()) ? gitTools(process.cwd(), { strictInput: config.strictToolInput }) : undefined);

/**
 * The loop's services for a CLI session, besides its tool sources and notices, which its bolt-ons
 * give: `SessionServices` with the configuration's `models:` overrides, and the configuration's
 * policies and turn-end hooks.
 */
const servicesOf = (config: Config, live: ReadonlyArray<ToolSpec>) => {
  // The CLI uses its own tool sources (the workspace's and the MCP servers'), not the configuration's.
  const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(config.configuration, {
    canAsk: config.canAsk,
    workingFolder: process.cwd(),
    additionalFolders: config.additionalFolders,
    // The path inputs of the tools the session runs with now, which a session recorded before they were named lacks.
    toolPaths: (name) => live.find((tool) => tool.name === name)?.paths,
  });
  return Layer.mergeAll(SessionServices(SourcedToolRunner).pipe(Layer.provide(Layer.succeed(ModelOverrides, config.configuration.models))), seamLayer(lists));
};

/** The configuration's MCP servers, in the form `startMcpServers` takes. */
const givenOf = (configuration: Configuration): ReadonlyArray<GivenServer> =>
  configuration.mcpServers.map((server) => ({ server: "url" in server ? server : { ...server, cwd: server.cwd ?? process.cwd() }, connectTimeout: server.connectTimeout }));

/**
 * Writes the session's resolved configuration (`effective-settings.json`, `agent-config`
 * `effective.ts`) to its folder, with the CLI's own values: the model and its settings, whether
 * permission questions can be answered, and the names of the environment variables commands get and
 * those removed.
 */
const written = (config: Config, environment: Readonly<Record<string, string>>, root: string) =>
  Effect.gen(function* () {
    const folder = sessionFolderOf(root, config.sessionId);
    const host = {
      model: `${config.target.provider}/${config.target.model}`,
      settings: config.settings as Readonly<Record<string, string>>,
      canAsk: config.canAsk,
      strictToolInput: config.strictToolInput,
      persist: config.persist,
      commandEnvironment: {
        given: Arr.sort(Object.keys(environment), Order.String),
        leftOut: Arr.sort(
          Object.keys(process.env).filter((name) => !(name in environment)),
          Order.String,
        ),
      },
    };
    yield* writeEffectiveSettings(folder, config.configuration.layers, config.configuration, host).pipe(
      Effect.tap((path) => Effect.logInfo(logKeys.settings.written, { path })),
      Effect.catch((error) => Effect.logWarning(logKeys.settings.notWritten, { folder, cause: error.message })),
    );
  });

/** Fails, saying why, when a required MCP server is not running once the servers have started or failed. */
const requiredRunning = (configuration: Configuration, mcp: McpServers) =>
  Effect.gen(function* () {
    const states = yield* mcp.states;
    const missing = configuration.mcpServers.flatMap((server) => {
      const state = states.find((each) => each.name === server.name)?.state;
      return server.required && state !== undefined && state._tag !== "Ready" ? [`${server.name} (${describe(state)})`] : [];
    });
    if (missing.length > 0) return yield* invalid(`Required MCP servers are not running: ${missing.join("; ")}.`);
  });

/**
 * The working folder's bolt-on: the workspace tools, the git tools when the folder is a repository's
 * root, and the system text that names the folder (and says it is a repository's root).
 */
const folderBoltOn = (config: Config, workspace: ReturnType<typeof workspaceOf>, git: ReturnType<typeof gitOf>) =>
  Effect.gen(function* (): Effect.fn.Return<BoltOn, never, FileSystem.FileSystem> {
    // What the working folder's tools change in files is recorded with their results; the MCP servers' tools are not wrapped.
    const recorded = recordingChanges({ root: process.cwd(), folders: foldersOf(process.cwd(), []), commandTools: commandToolsOf(config.configuration) });
    return {
      sources: yield* Effect.forEach([yield* workspace.source, ...(git === undefined ? [] : [yield* git.source])], recorded),
      system: [workspace.system, ...(git === undefined ? [] : [yield* git.system])].join(" "),
    };
  });

/** The MCP servers' bolt-on: their tools, a notice about servers that are not running, and, once the session is open, each change in a server's state, recorded. */
const serversBoltOn = (mcp: McpServers): BoltOn => ({
  sources: mcp.sources,
  notices: [mcp.notices],
  opened: (session) =>
    mcp.changes.pipe(
      Stream.runForEach((change) =>
        session.observe(change).pipe(
          reportedBy(harnessParts.mcpServers),
          Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.mcp.notRecorded, { server: change.server, state: change.state, cause: error.message })),
        ),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    ),
});

/**
 * Opens a new CLI session with `config`, or continues the one it names, and runs `use` with it and
 * its MCP servers, through `withSession` (`agent-host/with-session.ts`), with the CLI's bolt-ons:
 * the working folder's tools and the MCP servers. The session is saved in the brand's sessions
 * folder, recorded as the CLI's, made in this working folder (`cliRecord`), and its blobs in the
 * brand's blobs folder; a session kept in memory only keeps its blobs in memory. A store that cannot be
 * opened or written stops the session with an error. What `use` records comes from the user,
 * through the CLI.
 */
export const withCliSession = <A, E, R, L, H>(
  config: Config,
  logs: Layer.Layer<never, never, L>,
  host: Host<H>,
  use: (session: Session, mcp: McpServers) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const brand = yield* Brand;
    const root = storeFolderOf(brand);
    const workspace = workspaceOf(config);
    yield* written(config, workspace.environment, root);
    // The MCP servers start in the session's scope, before its services, because their tools are among them.
    const mcp = yield* startMcpServers(givenOf(config.configuration), [{ uri: pathToFileURL(process.cwd()).href, name: basename(process.cwd()) }]);
    yield* requiredRunning(config.configuration, mcp);
    const folder = yield* folderBoltOn(config, workspace, gitOf(config));
    return yield* withSession(
      {
        sessionId: config.sessionId,
        target: config.target,
        settings: config.settings,
        system: config.system,
        continues: config.continues,
        persist: config.persist,
        root,
        record: cliRecord(process.cwd()),
        // A saved session's blobs are kept in the brand's blobs folder, which the ACP host shares, so a continued session has them.
        services: Layer.merge(servicesOf(config, workspace.catalog), config.persist ? BlobsInFolder(blobsFolderOf(brand)) : BlobsInMemory),
        boltOns: [folder, serversBoltOn(mcp)],
        logs,
        host,
      },
      (session) => use(session, mcp),
    );
  }).pipe(
    reportedBy({ _tag: "User", via: Via.make("cli") }),
    Effect.scoped,
    Effect.provide(logs),
    Effect.mapError((error) => (error instanceof SessionStoreFailed ? invalid(error.message) : error)),
  );

/** Sends `text` to the session as the user's input, and waits until the session is idle. */
export const ask = (session: Session, text: string) =>
  session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) }).pipe(Effect.andThen(session.idle));

/** Returns the last turn started. */
export const lastTurn = (facts: ReadonlyArray<Fact>): TurnId | undefined =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? [fact.observation.turn] : [])).at(-1);

/** Returns how `turn` ended, if it has. */
export const endingOf = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): Ending | undefined =>
  facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn ? [fact.decision.ending] : [])).at(-1);

/** Returns the text of the last response in `turn`. */
export const answerTo = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): string =>
  facts
    .flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.turn === turn
        ? [fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : [])).join("")]
        : [],
    )
    .at(-1) ?? "";
