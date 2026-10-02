/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say of a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
 *
 * The opening holds the model, its settings and the system prompt; each input is the user's,
 * through the CLI; the conversation is every turn of it. The tools read the folder the CLI runs in
 * (`read_file`, `list_dir`); none changes anything.
 */

import { Effect, FileSystem, Layer, Logger } from "effect";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Notices } from "../../agent-context/assemble.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { workspaceTools } from "../../agent-tools/workspace.ts";
import { openSession, resumeSession, type Session } from "../../agent-session/loop.ts";
import { ModelFromFacts } from "../../agent-session/configuration/model-choice.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { modelOf, openedWith } from "../../agent-session/configuration/session-setup.ts";
import { countingTurnsAfter, NoTurnEndHooks } from "../../agent-session/turns.ts";
import { type Asked, Clients, KnownToCli, SettlingForCli } from "./models.ts";
import { storeFileOf, storing } from "./store.ts";

export interface Config {
  readonly sessionId: string;
  readonly target: Asked;
  readonly settings: ModelSettings;
  readonly system: string | undefined;
  /**
   * The facts of the session this one goes on from (`--continue`). The session keeps its opening;
   * a model or settings in this configuration that differ from its own are taken as a change.
   */
  readonly continues?: ReadonlyArray<Fact>;
}

/** Log lines to stderr: for print mode, where stdout holds the answer alone, as a caller parsing it expects. */
export const LogsToStderr = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

/** Where a session's log lines go when they go to a file. */
export const logFileOf = (sessionId: string): string => `logs/cli/${sessionId}.log`;

/** Log lines to the session's file: for the REPL, where the terminal holds the conversation alone. */
export const LogsToFile = (sessionId: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).makeDirectory("logs/cli", { recursive: true });
      return Logger.layer([Logger.toFile(Logger.formatLogFmt, logFileOf(sessionId), { batchWindow: "100 millis" })]);
    }),
  ).pipe(Layer.orDie);

/** The tools a session is offered: the ones that read the workspace, the folder the CLI runs in. */
const workspace = workspaceTools(process.cwd());

/** What the loop needs, for a CLI session whose facts so far started `turns` turns. */
const Services = (turns: number) => Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownToCli)),
  KnownToCli,
  SettlingForCli,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
    Clients,
    countingTurnsAfter(turns),
    NoTurnEndHooks,
  workspace.runner,
);

/**
 * Opens a session with `config`, or goes on from the one it continues, and runs `use` with it, with
 * the loop's services and `logs`. Its facts are kept in the session store as they are recorded.
 * What `use` reports is the user's, through the CLI.
 */
export const withSession = <A, E, R, L>(config: Config, logs: Layer.Layer<never, never, L>, use: (session: Session) => Effect.Effect<A, E, R>) => {
  const before = config.continues ?? [];
  const turns = before.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted").length;
  return Effect.gen(function* () {
    const session = before.length === 0 ? yield* openSession : yield* resumeSession(before);
    const store = yield* storing(session, storeFileOf(config.sessionId));
    if (before.length === 0)
      yield* session.observe(openedWith({ session: SessionId.make(config.sessionId), model: { ...config.target, settings: config.settings }, system: config.system, tools: workspace.catalog }));
    else {
      const now = yield* modelOf(before);
      const changed = now.provider !== config.target.provider || now.model !== config.target.model || Object.keys(config.settings).length > 0;
      if (changed) yield* session.observe({ _tag: "ModelChangeArrived", provider: config.target.provider, model: config.target.model, settings: config.settings });
    }
    yield* session.idle;
    return yield* use(session).pipe(Effect.ensuring(store.finish));
  }).pipe(reportedBy({ _tag: "User", via: Via.make("cli") }), Effect.scoped, Effect.provide(Layer.mergeAll(Services(turns), logs)));
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
