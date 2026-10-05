/**
 * How a seam of information providers combines (`KnownModels`, `Settling`): the sources are asked in
 * order, and the first that knows answers. A source that does not know returns `undefined`, and the
 * next source is asked. The sources after the first answer are not asked.
 */

import { Effect } from "effect";

/** Runs `answers` in order until one returns a value other than `undefined`, and returns that value; `undefined` when none does. */
export const firstAnswer = <A>(answers: ReadonlyArray<Effect.Effect<A | undefined>>): Effect.Effect<A | undefined> =>
  answers.reduce<Effect.Effect<A | undefined>>(
    (before, next) => Effect.filterOrElse(before, (answer): answer is A => answer !== undefined, () => next),
    Effect.undefined,
  );
