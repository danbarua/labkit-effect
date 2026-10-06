/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say about a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
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
import { Array as Arr, Effect, Layer, Order, Predicate, type Scope, Stream } from "effect";
import { Notices } from "../../agent-context/assemble.ts";
import { ModelOverrides } from "../../agent-session/configuration/well-known-models.ts";
import { writeEffectiveSettings } from "../../agent-config/effective.ts";
import type { Configuration, LayerSource } from "../../agent-config/file.ts";
import { seamLayer, seamListsOf } from "../../agent-config/seams.ts";
import { describe } from "../../agent-mcp/server-machine.ts";
import { removeCredentials, processEnvironmentWith } from "../../agent-process/environment.ts";
import { type GivenServer, type McpServers, startMcpServers } from "../../agent-mcp/servers.ts";
import type { Asked } from "../../agent-host/catalog.ts";
import { Brand, logsFolderOf, sessionsFolderOf } from "../../agent-host/brand.ts";
import { sessionFolderOf, storeFileOf } from "../../agent-host/directory.ts";
import { writeRecord } from "../../agent-host/record.ts";
import { SessionServices } from "../../agent-host/services.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import { changed, type SettingsChange } from "../../agent-machine/settings.ts";
import { gitTools, isRepositoryRoot } from "../../agent-tools/git.ts";
import { workspaceTools } from "../../agent-tools/workspace.ts";
import { leftRunning, type LeftRunning } from "../../agent-machine/left-running.ts";
import { endTurnLeftRunning, openSession, type Session } from "../../agent-session/loop.ts";
import { offeredTools, SourcedToolRunner, type ToolSource, ToolSources } from "../../agent-session/tool-sources.ts";
import { FileBackedSessionStore } from "../../agent-session/file-session-store.ts";
import { ephemeralSessionStore, SessionStoreFailed } from "../../agent-session/session-store.ts";
import { harnessParts, reportedBy } from "../../agent-session/origin.ts";
import { modelOf, openedWith } from "../../agent-session/configuration/session-setup.ts";
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
    environment: processEnvironmentWith(seamListsOf(config.configuration, { canAsk: config.canAsk }).commandEnvironment ?? [removeCredentials()]),
  });

/** The git tools bound to the working folder, when it is the root of a git repository; undefined otherwise. */
const gitOf = (config: Config) => (isRepositoryRoot(process.cwd()) ? gitTools(process.cwd(), { strictInput: config.strictToolInput }) : undefined);

/**
 * The loop's services for a CLI session: the tool sources (the workspace's, the git tools' when the
 * working folder is a repository's root, then the MCP servers'),
 * notices about servers that are not running, turn numbering that continues from the stored facts,
 * and the configuration's policies and turn-end hooks.
 */
const servicesOf = (config: Config, sources: ReadonlyArray<ToolSource>, mcp: McpServers) => {
  // The CLI uses its own tool sources (the workspace's and the MCP servers'), not the configuration's.
  const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(config.configuration, { canAsk: config.canAsk });
  // Model capabilities come from the catalog, with the configuration's `models:` overrides applied.
  const given = Layer.mergeAll(Layer.succeed(Notices, [mcp.notices]), Layer.succeed(ModelOverrides, config.configuration.models));
  return Layer.mergeAll(SessionServices(SourcedToolRunner).pipe(Layer.provide(given)), seamLayer(lists)).pipe(
    Layer.provideMerge(Layer.succeed(ToolSources, sources)),
  );
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
    // A new session saved to disk is recorded as the CLI's, made in this working folder, so `--continue` finds it here.
    if (config.persist && config.continues === undefined)
      yield* writeRecord(root, config.sessionId, cliRecord(process.cwd())).pipe(
        Effect.catch((error) => Effect.logWarning(logKeys.settings.notWritten, { folder, cause: error.message })),
      );
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
 * How a way of running the CLI handles a session: it follows the session from its opening (answering
 * permission questions, showing tool calls); it chooses whether to resume or end a turn a previous run
 * left unfinished; and it shows how a resumed turn ended.
 */
export interface Host<R = never> {
  readonly follow: (session: Session) => Effect.Effect<void, never, Scope.Scope | R>;
  readonly choose: (left: LeftRunning) => Effect.Effect<"go on" | "end", never, R>;
  readonly wentOn: (session: Session) => Effect.Effect<void, never, R>;
}

/** Follows nothing and resumes an unfinished turn: for print mode, where no one can be asked. */
export const Headless: Host = { follow: () => Effect.void, choose: () => Effect.succeed("go on"), wentOn: () => Effect.void };

/**
 * When the user stops the CLI (Ctrl+C) during a turn, records the interruption and waits for the
 * turn's requests to settle and the turn to end. A second Ctrl+C exits at once.
 */
const interrupted = (session: Session) =>
  Effect.gen(function* () {
    const left = leftRunning(yield* session.facts);
    if (left === undefined || left.stopping) return;
    process.once("SIGINT", () => process.exit(130));
    yield* session.observe({ _tag: "TurnInterrupted", turn: left.turn });
    yield* session.idle;
  }).pipe(Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.session.notInterrupted, { message: error.message })));

/**
 * Opens a new session with `config`, or continues the one it names, and runs `use` with it, the
 * loop's services and `logs`. The store writes each fact before the session acts on it. The host
 * follows the session from its opening (`follow`), and decides whether a turn left unfinished by a
 * previous run is resumed or ended (`choose`). Stopping the CLI during a turn ends the turn as
 * interrupted (`interrupted`). A store that cannot be opened or written stops the session with an
 * error. What `use` records comes from the user, through the CLI.
 */
export const withSession = <A, E, R, L, H>(
  config: Config,
  logs: Layer.Layer<never, never, L>,
  host: Host<H>,
  use: (session: Session, mcp: McpServers) => Effect.Effect<A, E, R>,
) => {
  const workspace = workspaceOf(config);
  const git = gitOf(config);
  const opened = (mcp: McpServers) => Effect.gen(function* () {
    const session = yield* openSession;
    yield* host.follow(session);
    const facts = yield* session.facts;
    if (facts.length === 0) {
      const folder = [workspace.system, ...(git === undefined ? [] : [yield* git.system])].join(" ");
      yield* session.observe(openedWith({ session: SessionId.make(config.sessionId), model: { ...config.target, settings: changed({}, config.settings) }, system: [folder, ...(config.system === undefined ? [] : [config.system])].join("\n\n"), tools: yield* offeredTools }));
    }
    else {
      const left = leftRunning(facts);
      if (left === undefined) yield* session.goOn;
      else if ((yield* host.choose(left)) === "go on") {
        yield* session.goOn;
        yield* session.idle;
        yield* host.wentOn(session);
      } else yield* endTurnLeftRunning(session);
      const now = yield* modelOf(facts);
      const changed = now.provider !== config.target.provider || now.model !== config.target.model || Object.keys(config.settings).length > 0;
      if (changed) yield* session.observe({ _tag: "ModelChangeArrived", provider: config.target.provider, model: config.target.model, settings: config.settings });
    }
    // After the opening is recorded: the MCP servers' states, and each later change.
    yield* mcp.changes.pipe(
      Stream.runForEach((change) =>
        session.observe(change).pipe(
          reportedBy(harnessParts.mcpServers),
          Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.mcp.notRecorded, { server: change.server, state: change.state, cause: error.message })),
        ),
      ),
      Effect.forkScoped,
    );
    yield* session.idle;
    return yield* use(session, mcp).pipe(Effect.onInterrupt(() => interrupted(session)));
  });
  return Effect.gen(function* () {
    const root = storeFolderOf(yield* Brand);
    const store = config.persist ? FileBackedSessionStore(storeFileOf(root, config.sessionId)) : ephemeralSessionStore(config.continues ?? []);
    yield* written(config, workspace.environment, root);
    // The MCP servers start in the session's scope, before its services, because their tools are among them.
    const mcp = yield* startMcpServers(givenOf(config.configuration), [{ uri: pathToFileURL(process.cwd()).href, name: basename(process.cwd()) }]);
    yield* requiredRunning(config.configuration, mcp);
    const sources = [yield* workspace.source, ...(git === undefined ? [] : [yield* git.source]), ...mcp.sources];
    // The store logs while it opens (a lock taken over, a torn line cut off) to the session's log.
    return yield* opened(mcp).pipe(Effect.provide(Layer.mergeAll(servicesOf(config, sources, mcp), logs).pipe(Layer.provideMerge(store.pipe(Layer.provide(logs))))));
  }).pipe(
    reportedBy({ _tag: "User", via: Via.make("cli") }),
    Effect.scoped,
    Effect.provide(logs),
    Effect.mapError((error) => (error instanceof SessionStoreFailed ? invalid(error.message) : error)),
  );
};

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
