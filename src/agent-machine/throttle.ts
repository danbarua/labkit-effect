/**
 * A machine that holds captured observations and releases them in batches, at most once per
 * interval: for display updates, and for tests that need a deterministic stream. Time is an input,
 * so the machine reads no clock.
 */

import type { Millis } from "./names.ts";

export interface Held<Item> {
  readonly items: ReadonlyArray<Item>;
  /** When the last batch was released; undefined before the first. */
  readonly released: Millis | undefined;
}

export type ThrottleInput<Item> =
  /** An item was captured at `at`. */
  | { readonly _tag: "Captured"; readonly item: Item; readonly at: Millis }
  /** The clock reached `at`. */
  | { readonly _tag: "Tick"; readonly at: Millis }
  /** The stream ended: release everything held. */
  | { readonly _tag: "Ended"; readonly at: Millis };

export interface ThrottleStep<Item> {
  readonly held: Held<Item>;
  /** The batch released by this step, oldest first; empty when nothing was released. */
  readonly batch: ReadonlyArray<Item>;
}

export function emptyHeld<Item>(): Held<Item> {
  return { items: [], released: undefined };
}

export function throttle<Item>(
  interval: Millis,
  held: Held<Item>,
  input: ThrottleInput<Item>,
): ThrottleStep<Item> {
  const items = input._tag === "Captured" ? [...held.items, input.item] : held.items;
  const due = held.released === undefined || input.at - held.released >= interval;
  const release = items.length > 0 && (input._tag === "Ended" || due);
  switch (input._tag) {
    case "Captured":
    case "Tick":
    case "Ended":
      return release
        ? { held: { items: [], released: input.at }, batch: items }
        : { held: { ...held, items }, batch: [] };
    default:
      return input satisfies never;
  }
}
