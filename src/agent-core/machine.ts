/**
 * The session machine. `decide` takes an observation just recorded and returns the decisions and
 * effect requests that follow from it; `fold` rebuilds the state from recorded facts. Both apply
 * facts through the same two functions, `observe` and `apply`, so the state after `decide` and the
 * state after folding the same facts are the same.
 *
 * Input can arrive at any time. Input that arrives during a turn is queued, and is given to the
 * turn at the next point between steps: when every call of a tool batch has settled, or when the
 * model gives a final answer. A turn ends only on a final answer with no input queued.
 */

import type { Decision, Inputs } from "./decision.ts";
import type { Fact, Journal } from "./fact.ts";
import { type CallId, type Seq, type ToolName, TurnCount, TurnId } from "./names.ts";
import type { Configuration, ModelPart, Observation, ToolOutcome } from "./observation.ts";
import type { EffectRequest } from "./request.ts";

type ToolInput = Extract<ModelPart, { _tag: "ToolCall" }>["input"];

/** Whether a call may run: not yet decided, allowed, or refused. */
export type Permission = "undecided" | "allowed" | "refused";

export interface Call {
  readonly tool: ToolName;
  readonly input: ToolInput;
  readonly permission: Permission;
  readonly outcome: ToolOutcome | undefined;
}

/**
 * Where a turn is: waiting for the model; running a tool batch; or holding a final answer, for
 * the moment between recording the answer and deciding what follows it.
 */
export type Stage = "model" | "tools" | "final";

export interface Turn {
  readonly id: TurnId;
  readonly stage: Stage;
  readonly calls: ReadonlyMap<CallId, Call>;
}

export type State =
  | { readonly _tag: "NotOpened" }
  | {
      readonly _tag: "Open";
      readonly configuration: Configuration;
      readonly turns: TurnCount;
      /** Inputs not yet given to a turn, oldest first. */
      readonly queued: ReadonlyArray<Seq>;
      readonly turn: Turn | undefined;
    };

type Open = Extract<State, { _tag: "Open" }>;

export const initial: State = { _tag: "NotOpened" };

export interface Outcome {
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
}

/** Whether `state` expects `observation`. An observation it does not expect changes nothing. */
export function expects(state: State, observation: Observation): boolean {
  if (state._tag === "NotOpened") return observation._tag === "SessionOpened";
  const turn = state.turn;
  switch (observation._tag) {
    case "SessionOpened":
      return false;
    case "InputArrived":
      return true;
    case "InputCancelled":
      return state.queued.includes(observation.input);
    case "ModelResponded":
    case "ModelFailed":
      return turn !== undefined && turn.stage === "model" && turn.id === observation.turn;
    case "PermissionAnswered":
      return turn?.stage === "tools" && turn.calls.get(observation.call)?.permission === "undecided";
    case "ToolEnded": {
      const call = turn?.stage === "tools" ? turn.calls.get(observation.call) : undefined;
      return call?.permission === "allowed" && call.outcome === undefined;
    }
    default:
      return observation satisfies never;
  }
}

/** The state after recording an observation `state` expects. */
function observe(state: State, seq: Seq, observation: Observation): State {
  if (observation._tag === "SessionOpened")
    return {
      _tag: "Open",
      configuration: observation.configuration,
      turns: TurnCount.make(0),
      queued: [],
      turn: undefined,
    };
  if (state._tag === "NotOpened") return state;
  switch (observation._tag) {
    case "InputArrived":
      return { ...state, queued: [...state.queued, seq] };
    case "InputCancelled":
      return { ...state, queued: state.queued.filter((input) => input !== observation.input) };
    case "ModelResponded": {
      if (state.turn === undefined) return state;
      const calls = new Map<CallId, Call>();
      for (const part of observation.parts)
        if (part._tag === "ToolCall")
          calls.set(part.call, {
            tool: part.tool,
            input: part.input,
            permission: "undecided",
            outcome: undefined,
          });
      return { ...state, turn: { ...state.turn, stage: calls.size > 0 ? "tools" : "final", calls } };
    }
    case "ModelFailed":
    case "PermissionAnswered":
      return state;
    case "ToolEnded":
      return withCall(state, observation.call, (call) => ({ ...call, outcome: observation.outcome }));
    default:
      return observation satisfies never;
  }
}

/** The state after recording a decision. A decision is taken as written. */
function apply(state: State, decision: Decision): State {
  if (state._tag === "NotOpened") return state;
  switch (decision._tag) {
    case "TurnStarted":
      return {
        ...state,
        turns: TurnCount.make(state.turns + 1),
        queued: without(state.queued, decision.inputs),
        turn: { id: decision.turn, stage: "model", calls: new Map() },
      };
    case "InputDelivered":
      return { ...state, queued: without(state.queued, decision.inputs) };
    case "ModelAsked":
      return state.turn === undefined
        ? state
        : { ...state, turn: { ...state.turn, stage: "model", calls: new Map() } };
    case "ToolCallAllowed":
      return withCall(state, decision.call, (call) => ({ ...call, permission: "allowed" }));
    case "ToolCallRefused":
      return withCall(state, decision.call, (call) => ({ ...call, permission: "refused" }));
    case "TurnAnswered":
    case "TurnFailed":
      return { ...state, turn: undefined };
    case "ObservationNotExpected":
      return state;
    default:
      return decision satisfies never;
  }
}

/** The state after one recorded fact. */
export function fold(state: State, fact: Fact): State {
  switch (fact._tag) {
    case "Observed":
      return expects(state, fact.observation) ? observe(state, fact.seq, fact.observation) : state;
    case "Decided":
      return apply(state, fact.decision);
    default:
      return fact satisfies never;
  }
}

/** The state a journal describes. */
export function replay(journal: Journal): State {
  return journal.reduce(fold, initial);
}

/**
 * What follows from `observation`, recorded at `seq`, arriving in `state`. The caller records the
 * decisions in order after the observation, then carries out the requests.
 */
export function decide(state: State, seq: Seq, observation: Observation): Outcome {
  if (!expects(state, observation))
    return { decisions: [{ _tag: "ObservationNotExpected", observation: seq }], requests: [] };

  let current = observe(state, seq, observation);
  const decisions: Array<Decision> = [];
  const requests: Array<EffectRequest> = [];
  const record = (decision: Decision): void => {
    decisions.push(decision);
    current = apply(current, decision);
  };
  const open = (): Open | undefined => (current._tag === "Open" ? current : undefined);

  const askModel = (turn: TurnId): void => {
    record({ _tag: "ModelAsked", turn });
    requests.push({ _tag: "RequestModelResponse", turn });
  };
  /** At a point between steps: give the turn its queued input, then ask the model. */
  const nextStep = (turn: TurnId): void => {
    const queued = open()?.queued ?? [];
    if (isInputs(queued)) record({ _tag: "InputDelivered", turn, inputs: queued });
    askModel(turn);
  };
  const allow = (call: CallId, by: "configuration" | "user"): void => {
    const known = open()?.turn?.calls.get(call);
    record({ _tag: "ToolCallAllowed", call, by });
    if (known !== undefined) requests.push({ _tag: "RunTool", call, tool: known.tool, input: known.input });
  };
  /** When every call of the batch has settled, the turn moves to its next step. */
  const afterCallSettled = (): void => {
    const turn = open()?.turn;
    if (turn === undefined) return;
    const settled = [...turn.calls.values()].every(
      (call) => call.permission === "refused" || call.outcome !== undefined,
    );
    if (settled) nextStep(turn.id);
  };

  switch (observation._tag) {
    case "SessionOpened":
    case "InputCancelled":
      break;
    case "InputArrived": {
      const now = open();
      if (now !== undefined && now.turn === undefined && isInputs(now.queued)) {
        const turn = TurnId.make(`turn-${now.turns + 1}`);
        record({ _tag: "TurnStarted", turn, inputs: now.queued });
        askModel(turn);
      }
      break;
    }
    case "ModelResponded": {
      const now = open();
      const turn = now?.turn;
      if (now === undefined || turn === undefined) break;
      if (turn.stage === "final") {
        if (isInputs(now.queued)) nextStep(turn.id);
        else record({ _tag: "TurnAnswered", turn: turn.id });
        break;
      }
      for (const [call, known] of turn.calls) {
        switch (now.configuration.permission) {
          case "allow":
            allow(call, "configuration");
            break;
          case "ask":
            requests.push({ _tag: "AskPermission", call, tool: known.tool, input: known.input });
            break;
          default:
            now.configuration.permission satisfies never;
        }
      }
      break;
    }
    case "ModelFailed":
      record({ _tag: "TurnFailed", turn: observation.turn, failure: observation.failure });
      break;
    case "PermissionAnswered":
      switch (observation.answer) {
        case "allow":
          allow(observation.call, "user");
          break;
        case "refuse":
          record({ _tag: "ToolCallRefused", call: observation.call, by: "user" });
          afterCallSettled();
          break;
        default:
          observation.answer satisfies never;
      }
      break;
    case "ToolEnded":
      afterCallSettled();
      break;
    default:
      observation satisfies never;
  }
  return { decisions, requests };
}

function isInputs(queued: ReadonlyArray<Seq>): queued is Inputs {
  return queued.length > 0;
}

function without(queued: ReadonlyArray<Seq>, removed: ReadonlyArray<Seq>): ReadonlyArray<Seq> {
  return queued.filter((input) => !removed.includes(input));
}

function withCall(state: State, id: CallId, change: (call: Call) => Call): State {
  if (state._tag === "NotOpened" || state.turn === undefined) return state;
  const call = state.turn.calls.get(id);
  if (call === undefined) return state;
  const calls = new Map(state.turn.calls);
  calls.set(id, change(call));
  return { ...state, turn: { ...state.turn, calls } };
}
