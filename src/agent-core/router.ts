/**
 * The router delivers each observation to the machine it is addressed to, then delivers the
 * messages that machine sends, in the order sent, until none are left.
 *
 * - An observation's address comes from its own fields: a model's response goes to the turn it
 *   names, a tool's end to the call it names, everything else to the session.
 * - Only messages between machines create machines: the session starts a turn, a turn opens a
 *   call.
 * - An observation addressed to a turn or call that no machine exists for is recorded as
 *   `ObservationUndelivered`. One a machine's state does not act on is recorded as
 *   `ObservationNotExpected`. A message between machines that is not acted on records nothing.
 *
 * Decisions are recorded in order at the positions after the observation (the first at `seq + 1`);
 * the caller records them there.
 */

import { type CallMessage, type CallState, callTable, openingCall } from "./call.ts";
import type { Decision } from "./decision.ts";
import type { Send } from "./messages.ts";
import { type CallId, Seq, type TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";
import type { EffectRequest } from "./request.ts";
import { openingSession, type SessionMessage, type SessionState, sessionTable } from "./session.ts";
import { type Position, type Step, step } from "./table.ts";
import { openingTurn, type TurnMessage, type TurnState, turnTable } from "./turn.ts";

export interface World {
  readonly session: SessionState;
  readonly turns: ReadonlyMap<TurnId, TurnState>;
  readonly calls: ReadonlyMap<CallId, CallState>;
}

export const emptyWorld: World = { session: openingSession, turns: new Map(), calls: new Map() };

export interface Delivered {
  readonly world: World;
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
}

/** The machine's step, applied to the world; `undefined` when the machine did not act. */
interface Applied {
  readonly world: World;
  readonly step: Step<unknown, Send>;
}

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map([...map, [key, value]]);
}

function applySession(world: World, message: SessionMessage, position: Position): Applied | undefined {
  const next = step(sessionTable, world.session, message, position);
  return next === "ignored" ? undefined : { world: { ...world, session: next.state }, step: next };
}

function applyTurn(world: World, turn: TurnId, state: TurnState, message: TurnMessage, position: Position): Applied | undefined {
  const next = step(turnTable, state, message, position);
  return next === "ignored" ? undefined : { world: { ...world, turns: withEntry(world.turns, turn, next.state) }, step: next };
}

function applyCall(world: World, call: CallId, state: CallState, message: CallMessage, position: Position): Applied | undefined {
  const next = step(callTable, state, message, position);
  return next === "ignored" ? undefined : { world: { ...world, calls: withEntry(world.calls, call, next.state) }, step: next };
}

/** A message between machines, delivered; a machine it names that does not exist yet is created. */
function send(world: World, sent: Send, position: Position): Applied | undefined {
  switch (sent._tag) {
    case "ToSession":
      return applySession(world, sent.message, position);
    case "ToTurn":
      return applyTurn(world, sent.turn, world.turns.get(sent.turn) ?? openingTurn(sent.turn), sent.message, position);
    case "ToCall":
      return applyCall(world, sent.call, world.calls.get(sent.call) ?? openingCall(sent.call), sent.message, position);
    default:
      return sent satisfies never;
  }
}

/** Delivers the messages in order, and those they lead to after them, until none are left. */
function drain(done: Delivered, pending: ReadonlyArray<Send>, seq: Seq): Delivered {
  const [next, ...rest] = pending;
  if (next === undefined) return done;
  const applied = send(done.world, next, { seq, at: Seq.make(seq + done.decisions.length) });
  return applied === undefined
    ? drain(done, rest, seq)
    : drain(
        {
          world: applied.world,
          decisions: [...done.decisions, ...applied.step.decisions],
          requests: [...done.requests, ...applied.step.requests],
        },
        [...rest, ...applied.step.sends],
        seq,
      );
}

/** The observation delivered to the machine its fields address; "undelivered" when there is none. */
function route(world: World, observation: Observation, position: Position): Applied | "undelivered" | undefined {
  switch (observation._tag) {
    case "SessionOpened":
    case "InputArrived":
    case "InputCancelled":
    case "TurnStarted":
      return applySession(world, observation, position);
    case "ModelResponded":
    case "ModelFailed":
    case "ModelVetoed": {
      const state = world.turns.get(observation.turn);
      return state === undefined ? "undelivered" : applyTurn(world, observation.turn, state, observation, position);
    }
    case "ToolEnded": {
      const state = world.calls.get(observation.call);
      return state === undefined ? "undelivered" : applyCall(world, observation.call, state, observation, position);
    }
    default:
      return observation satisfies never;
  }
}

/** What follows from `observation`, recorded at `seq`. */
export function deliver(world: World, seq: Seq, observation: Observation): Delivered {
  const applied = route(world, observation, { seq, at: seq });
  if (applied === "undelivered")
    return { world, decisions: [{ _tag: "ObservationUndelivered", observation: seq }], requests: [] };
  if (applied === undefined)
    return { world, decisions: [{ _tag: "ObservationNotExpected", observation: seq }], requests: [] };
  return drain(
    { world: applied.world, decisions: applied.step.decisions, requests: applied.step.requests },
    applied.step.sends,
    seq,
  );
}
