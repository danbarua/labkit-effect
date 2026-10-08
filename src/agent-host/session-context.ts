/**
 * The context of a session (`agent-environment/session-context.ts`), as every host makes it: the one
 * place where a session's folders and its environment are assembled. A host makes the context where
 * the session's resources start (`makeSessionContext`), and runs the session's work in it
 * (`inSession`).
 *
 * A session's folders, all absolute, are read from the session at each use:
 *
 * | Folder | From |
 * | --- | --- |
 * | the working folder | the host: the CLI's folder, ACP's `cwd` |
 * | the home folder | this process's home folder |
 * | the additional folders, in order | the launcher's (`--add-dir`), the client's (ACP's `additionalDirectories`), the configuration's (`additionalDirectories` of the permissions plug-in), then those the user added to the session (`FolderAdded`), read from its facts |
 *
 * An additional folder from `~` is resolved from the home folder; a relative one from the working
 * folder.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Array as Arr, Deferred, Effect, Option, Order } from "effect";
import type { KnownEnvironment } from "../agent-environment/command-environment.ts";
import { WordText } from "../agent-environment/command-segments.ts";
import type { Folders } from "../agent-environment/command-units.ts";
import { SessionContext } from "../agent-environment/session-context.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { SessionId } from "../agent-machine/names.ts";
import { type EnvironmentTransform, processEnvironmentWith, removeCredentials } from "../agent-process/environment.ts";
import { foldersAddedOf } from "../agent-session/configuration/session-setup.ts";

/** Where a session works, as its host knows it before the session has facts. */
export interface SessionPlace {
  readonly session: SessionId;
  /** The working folder, as an absolute path. */
  readonly working: string;
  /** The folders that count as inside the working folder, in order (the module's table): absolute, from `~`, or relative to the working folder. */
  readonly additional: ReadonlyArray<string>;
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

/** The working folder, the home folder, and `additional` resolved against them (`~/x` from the home folder, a relative path from the working folder). */
const foldersOf = (working: string, additional: ReadonlyArray<string>): Folders => {
  const home = homedir();
  return {
    working: WordText.make(working),
    home: WordText.make(home),
    additional: additional.map((folder) => WordText.make(folder === "~" || folder.startsWith("~/") ? join(home, folder.slice(1)) : resolve(working, folder))),
  };
};

/**
 * The folders of the session at `place` before the user adds any: what the opening system text names
 * (`workingFolderLine`), which the folders added later do not change.
 */
export const openingFolders = (place: Pick<SessionPlace, "working" | "additional">): Folders => foldersOf(place.working, place.additional);

/** A session's context, and how its host gives it the session's facts. */
export interface MadeSessionContext {
  readonly context: SessionContext["Service"];
  /**
   * Gives the context the session's facts, read from its store at each use, once the store is open.
   * Until then the session has no facts: an ACP session is a draft, with no store, until its first
   * prompt. Giving a second store is a defect.
   */
  readonly storeOpened: (facts: Effect.Effect<ReadonlyArray<Fact>>) => Effect.Effect<void>;
}

/**
 * Makes the context of the session at `place`: its folders, read at each use (the module's table),
 * and its environment, made now from `place.commandEnvironment`.
 */
export const makeSessionContext = (place: SessionPlace): Effect.Effect<MadeSessionContext> =>
  Effect.gen(function* () {
    const store = yield* Deferred.make<Effect.Effect<ReadonlyArray<Fact>>>();
    const environment = yield* Effect.sync(() => environmentWith(place.commandEnvironment ?? defaultCommandEnvironment));
    const facts = Effect.flatMap(
      Deferred.poll(store),
      Option.match({ onNone: () => Effect.succeed<ReadonlyArray<Fact>>([]), onSome: (read) => Effect.flatten(read) }),
    );
    return {
      context: {
        session: place.session,
        working: place.working,
        folders: Effect.map(facts, (all) => foldersOf(place.working, [...place.additional, ...foldersAddedOf(all)])),
        environment,
      },
      storeOpened: (read) =>
        Effect.flatMap(Deferred.succeed(store, read), (given) => (given ? Effect.void : Effect.die(new Error(`Session ${place.session} was given a second store`)))),
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
