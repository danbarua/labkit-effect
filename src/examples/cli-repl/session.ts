/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say of a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
 *
 * The opening holds the model, its settings and the system prompt; each input is the user's,
 * through the CLI; the conversation is every turn of it. The tools work on the folder the CLI runs
 * in (`agent-tools/workspace.ts`): `read_file` and `list_dir` read it, `write_file` and `edit_file`
 * change it, and `run_command` runs a shell command in it; then the tools of the MCP servers the
 * configuration names (`configuration.ts`). Its policies and turn-end hooks are the configuration's
 * (`agent-config`): by default, permission as `--permission-mode` gives it.
 */

import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, type Scope, Stream } from "effect";
import { Notices } from "../../agent-context/assemble.ts";
import type { Configuration } from "../../agent-config/file.ts";
import { seamLayer, seamListsOf } from "../../agent-config/seams.ts";
import { describe } from "../../agent-mcp/server-machine.ts";
import { credentialsLeftOut, environmentOf } from "../../agent-process/environment.ts";
import { type GivenServer, type McpServers, startMcpServers } from "../../agent-mcp/servers.ts";
import type { Asked } from "../../agent-host/catalog.ts";
import { sessionFolderOf, storeFileOf } from "../../agent-host/directory.ts";
import { SessionServices } from "../../agent-host/services.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { workspaceTools } from "../../agent-tools/workspace.ts";
import { leftRunning, type LeftRunning } from "../../agent-machine/left-running.ts";
import { endTurnLeftRunning, openSession, type Session } from "../../agent-session/loop.ts";
import { offeredTools, SourcedToolRunner, type ToolSource, ToolSources } from "../../agent-session/tool-sources.ts";
import { FileBackedSessionStore } from "../../agent-session/file-session-store.ts";
import { ephemeralSessionStore, SessionStoreFailed } from "../../agent-session/session-store.ts";
import { harnessParts, reportedBy } from "../../agent-session/origin.ts";
import { modelOf, openedWith } from "../../agent-session/configuration/session-setup.ts";
import { invalid } from "./invalid.ts";

export interface Config {
  readonly sessionId: string;
  readonly target: Asked;
  readonly settings: ModelSettings;
  readonly system: string | undefined;
  /**
   * The facts of the session this one goes on from (`--continue`, `--resume`), as read when it was
   * chosen. The session keeps its opening; a model or settings in this configuration that differ
   * from its own are taken as a change.
   */
  readonly continues?: ReadonlyArray<Fact>;
  /**
   * Whether the session's facts are kept in its file (the file-backed session store), or only in
   * memory (`--no-session-persistence`: the ephemeral store, starting from `continues`).
   */
  readonly persist: boolean;
  /** The session's policies, turn-end hooks and MCP servers, from its layers (`configuration.ts`). */
  readonly configuration: Configuration;
  /** Whether anyone is there to answer a question before a call runs: the REPL at a terminal. */
  readonly canAsk: boolean;
  /**
   * Whether a tool call whose input has properties its tool does not take is refused
   * (`--strict-tool-input`); if not, it runs without them, and its result says which were ignored.
   */
  readonly strictToolInput: boolean;
}

/**
 * Where the CLI keeps sessions (`agent-host/directory.ts`): `--continue` goes on from the session
 * written to last, `--resume <session>` from the one named.
 */
export const storeFolder = "logs/cli";

/** Where a session's log lines go when they go to a file: beside its facts. */
export const logFileOf = (sessionId: string): string => `${sessionFolderOf(storeFolder, sessionId)}/cli.log`;

/**
 * The tools a session is offered: the workspace's, the folder the CLI runs in, its commands given the
 * environment the configuration composes (`commandEnvironment`).
 */
const workspaceOf = (config: Config) =>
  workspaceTools(process.cwd(), {
    strictInput: config.strictToolInput,
    environment: environmentOf(seamListsOf(config.configuration, { canAsk: config.canAsk }).commandEnvironment ?? [credentialsLeftOut()]),
  });

/**
 * What the loop needs, for a CLI session: its tool sources, the workspace's then the MCP servers';
 * the notices of servers not running; its turns count on from those its store holds; and the
 * configuration's policies and turn-end hooks.
 */
const servicesOf = (config: Config, sources: ReadonlyArray<ToolSource>, mcp: McpServers) => {
  // The configuration's tool sources are not offered by the CLI: its own are the workspace's and the MCP servers'.
  const { toolSources: _, commandEnvironment: __, ...lists } = seamListsOf(config.configuration, { canAsk: config.canAsk });
  return Layer.mergeAll(SessionServices(SourcedToolRunner).pipe(Layer.provide(Layer.succeed(Notices, [mcp.notices]))), seamLayer(lists)).pipe(
    Layer.provideMerge(Layer.succeed(ToolSources, sources)),
  );
};

/** The MCP servers the configuration names, as `startMcpServers` takes them. */
const givenOf = (configuration: Configuration): ReadonlyArray<GivenServer> =>
  configuration.mcpServers.map((server) => ({
    _tag: "Stdio",
    server: { name: server.name, command: server.command, args: server.args, env: server.env, cwd: server.cwd ?? process.cwd() },
    connectTimeout: server.connectTimeout,
  }));

/** Fails, saying why, when a server the configuration says is required is not running once the servers have settled. */
const requiredRunning = (configuration: Configuration, mcp: McpServers) =>
  Effect.gen(function* () {
    const states = yield* mcp.states;
    const missing = configuration.mcpServers.flatMap((server) => {
      const state = states.find((each) => each.name === server.name)?.state;
      return server.required && state !== undefined && state._tag !== "Ready" ? [`${server.name} (${describe(state)})`] : [];
    });
    if (missing.length > 0) return yield* invalid(`The session needs MCP servers that are not running: ${missing.join("; ")}.`);
  });

/**
 * What a way of running the CLI does with a session as it opens: follows its facts from the start
 * (answering what is asked before a call runs, showing tool calls), for as long as the session
 * lasts; says what becomes of a turn the facts left running: go on with it, or end it; and shows
 * how it went once it has gone on.
 */
export interface Host<R = never> {
  readonly follow: (session: Session) => Effect.Effect<void, never, Scope.Scope | R>;
  readonly choose: (left: LeftRunning) => Effect.Effect<"go on" | "end", never, R>;
  readonly wentOn: (session: Session) => Effect.Effect<void, never, R>;
}

/** Follows nothing, and goes on with a turn the facts left running: for print mode, where no one is there to ask. */
export const Headless: Host = { follow: () => Effect.void, choose: () => Effect.succeed("go on"), wentOn: () => Effect.void };

/**
 * Ends the turn under way, if one is, when the user stops the CLI (Ctrl+C): records that it was
 * interrupted, and waits while each request reports how far it got and the turn ends. A second
 * Ctrl+C meanwhile exits at once.
 */
const interrupted = (session: Session) =>
  Effect.gen(function* () {
    const left = leftRunning(yield* session.facts);
    if (left === undefined || left.stopping) return;
    process.once("SIGINT", () => process.exit(130));
    yield* session.observe({ _tag: "TurnInterrupted", turn: left.turn });
    yield* session.idle;
  }).pipe(Effect.catchTag("SessionStoreFailed", (error) => Effect.logError("cli.session.not_interrupted", { message: error.message })));

/**
 * Opens a session with `config`, or goes on from the one it continues, and runs `use` with it, with
 * the loop's services and `logs`. Its facts are kept in its store, which writes each one before the
 * session acts on it. The host follows the session from when it opens (`follow`), and a turn its
 * facts left running (the process ended while it ran) goes on, or ends, as it says (`choose`). Stopping the CLI while a turn runs ends the turn as interrupted
 * (`interrupted`). A store that cannot be opened or written to is said, and the session stops.
 * What `use` reports is the user's, through the CLI.
 */
export const withSession = <A, E, R, L, H>(
  config: Config,
  logs: Layer.Layer<never, never, L>,
  host: Host<H>,
  use: (session: Session) => Effect.Effect<A, E, R>,
) => {
  const workspace = workspaceOf(config);
  const store = config.persist ? FileBackedSessionStore(storeFileOf(storeFolder, config.sessionId)) : ephemeralSessionStore(config.continues ?? []);
  const opened = (mcp: McpServers) => Effect.gen(function* () {
    const session = yield* openSession;
    yield* host.follow(session);
    const facts = yield* session.facts;
    if (facts.length === 0)
      yield* session.observe(openedWith({ session: SessionId.make(config.sessionId), model: { ...config.target, settings: config.settings }, system: config.system, tools: yield* offeredTools }));
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
    // Once the session's facts have their opening: its MCP servers' states, and each change of them.
    yield* mcp.changes.pipe(
      Stream.runForEach((change) =>
        session.observe(change).pipe(
          reportedBy(harnessParts.mcpServers),
          Effect.catchTag("SessionStoreFailed", (error) => Effect.logError("cli.mcp.not_recorded", { server: change.server, state: change.state, cause: error.message })),
        ),
      ),
      Effect.forkScoped,
    );
    yield* session.idle;
    return yield* use(session).pipe(Effect.onInterrupt(() => interrupted(session)));
  });
  return Effect.gen(function* () {
    // The MCP servers start in the session's scope, before its services: their tools are among them.
    const mcp = yield* startMcpServers(givenOf(config.configuration), [{ uri: pathToFileURL(process.cwd()).href, name: basename(process.cwd()) }]);
    yield* requiredRunning(config.configuration, mcp);
    const sources = [yield* workspace.source, ...mcp.sources];
    // The store logs as it opens (a lock taken over, a line cut off): to the session's log, as the rest does.
    return yield* opened(mcp).pipe(Effect.provide(Layer.mergeAll(servicesOf(config, sources, mcp), logs).pipe(Layer.provideMerge(store.pipe(Layer.provide(logs))))));
  }).pipe(
    reportedBy({ _tag: "User", via: Via.make("cli") }),
    Effect.scoped,
    Effect.provide(logs),
    Effect.mapError((error) => (error instanceof SessionStoreFailed ? invalid(error.message) : error)),
  );
};

/** Sends `text` to the session as the user's input, and waits until nothing is under way. */
export const ask = (session: Session, text: string) =>
  session.observe({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) }).pipe(Effect.andThen(session.idle));

/** The last turn the facts started. */
export const lastTurn = (facts: ReadonlyArray<Fact>): TurnId | undefined =>
  facts.flatMap((fact) => (fact._tag === "Observed" && fact.observation._tag === "TurnStarted" ? [fact.observation.turn] : [])).at(-1);

/** How `turn` ended, when it has. */
export const endingOf = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): Ending | undefined =>
  facts.flatMap((fact) => (fact._tag === "Decided" && fact.decision._tag === "TurnEnded" && fact.decision.turn === turn ? [fact.decision.ending] : [])).at(-1);

/** The text of the last response to `turn`. */
export const answerTo = (facts: ReadonlyArray<Fact>, turn: TurnId | undefined): string =>
  facts
    .flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelResponded" && fact.observation.turn === turn
        ? [fact.observation.parts.flatMap((part) => (part._tag === "Text" ? [part.text] : [])).join("")]
        : [],
    )
    .at(-1) ?? "";
