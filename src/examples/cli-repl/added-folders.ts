/**
 * The folders added to a CLI session while it runs (`/add-dir`): they count as inside the working
 * folder from the next tool call on, as `--add-dir`'s do. The permission policy reads them at each
 * call (`FromHost.additionalFolders`), and the model is told once of each, as a notice on its next
 * request.
 */

import { Effect, Ref } from "effect";
import type { NoticeProvider } from "../../agent-context/assemble.ts";

export interface AddedFolders {
  /** The folders added, absolute, in the order they were added. */
  readonly list: Effect.Effect<ReadonlyArray<string>>;
  /** Adds `folder` (absolute); false when it was added already. */
  readonly add: (folder: string) => Effect.Effect<boolean>;
  /** Tells the model of each folder added since its last request. */
  readonly notices: NoticeProvider;
}

/** Returns the folders added to a session, none yet. */
export const makeAddedFolders: Effect.Effect<AddedFolders> = Effect.gen(function* () {
  const added = yield* Ref.make<ReadonlyArray<string>>([]);
  const told = yield* Ref.make<number>(0);
  return {
    list: Ref.get(added),
    add: (folder) => Ref.modify(added, (all) => (all.includes(folder) ? [false, all] : [true, [...all, folder]])),
    notices: {
      notices: Effect.gen(function* () {
        const all = yield* Ref.get(added);
        const before = yield* Ref.getAndSet(told, all.length);
        return all.slice(before).map((folder) => `The user added the folder ${folder}: it counts as inside the working folder, so you may read and change files there.`);
      }),
    },
  };
});
