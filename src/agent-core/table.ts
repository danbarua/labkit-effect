/**
 * A machine is a table: for each state kind and each message kind, the transition to take,
 * "ignored", or "deferred". Whether a message is acted on is decided by the two kinds alone. A
 * deferred message waits in the machine's mailbox and is tried again after the machine's next
 * transition. The table's type requires an entry for every pair, so a new state or message kind
 * does not compile until every pair is answered.
 */

import type { Decision } from "./decision.ts";
import type { Seq } from "./names.ts";
import type { EffectRequest } from "./request.ts";

export interface Tagged {
  readonly _tag: PropertyKey;
}

/** Where a transition happens: the message's own position, and the last fact recorded. */
export interface Position {
  /** The position of the observation the message came from; a deferred message keeps its own. */
  readonly seq: Seq;
  /** The last fact recorded so far; a decision this transition records goes after it. */
  readonly at: Seq;
}

/** What a transition produces: the machine's next state, what it records and requests, what it sends. */
export interface Step<State, Send> {
  readonly state: State;
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
  readonly sends: ReadonlyArray<Send>;
}

export type Transition<State, Message, Next, Send> = (
  state: State,
  message: Message,
  position: Position,
) => Step<Next, Send>;

export type Table<State extends Tagged, Message extends Tagged, Send> = {
  readonly [S in State["_tag"]]: {
    readonly [M in Message["_tag"]]:
      | "ignored"
      | "deferred"
      | Transition<Extract<State, { _tag: S }>, Extract<Message, { _tag: M }>, State, Send>;
  };
};

/** The machine's step for `message` in `state`, or "ignored", or "deferred". */
export function step<State extends Tagged, Message extends Tagged, Send>(
  table: Table<State, Message, Send>,
  state: State,
  message: Message,
  position: Position,
): Step<State, Send> | "ignored" | "deferred" {
  const entry = table[state._tag as State["_tag"]][message._tag as Message["_tag"]];
  return entry === "ignored" || entry === "deferred"
    ? entry
    : (entry as Transition<State, Message, State, Send>)(state, message, position);
}

/** A step that changes the state and nothing else. */
export function becomes<State, Send>(state: State): Step<State, Send> {
  return { state, decisions: [], requests: [], sends: [] };
}
