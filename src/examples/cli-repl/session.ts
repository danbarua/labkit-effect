/**
 * A CLI session through the loop: its configuration, the services it runs with, and what its facts
 * say of a turn. Both ways of running the CLI (`print.ts`, `repl.ts`) are given the open session.
 *
 * The opening holds the model, its settings and the system prompt; each input is the user's,
 * through the CLI; the conversation is every turn of it; there are no tools yet.
 */

import { Effect, FileSystem, Layer, Logger } from "effect";
import { AgentContextAssembler, WholeConversation } from "../../agent-context/assembler.ts";
import { Notices } from "../../agent-context/assemble.ts";
import type { Ending } from "../../agent-machine/decision.ts";
import type { Fact } from "../../agent-machine/fact.ts";
import { InputText, SessionId, type TurnId, Via } from "../../agent-machine/names.ts";
import type { ModelSettings } from "../../agent-machine/settings.ts";
import { ToolRunner } from "../../agent-session/contracts.ts";
import { openSession, type Session } from "../../agent-session/loop.ts";
import { ModelFromFacts } from "../../agent-session/model-choice.ts";
import { reportedBy } from "../../agent-session/origin.ts";
import { openedWith } from "../../agent-session/session-setup.ts";
import { CountingTurns, NoTurnEndHooks } from "../../agent-session/turns.ts";
import { type Asked, Clients, KnownToCli } from "./models.ts";

export interface Config {
  readonly sessionId: string;
  readonly target: Asked;
  readonly settings: ModelSettings;
  readonly system: string | undefined;
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

/** The session has no tools yet: a call names none that exists. */
const NoTools = Layer.succeed(ToolRunner, { run: () => Effect.succeed({ _tag: "Failed" as const, reason: { _tag: "NotFound" as const } }) });

/** What the loop needs, for a CLI session. */
const Services = Layer.mergeAll(
    ModelFromFacts.pipe(Layer.provide(KnownToCli)),
  KnownToCli,
    AgentContextAssembler.pipe(Layer.provide(Layer.mergeAll(WholeConversation, Layer.succeed(Notices, [])))),
    Clients,
    CountingTurns,
    NoTurnEndHooks,
  NoTools,
);

/**
 * Opens a session with `config` and runs `use` with it, with the loop's services and `logs`. What
 * `use` reports is the user's, through the CLI.
 */
export const withSession = <A, E, R, L>(config: Config, logs: Layer.Layer<never, never, L>, use: (session: Session) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const session = yield* openSession;
    yield* session.observe(openedWith({ session: SessionId.make(config.sessionId), model: { ...config.target, settings: config.settings }, system: config.system, tools: [] }));
    yield* session.idle;
    return yield* use(session);
  }).pipe(reportedBy({ _tag: "User", via: Via.make("cli") }), Effect.scoped, Effect.provide(Layer.mergeAll(Services, logs)));

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
