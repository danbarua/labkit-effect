/**
 * A session as a host runs it. `withSession` opens a new session, or continues one from its facts,
 * and runs `use` with it.
 *
 * - The facts are in a store: a file in the session's folder under `root` (`directory.ts`) when the
 *   session is saved, else in memory, starting from the facts it continues. The store writes each
 *   fact before the session acts on it. A store that cannot be opened or written fails the run.
 * - A new saved session's record (`record.ts`) names the host that made it, with what else the host
 *   keeps of it, such as its working folder.
 * - The session's log lines go to the host's log layer (`logs`).
 * - Bolt-ons add what a host's own machinery brings, which the host makes before it calls
 *   `withSession`: tool sources, a part of the opening system text, notice providers, and work that
 *   starts once the session is open. The CLI's bolt-ons are its working folder's tools and its MCP
 *   servers; zork's are its game's world tools.
 * - The host follows the session from its opening (`Host.follow`), and decides whether a turn that a
 *   previous run left unfinished is gone on with or ended (`Host.choose`).
 * - When the run is interrupted during a turn, the interruption is recorded and the turn is waited
 *   for; a second interrupt (Ctrl+C) exits at once.
 *
 * The session that `use` is given carries its own services, so a host can run two sessions at once:
 * zork's engine and adventurer each call the other's session.
 *
 * Every span made in the session carries the host's name (`host`) and, when the record has one, the
 * session's working folder (`cwd`), as the session's record holds them.
 */

import { Effect, Layer, type Scope } from "effect";
import { type NoticeProvider, Notices } from "../agent-context/assemble.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { leftRunning, type LeftRunning } from "../agent-machine/left-running.ts";
import { SessionId } from "../agent-machine/names.ts";
import { changed, type SettingsChange } from "../agent-machine/settings.ts";
import { modelOf, openedWith } from "../agent-session/configuration/session-setup.ts";
import { FileBackedSessionStore } from "../agent-session/file-session-store.ts";
import { endTurnLeftRunning, openSession, type Services, type Session } from "../agent-session/loop.ts";
import { ephemeralSessionStore } from "../agent-session/session-store.ts";
import { offeredTools, type ToolSource, ToolSources } from "../agent-session/tool-sources.ts";
import type { Asked } from "./catalog.ts";
import { sessionFolderOf, storeFileOf } from "./directory.ts";
import { logKeys } from "./log-keys.ts";
import { writeRecord } from "./record.ts";

/** What a host's own machinery adds to a session. */
export interface BoltOn {
  /** Tool sources, after those of the bolt-ons before it. */
  readonly sources?: ReadonlyArray<ToolSource>;
  /** A part of the opening system text, after those of the bolt-ons before it. */
  readonly system?: string;
  /** Notice providers (`agent-context/assemble.ts`), after those of the bolt-ons before it. */
  readonly notices?: ReadonlyArray<NoticeProvider>;
  /** Work started once the session's opening is recorded, with the session's services, which lasts as long as the session, such as recording an MCP server's state changes. */
  readonly opened?: (session: Session) => Effect.Effect<void, never, Scope.Scope | Services>;
}

/**
 * How a host handles a session: it follows the session from its opening (answering permission
 * questions, showing tool calls); it chooses whether to go on with or end a turn a previous run left
 * unfinished; and it shows how a turn it went on with ended.
 */
export interface Host<R = never> {
  readonly follow: (session: Session) => Effect.Effect<void, never, Scope.Scope | R>;
  readonly choose: (left: LeftRunning) => Effect.Effect<"go on" | "end", never, R>;
  readonly wentOn: (session: Session) => Effect.Effect<void, never, R>;
}

/** Follows nothing and goes on with an unfinished turn: for a run where no one can be asked. */
export const Headless: Host = { follow: () => Effect.void, choose: () => Effect.succeed("go on"), wentOn: () => Effect.void };

export interface SessionOptions<SE, SR, L, H> {
  readonly sessionId: string;
  /** The model a new session asks; a continued session asking another is changed to this one. */
  readonly target: Asked;
  /** The settings a new session opens with; a continued session applies them as a change. */
  readonly settings: SettingsChange;
  /** The host's own part of the opening system text, after the bolt-ons' parts. */
  readonly system?: string | undefined;
  /** The facts of the session being continued; none for a new session. */
  readonly continues?: ReadonlyArray<Fact> | undefined;
  /** Whether the session is saved in `root`, or kept in memory only. */
  readonly persist: boolean;
  /** The folder of saved sessions: the brand's sessions folder (`brand.ts`), unless a host or a test gives another. */
  readonly root: string;
  /** What a new saved session's record holds: the host that made it, and what else the host keeps. */
  readonly record: { readonly host: string } & Readonly<Record<string, unknown>>;
  /** The loop's services, except the store and the tool sources, which `withSession` provides: `SessionServices` and the host's own. */
  readonly services: Layer.Layer<Services, SE, SR>;
  readonly boltOns: ReadonlyArray<BoltOn>;
  readonly logs: Layer.Layer<never, never, L>;
  readonly host: Host<H>;
}

/** When the run is interrupted during a turn, records the interruption and waits for the turn to end. A second Ctrl+C exits at once. */
const interrupted = (session: Session) =>
  Effect.gen(function* () {
    const left = leftRunning(yield* session.facts);
    if (left === undefined || left.stopping) return;
    process.once("SIGINT", () => process.exit(130));
    yield* session.observe({ _tag: "TurnInterrupted", turn: left.turn });
    yield* session.idle;
  }).pipe(Effect.catchTag("SessionStoreFailed", (error) => Effect.logError(logKeys.session.notInterrupted, { message: error.message })));

/** Opens a new session with `options`, or continues the one whose facts it gives, and runs `use` with it (see the module's description). */
export const withSession = <A, E, R, SE, SR, L, H>(options: SessionOptions<SE, SR, L, H>, use: (session: Session) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { sessionId, root, boltOns } = options;
    if (options.persist && options.continues === undefined)
      yield* writeRecord(root, sessionId, options.record).pipe(
        Effect.catch((error) => Effect.logWarning(logKeys.record.notWritten, { folder: sessionFolderOf(root, sessionId), cause: error.message })),
      );
    const store = options.persist ? FileBackedSessionStore(storeFileOf(root, sessionId)) : ephemeralSessionStore(options.continues ?? []);
    const given = Layer.mergeAll(Layer.succeed(ToolSources, boltOns.flatMap((boltOn) => boltOn.sources ?? [])), Layer.succeed(Notices, boltOns.flatMap((boltOn) => boltOn.notices ?? [])));
    // The store logs while it opens (a lock taken over, a torn line cut off) to the session's log.
    const layer = Layer.mergeAll(options.services, options.logs).pipe(Layer.provideMerge(given), Layer.provideMerge(store.pipe(Layer.provide(options.logs))));
    // A memo map of its own: a session opened inside another's (zork's adventurer, in its engine's)
    // would otherwise reuse the other's memoized services, its tool runner and its turn numbering among them.
    const context = yield* Layer.buildWithMemoMap(layer, yield* Layer.makeMemoMap, yield* Effect.scope);
    const session = yield* openSession.pipe(Effect.provideContext(context));
    // The session's own services, so that a host's code that holds two sessions asks each with its own.
    const bound: Session = {
      ...session,
      observe: (observation) => session.observe(observation).pipe(Effect.provideContext(context)),
      prompt: (input) => session.prompt(input).pipe(Effect.provideContext(context)),
      cancel: session.cancel.pipe(Effect.provideContext(context)),
    };
    return yield* Effect.gen(function* () {
      yield* options.host.follow(bound);
      const facts = yield* bound.facts;
      if (facts.length === 0) {
        const system = [...boltOns.flatMap((boltOn) => (boltOn.system === undefined ? [] : [boltOn.system])), ...(options.system === undefined ? [] : [options.system])];
        const model = { ...options.target, settings: changed({}, options.settings) };
        yield* bound.observe(openedWith({ session: SessionId.make(sessionId), model, system: system.length === 0 ? undefined : system.join("\n\n"), tools: yield* offeredTools }));
      } else {
        const left = leftRunning(facts);
        if (left === undefined) yield* bound.goOn;
        else if ((yield* options.host.choose(left)) === "go on") {
          yield* bound.goOn;
          yield* bound.idle;
          yield* options.host.wentOn(bound);
        } else yield* endTurnLeftRunning(bound);
        const now = yield* modelOf(facts);
        const different = now.provider !== options.target.provider || now.model !== options.target.model || Object.keys(options.settings).length > 0;
        if (different) yield* bound.observe({ _tag: "ModelChangeArrived", provider: options.target.provider, model: options.target.model, settings: options.settings });
      }
      yield* Effect.forEach(boltOns, (boltOn) => (boltOn.opened === undefined ? Effect.void : boltOn.opened(bound)), { discard: true });
      yield* bound.idle;
      return yield* use(bound).pipe(Effect.onInterrupt(() => interrupted(bound)));
    }).pipe(Effect.provideContext(context));
  }).pipe(
    Effect.annotateSpans({ host: options.record.host, ...(typeof options.record["cwd"] === "string" ? { cwd: options.record["cwd"] } : {}) }),
    Effect.scoped,
    Effect.provide(options.logs),
  );
