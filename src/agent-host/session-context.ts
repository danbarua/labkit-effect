/**
 * The context of a session (`agent-environment/session-context.ts`), as every host makes it: the one
 * place where a session's folders are assembled. A host makes the context where the session's
 * resources start (`makeSessionContext`), and runs the session's work in it (`inSession`).
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
import { Deferred, Effect, Option } from "effect";
import { WordText } from "../agent-environment/command-segments.ts";
import type { Folders } from "../agent-environment/command-units.ts";
import { SessionContext } from "../agent-environment/session-context.ts";
import type { Fact } from "../agent-machine/fact.ts";
import type { SessionId } from "../agent-machine/names.ts";
import { foldersAddedOf } from "../agent-session/configuration/session-setup.ts";

/** Where a session works, as its host knows it before the session has facts. */
export interface SessionPlace {
  readonly session: SessionId;
  /** The working folder, as an absolute path. */
  readonly working: string;
  /** The folders that count as inside the working folder, in order (the module's table): absolute, from `~`, or relative to the working folder. */
  readonly additional: ReadonlyArray<string>;
}

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

/** Makes the context of the session at `place`, its folders read at each use (the module's table). */
export const makeSessionContext = (place: SessionPlace): Effect.Effect<MadeSessionContext> =>
  Effect.map(Deferred.make<Effect.Effect<ReadonlyArray<Fact>>>(), (store) => {
    const facts = Effect.flatMap(
      Deferred.poll(store),
      Option.match({ onNone: () => Effect.succeed<ReadonlyArray<Fact>>([]), onSome: (read) => Effect.flatten(read) }),
    );
    return {
      context: {
        session: place.session,
        working: place.working,
        folders: Effect.map(facts, (all) => foldersOf(place.working, [...place.additional, ...foldersAddedOf(all)])),
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
