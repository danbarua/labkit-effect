/**
 * How a seam of information providers combines: an ordered list of sources, asked in order, where
 * the first that knows answers (`KnownModels`, `Settling`). A source that does not know answers
 * `undefined`, and the next is asked; the sources after the first answer are not asked.
 */

import { Effect } from "effect";

/** The first of `answers` that is not `undefined`, running each in order until one is; `undefined` when none is. */
export const firstAnswer = <A>(answers: ReadonlyArray<Effect.Effect<A | undefined>>): Effect.Effect<A | undefined> =>
  answers.reduce<Effect.Effect<A | undefined>>(
    (before, next) => Effect.filterOrElse(before, (answer): answer is A => answer !== undefined, () => next),
    Effect.undefined,
  );
