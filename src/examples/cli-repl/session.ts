/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say of a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
 *
 * The opening holds the model, its settings and the system prompt; each input is the user's,
 * through the CLI; the conversation is every turn of it. The tools work on the folder the CLI runs
 * in: `read_file` and `list_dir` read it, and `write_file` changes it, with permission as
 * `--permission-mode` gives it.
 */

import { Effect, FileSystem, Layer, Logger, type Scope } from "effect";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Notices } from "../../agent-context/assemble.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { workspaceTools } from "../../agent-tools/workspace.ts";
import { type PermissionMode, permissions } from "../../agent-policy/permissions.ts";
import type { Policy } from "../../agent-policy/policy.ts";
import { ToolCallPolicy } from "../../agent-session/contracts.ts";
import { leftRunning, type LeftRunning } from "../../agent-machine/left-running.ts";
import { endTurnLeftRunning, openSession, type Session } from "../../agent-session/loop.ts";
import { FileBackedSessionStore } from "../../agent-session/file-session-store.ts";
import { ephemeralSessionStore, SessionStoreFailed } from "../../agent-session/session-store.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { immutableToolCatalogOf, modelOf, openedWith } from "../../agent-session/configuration/session-setup.ts";
import { CountingTurnsInStore, NoTurnEndHooks } from "../../agent-session/turns.ts";
import { type Asked, Clients, KnownToCli, SettlingForCli } from "./models.ts";
import { invalid } from "./invalid.ts";
import { sessionFolderOf, storeFileOf } from "./store.ts";

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
  /** Which tool calls run, are vetoed, or are asked about (`--permission-mode`). */
  readonly permissionMode: PermissionMode;
  /** Whether anyone is there to answer a question before a call runs: the REPL at a terminal. */
  readonly canAsk: boolean;
}

/** Log lines to stderr: for print mode, where stdout holds the answer alone, as a caller parsing it expects. */
export const LogsToStderr = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

/** Where a session's log lines go when they go to a file: beside its facts. */
export const logFileOf = (sessionId: string): string => `${sessionFolderOf(sessionId)}/cli.log`;

/** Log lines to the session's file: for the REPL, where the terminal holds the conversation alone. */
export const LogsToFile = (sessionId: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).makeDirectory(sessionFolderOf(sessionId), { recursive: true });
      return Logger.layer([Logger.toFile(Logger.formatLogFmt, logFileOf(sessionId), { batchWindow: "100 millis" })]);
    }),
  ).pipe(Layer.orDie);

/** The tools a session is offered: the ones that read the workspace, the folder the CLI runs in. */
const workspace = workspaceTools(process.cwd());

/** The permission policy for `config`'s mode, over the tools the session opened with. */
const PermissionsFor = (config: Config) =>
  Layer.succeed(ToolCallPolicy, (facts) =>
    Effect.map(immutableToolCatalogOf(facts), (tools) =>
      permissions(config.permissionMode, config.canAsk, (name) => tools.find((tool) => tool.name === name)?.kind, facts) as Policy<unknown>,
    ),
  );

/** What the loop needs, for a CLI session; its turns count on from those its store holds. */
const Services = Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownToCli)),
  KnownToCli,
  SettlingForCli,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
    Clients,
    CountingTurnsInStore,
    NoTurnEndHooks,
  workspace.runner,
);

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
  const store = config.persist ? FileBackedSessionStore(storeFileOf(config.sessionId)) : ephemeralSessionStore(config.continues ?? []);
  return Effect.gen(function* () {
    const session = yield* openSession;
    yield* host.follow(session);
    const facts = yield* session.facts;
    if (facts.length === 0)
      yield* session.observe(openedWith({ session: SessionId.make(config.sessionId), model: { ...config.target, settings: config.settings }, system: config.system, tools: workspace.catalog }));
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
    yield* session.idle;
    return yield* use(session).pipe(Effect.onInterrupt(() => interrupted(session)));
  }).pipe(
    reportedBy({ _tag: "User", via: Via.make("cli") }),
    Effect.scoped,
    // The store logs as it opens (a lock taken over, a line cut off): to the session's log, as the rest does.
    Effect.provide(Layer.mergeAll(Services, PermissionsFor(config), logs).pipe(Layer.provideMerge(store.pipe(Layer.provide(logs))))),
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
