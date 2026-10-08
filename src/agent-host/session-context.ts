/**
 * The context of a session (`agent-environment/session-context.ts`), as every host makes it: the one
 * place where a session's folders and its environment are assembled. A host makes the context where
 * the session's resources start (`makeSessionContext`), records what its open changes before any
 * turn runs (`MadeSessionContext.changesAtOpen`), and runs the session's work in it (`inSession`).
 *
 * A session's folders, all absolute, are projected from its facts at each use
 * (`agent-session/configuration/session-home.ts`):
 *
 * | Folder | From |
 * | --- | --- |
 * | the working folder | the host: the CLI's folder, ACP's `cwd`, which each open records (`SessionHomed`) |
 * | the home folder | this process's home folder |
 * | the additional folders, in the order they were added | the launcher's (`--add-dir`), the client's (ACP's `additionalDirectories`) and each permissions entry's (`additionalDirectories`), which each open records (`FolderAdded`, `FolderRemoved`), and the user's (`/add-dir`) |
 *
 * A host gives a folder absolute, from `~` (resolved from the home folder), or relative to the
 * working folder (resolved from it).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Array as Arr, Deferred, Effect, Option, Order } from "effect";
import type { KnownEnvironment } from "../agent-environment/command-environment.ts";
import { WordText } from "../agent-environment/command-segments.ts";
import type { Folders } from "../agent-environment/command-units.ts";
import { SessionContext } from "../agent-environment/session-context.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { FolderPath, type SessionId } from "../agent-machine/names.ts";
import type { FolderSource } from "../agent-machine/observation.ts";
import { type EnvironmentTransform, processEnvironmentWith, removeCredentials } from "../agent-process/environment.ts";
import { changesAtOpen, folded, type GivenFolders, type HomeChange, homeOf } from "../agent-session/configuration/session-home.ts";

/** The folders that one source other than the user gives a session, as the host has them: absolute, from `~`, or relative to the working folder. */
export interface GivenPlaces {
  readonly from: GivenFolders["from"];
  readonly folders: ReadonlyArray<string>;
}

/** Where a session works, as its host knows it before the session has facts. */
export interface SessionPlace {
  readonly session: SessionId;
  /** The working folder, as an absolute path. */
  readonly working: string;
  /** The folders that each source other than the user gives, in order. A source that is not listed gives none. */
  readonly given: ReadonlyArray<GivenPlaces>;
  /**
   * The transforms of this process's environment that make the session's environment, in order: the
   * configuration's `commandEnvironment`. `defaultCommandEnvironment` when left out.
   */
  readonly commandEnvironment?: ReadonlyArray<EnvironmentTransform> | undefined;
}

/**
 * The transforms that make a session's environment when its configuration lists none
 * (`commandEnvironment`): this process's environment without its credential variables
 * (`removeCredentials`).
 */
export const defaultCommandEnvironment: ReadonlyArray<EnvironmentTransform> = [removeCredentials()];

/**
 * Returns the environment that `transforms` make of this process's environment, applied in order
 * (`processEnvironmentWith`), and the names of this process's variables that it does not have.
 */
export const environmentWith = (transforms: ReadonlyArray<EnvironmentTransform>): KnownEnvironment => {
  const variables = processEnvironmentWith(transforms);
  const leftOut = Object.entries(process.env).flatMap(([name, value]) => (value === undefined || Object.hasOwn(variables, name) ? [] : [name]));
  return { _tag: "Known", variables, leftOut: Arr.sort(leftOut, Order.String) };
};

/** Returns `folder` as an absolute path: from the home folder `home` when it starts with `~`, else from the working folder `working`. */
const absolute = (folder: string, working: string, home: string): FolderPath =>
  FolderPath.make(folder === "~" || folder.startsWith("~/") ? join(home, folder.slice(1)) : resolve(working, folder));

/** A session's context, and how its host gives it the session's facts. */
export interface MadeSessionContext {
  readonly context: SessionContext["Service"];
  /**
   * Gives the context the session's facts, read from its store at each use, once the store is open.
   * Until then the session has no facts: an ACP session is a draft, with no store, until its first
   * prompt. Giving a second store is a defect.
   */
  readonly storeOpened: (facts: Effect.Effect<ReadonlyArray<Fact>>) => Effect.Effect<void>;
  /**
   * Returns what the host records when it opens the session over `facts`, before any turn runs:
   * `SessionHomed` when the facts name no working folder or another one, and the additional folders
   * that each source other than the user now gives or no longer gives (`changesAtOpen`). A new
   * session records them after `SessionOpened`; a continued one records them first.
   */
  readonly changesAtOpen: (facts: ReadonlyArray<Fact>) => ReadonlyArray<HomeChange>;
}

/**
 * Makes the context of the session at `place`: its environment, made now from
 * `place.commandEnvironment`, and its folders, projected at each use from the session's facts (the
 * module's table). Until the open's changes are recorded, the folders include them, so a draft that
 * has no store yet has the folders that its open will record.
 */
export const makeSessionContext = (place: SessionPlace): Effect.Effect<MadeSessionContext> =>
  Effect.gen(function* () {
    const store = yield* Deferred.make<Effect.Effect<ReadonlyArray<Fact>>>();
    const environment = yield* Effect.sync(() => environmentWith(place.commandEnvironment ?? defaultCommandEnvironment));
    const home = homedir();
    const working = FolderPath.make(place.working);
    const given: ReadonlyArray<GivenFolders> = place.given.map((each) => ({ from: each.from, folders: each.folders.map((folder) => absolute(folder, place.working, home)) }));
    const changes = (facts: ReadonlyArray<Fact>) => changesAtOpen(facts, working, given);
    const facts = Effect.flatMap(
      Deferred.poll(store),
      Option.match({ onNone: () => Effect.succeed<ReadonlyArray<Fact>>([]), onSome: (read) => Effect.flatten(read) }),
    );
    const foldersFrom = (include: (from: FolderSource) => boolean): Effect.Effect<Folders> =>
      Effect.map(facts, (all) => ({
        working: WordText.make(place.working),
        home: WordText.make(home),
        additional: folded(homeOf(all), changes(all)).additional.flatMap((each) => (include(each.from) ? [WordText.make(each.folder)] : [])),
      }));
    return {
      context: {
        session: place.session,
        working: place.working,
        folders: foldersFrom(() => true),
        foldersFrom,
        environment,
      },
      storeOpened: (read) =>
        Effect.flatMap(Deferred.succeed(store, read), (given) => (given ? Effect.void : Effect.die(new Error(`Session ${place.session} was given a second store`)))),
      changesAtOpen: changes,
    };
  });

/**
 * Runs `effect` in the session of `context`: provides `SessionContext`, annotates each log line with
 * the session (`session`), and annotates each span with the session and its working folder (`cwd`).
 * The fibers that `effect` starts inherit all three.
 */
export const inSession =
  (context: SessionContext["Service"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, SessionContext>> =>
    effect.pipe(
      Effect.provideService(SessionContext, context),
      Effect.annotateLogs({ session: context.session }),
      Effect.annotateSpans({ session: context.session, cwd: context.working }),
    );
