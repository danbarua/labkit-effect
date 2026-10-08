/**
 * A session's home and its additional folders, projected from its facts.
 *
 * - `homeOf` folds the facts in order. The working folder is the `working` of the last
 *   `SessionHomed`. A `FolderAdded` adds its folder from its source, and a `FolderRemoved` takes the
 *   folder away from that source. A folder is listed once for each source that gives it.
 * - `changesAtOpen` returns what a host records each time it opens a session, before any turn runs.
 * - TurnZero is the first `TurnStarted`. The system text names the working folder and the additional
 *   folders that the facts before TurnZero leave (`homeLineOf`), so a change recorded before TurnZero
 *   replaces an earlier one and the model is not told of it. Each change recorded after TurnZero is
 *   told to the model where it was recorded (`changeTextOf`).
 */

import { Array as Arr } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import { type FolderPath, NoticeText, type Seq } from "../../agent-machine/names.ts";
import type { FolderSource, Observation } from "../../agent-machine/observation.ts";

/** A fact that changes the session's home or its additional folders. */
export type HomeChange = Extract<Observation, { readonly _tag: "SessionHomed" | "FolderAdded" | "FolderRemoved" }>;

/** An additional folder of a session, absolute, and the source that gave it. */
export interface SourcedFolder {
  readonly folder: FolderPath;
  readonly from: FolderSource;
}

/** A session's home and its additional folders, as its facts leave them. */
export interface SessionHome {
  /** The working folder: the `working` of the last `SessionHomed`; undefined when the facts record none. */
  readonly working: FolderPath | undefined;
  /** The additional folders, each with its source, in the order they were added. */
  readonly additional: ReadonlyArray<SourcedFolder>;
}

/** The folders that one source other than the user gives a session when a host opens it, absolute, in order. */
export interface GivenFolders {
  readonly from: Exclude<FolderSource, { readonly _tag: "User" }>;
  readonly folders: ReadonlyArray<FolderPath>;
}

const noHome: SessionHome = { working: undefined, additional: [] };

/** Whether `a` and `b` are the same source: the same kind, and for a permissions entry the same entry. */
export const sameSource = (a: FolderSource, b: FolderSource): boolean =>
  a._tag === "Permissions" ? b._tag === "Permissions" && a.entry === b.entry : a._tag === b._tag;

const isChange = (observation: Observation): observation is HomeChange =>
  observation._tag === "SessionHomed" || observation._tag === "FolderAdded" || observation._tag === "FolderRemoved";

/** Whether `fact` records a change of the session's home or its additional folders. */
export const isHomeChange = (fact: Fact): fact is Extract<Fact, { readonly _tag: "Observed" }> & { readonly observation: HomeChange } =>
  fact._tag === "Observed" && isChange(fact.observation);

const holds = (home: SessionHome, folder: FolderPath, from: FolderSource): boolean => home.additional.some((each) => each.folder === folder && sameSource(each.from, from));

/** Returns `home` after `change`. */
const after = (home: SessionHome, change: HomeChange): SessionHome => {
  switch (change._tag) {
    case "SessionHomed":
      return { ...home, working: change.working };
    case "FolderAdded":
      return holds(home, change.folder, change.from) ? home : { ...home, additional: [...home.additional, { folder: change.folder, from: change.from }] };
    case "FolderRemoved":
      return { ...home, additional: home.additional.filter((each) => !(each.folder === change.folder && sameSource(each.from, change.from))) };
    default:
      return change satisfies never;
  }
};

/** Returns `home` after `changes`, in order. */
export const folded = (home: SessionHome, changes: ReadonlyArray<HomeChange>): SessionHome => changes.reduce(after, home);

/** Returns the session's home and its additional folders, folded from `facts` in order. */
export const homeOf = (facts: ReadonlyArray<Fact>): SessionHome =>
  folded(
    noHome,
    facts.flatMap((fact) => (isHomeChange(fact) ? [fact.observation] : [])),
  );

/** Returns the position of TurnZero, the first `TurnStarted`; undefined when no turn has started. */
export const turnZeroOf = (facts: ReadonlyArray<Fact>): Seq | undefined =>
  facts.find((fact) => fact._tag === "Observed" && fact.observation._tag === "TurnStarted")?.seq;

/** Returns the facts recorded before TurnZero; all of `facts` when no turn has started. */
const beforeTurnZero = (facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> => {
  const zero = turnZeroOf(facts);
  return zero === undefined ? facts : facts.filter((fact) => fact.seq < zero);
};

/**
 * Returns the text that names the working folder `folder` and the folders that count as inside it
 * (`additional`). The tool descriptions refer to "the working folder" without naming it, so the
 * system text names it.
 */
export const workingFolderLine = (folder: string, additional: ReadonlyArray<string> = []): string =>
  `The working folder is ${folder}.${additional.length === 0 ? "" : ` These folders count as inside it too: ${additional.join(", ")}.`}`;

/**
 * Returns the system text's line that names the session's working folder and its additional folders,
 * from every source, as the facts before TurnZero leave them. Returns undefined when those facts
 * record no working folder: every host records `SessionHomed` when it first opens a session, so only
 * a session that no host opened (a test's) has none.
 */
export const homeLineOf = (facts: ReadonlyArray<Fact>): string | undefined => {
  const home = homeOf(beforeTurnZero(facts));
  return home.working === undefined ? undefined : workingFolderLine(home.working, home.additional.map((each) => each.folder));
};

/**
 * Returns what a host records when it opens the session whose facts are `facts`, in the working
 * folder `working`, with the folders that each source other than the user gives (`given`):
 *
 * 1. `SessionHomed` with `working`, when the facts record no working folder or another one.
 * 2. For each source other than the user (those that `given` lists, in order, then those that only
 *    the facts name): a `FolderRemoved` for each folder that the facts have from the source and that
 *    the source no longer gives, then a `FolderAdded` for each folder that the source gives and that
 *    the facts do not have from it. A source that `given` does not list gives no folders.
 *
 * Returns nothing when nothing differs. The folders added by the user are left as they are.
 */
export const changesAtOpen = (facts: ReadonlyArray<Fact>, working: FolderPath, given: ReadonlyArray<GivenFolders>): ReadonlyArray<HomeChange> => {
  const home = homeOf(facts);
  const homed: ReadonlyArray<HomeChange> = home.working === working ? [] : [{ _tag: "SessionHomed", working }];
  const recorded = home.additional.filter((each) => each.from._tag !== "User");
  const sources = [...given.map((each): FolderSource => each.from), ...recorded.map((each) => each.from)].reduce<ReadonlyArray<FolderSource>>(
    (seen, from) => (seen.some((each) => sameSource(each, from)) ? seen : [...seen, from]),
    [],
  );
  const changes = sources.flatMap((from): ReadonlyArray<HomeChange> => {
    const gives = Arr.dedupe(given.flatMap((each) => (sameSource(each.from, from) ? each.folders : [])));
    const had = recorded.flatMap((each) => (sameSource(each.from, from) ? [each.folder] : []));
    return [
      ...had.filter((folder) => !gives.includes(folder)).map((folder): HomeChange => ({ _tag: "FolderRemoved", folder, from })),
      ...gives.filter((folder) => !had.includes(folder)).map((folder): HomeChange => ({ _tag: "FolderAdded", folder, from })),
    ];
  });
  return [...homed, ...changes];
};

/**
 * Returns what the model is told of `change`, recorded after TurnZero, when the session's home was
 * `before` until then. A `FolderAdded` from the user keeps the words that `/add-dir` has always had.
 * A `SessionHomed` that names another working folder than `before` is told as a move. A
 * `FolderRemoved` of a folder that another source still gives says that the folder still counts.
 */
export const changeTextOf = (change: HomeChange, before: SessionHome): NoticeText => {
  const counts = (folder: FolderPath) => folded(before, [change]).additional.some((each) => each.folder === folder);
  switch (change._tag) {
    case "SessionHomed":
      return NoticeText.make(
        before.working === undefined
          ? `The working folder is now ${change.working}.`
          : `The session moved from the working folder ${before.working} to ${change.working}. Relative paths now lead from ${change.working}, and the files there may not be those you have seen.`,
      );
    case "FolderAdded":
      return NoticeText.make(
        change.from._tag === "User"
          ? `The user added the folder ${change.folder}: it counts as inside the working folder, so you may read and change files there.`
          : `The folder ${change.folder} was added to the session's folders: it counts as inside the working folder, so you may read and change files there.`,
      );
    case "FolderRemoved": {
      const removed = change.from._tag === "User" ? `The user removed the folder ${change.folder}` : `The folder ${change.folder} was removed from the session's folders`;
      return NoticeText.make(`${removed}: ${counts(change.folder) ? "another source still gives it, so it still counts" : "it no longer counts"} as inside the working folder.`);
    }
    default:
      return change satisfies never;
  }
};
