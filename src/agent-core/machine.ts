/**
 * The session machine. `decide` takes an observation just recorded and returns the decisions and
 * effect requests that follow from it; `fold` rebuilds the state from recorded facts. Both apply
 * facts through the same two functions, `observe` and `apply`, so the state after `decide` and the
 * state after folding the same facts are the same.
 *
 * The core decides when a turn starts and with which inputs; an adapter starts it and reports
 * `TurnStarted`. Input can arrive at any time. Input that arrives while a turn is starting or under
 * way is queued, and is given to the turn at the next point between steps: when every call of a
 * tool batch has settled, or when the model gives a final answer. A turn ends only on a final
 * answer with no input queued. A turn that ends any other way drops its queued input.
 *
 * Every tool call the model proposes is requested. Whether it runs is for the layers around the
 * core: a policy there lets it continue, vetoes it, or delays it, and the core sees the outcome.
 */

import type { Decision, Ending } from "./decision.ts";
import type { Fact } from "./fact.ts";
import { type CallId, type Inputs, Seq, type ToolName, type TurnId } from "./names.ts";
import type { ModelPart, Observation, ToolOutcome } from "./observation.ts";
import type { EffectRequest } from "./request.ts";

type ToolInput = Extract<ModelPart, { _tag: "ToolCall" }>["input"];

export interface Call {
  readonly tool: ToolName;
  readonly input: ToolInput;
  /** Undefined until the call ends. */
  readonly outcome: ToolOutcome | undefined;
}

/**
 * Where a turn is: waiting for the model; running a tool batch; or holding a final answer, for
 * the moment between recording the answer and deciding what follows it.
 */
export type Stage = "model" | "tools" | "final";

/** What the session is doing. */
export type Activity =
  | { readonly _tag: "Idle" }
  /** A turn was requested with `inputs`; its start has not been reported. */
  | { readonly _tag: "Starting"; readonly inputs: Inputs }
  | {
      readonly _tag: "InTurn";
      readonly turn: TurnId;
      readonly stage: Stage;
      readonly calls: ReadonlyMap<CallId, Call>;
    };

type InTurn = Extract<Activity, { _tag: "InTurn" }>;

export type State =
  | { readonly _tag: "NotOpened" }
  | {
      readonly _tag: "Open";
      /** Inputs not yet given to a turn, oldest first. */
      readonly queued: ReadonlyArray<Seq>;
      readonly activity: Activity;
    };

type Open = Extract<State, { _tag: "Open" }>;

export const initial: State = { _tag: "NotOpened" };

const idle: Activity = { _tag: "Idle" };

export interface Outcome {
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
}

function inTurn(state: State): InTurn | undefined {
  return state._tag === "Open" && state.activity._tag === "InTurn" ? state.activity : undefined;
}

function sameInputs(a: ReadonlyArray<Seq>, b: ReadonlyArray<Seq>): boolean {
  return a.length === b.length && a.every((input, index) => input === b[index]);
}

/** Whether `state` expects `observation`. An observation it does not expect changes nothing. */
export function expects(state: State, observation: Observation): boolean {
  if (state._tag === "NotOpened") return observation._tag === "SessionOpened";
  const turn = inTurn(state);
  switch (observation._tag) {
    case "SessionOpened":
      return false;
    case "InputArrived":
      return true;
    case "TurnStarted":
      return (
        state.activity._tag === "Starting" && sameInputs(state.activity.inputs, observation.inputs)
      );
    case "InputCancelled":
      return state.queued.includes(observation.input);
    case "ModelResponded":
    case "ModelFailed":
    case "ModelVetoed":
      return turn?.stage === "model" && turn.turn === observation.turn;
    case "ToolEnded": {
      const call = turn?.stage === "tools" ? turn.calls.get(observation.call) : undefined;
      return call !== undefined && call.outcome === undefined;
    }
    default:
      return observation satisfies never;
  }
}

function withTurn(state: State, change: (turn: InTurn) => InTurn): State {
  const turn = inTurn(state);
  return state._tag === "Open" && turn !== undefined ? { ...state, activity: change(turn) } : state;
}

function withCall(state: State, id: CallId, change: (call: Call) => Call): State {
  return withTurn(state, (turn) => {
    const call = turn.calls.get(id);
    if (call === undefined) return turn;
    const calls = new Map(turn.calls);
    calls.set(id, change(call));
    return { ...turn, calls };
  });
}

function without(queued: ReadonlyArray<Seq>, removed: ReadonlyArray<Seq>): ReadonlyArray<Seq> {
  return queued.filter((input) => !removed.includes(input));
}

/** The state after recording an observation `state` expects. */
function observe(state: State, seq: Seq, observation: Observation): State {
  if (observation._tag === "SessionOpened")
    return { _tag: "Open", queued: [], activity: idle };
  if (state._tag === "NotOpened") return state;
  switch (observation._tag) {
    case "InputArrived":
      return { ...state, queued: [...state.queued, seq] };
    case "TurnStarted":
      return {
        ...state,
        activity: { _tag: "InTurn", turn: observation.turn, stage: "model", calls: new Map() },
      };
    case "InputCancelled":
      return { ...state, queued: state.queued.filter((input) => input !== observation.input) };
    case "ModelResponded":
      return withTurn(state, (turn) => {
        const calls = new Map<CallId, Call>();
        for (const part of observation.parts)
          if (part._tag === "ToolCall")
            calls.set(part.call, { tool: part.tool, input: part.input, outcome: undefined });
        return { ...turn, stage: calls.size > 0 ? "tools" : "final", calls };
      });
    case "ModelFailed":
    case "ModelVetoed":
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
    case "TurnRequested":
      return {
        ...state,
        queued: without(state.queued, decision.inputs),
        activity: { _tag: "Starting", inputs: decision.inputs },
      };
    case "InputDelivered":
    case "InputDropped":
      return { ...state, queued: without(state.queued, decision.inputs) };
    case "ModelAsked":
      return withTurn(state, (turn) => ({ ...turn, stage: "model", calls: new Map() }));
    case "TurnEnded":
      return { ...state, activity: idle };
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

/** The state the facts describe, in order. */
export function stateOf(facts: ReadonlyArray<Fact>): State {
  return facts.reduce(fold, initial);
}

function isInputs(queued: ReadonlyArray<Seq>): queued is Inputs {
  return queued.length > 0;
}

/**
 * What follows from `observation`, recorded at `seq`, arriving in `state`. The caller records the
 * decisions in order at the positions after the observation (the first at `seq + 1`), then carries
 * out the requests. `ModelAsked.through` names a position on that assumption.
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
    record({ _tag: "ModelAsked", turn, through: Seq.make(seq + decisions.length) });
    requests.push({ _tag: "RequestModelResponse", turn });
  };
  /** At a point between steps: give the turn its queued input, then ask the model. */
  const nextStep = (turn: TurnId): void => {
    const queued = open()?.queued ?? [];
    if (isInputs(queued)) record({ _tag: "InputDelivered", turn, inputs: queued });
    askModel(turn);
  };
  /** The turn ends other than by an answer, dropping the input queued for it. */
  const endWithout = (turn: TurnId, ending: Ending): void => {
    const queued = open()?.queued ?? [];
    if (isInputs(queued)) record({ _tag: "InputDropped", turn, inputs: queued });
    record({ _tag: "TurnEnded", turn, ending });
  };
  /** When every call of the batch has settled, the turn moves to its next step. */
  const afterCallSettled = (): void => {
    const turn = inTurn(current);
    if (turn === undefined) return;
    const settled = [...turn.calls.values()].every((call) => call.outcome !== undefined);
    if (settled) nextStep(turn.turn);
  };

  switch (observation._tag) {
    case "SessionOpened":
    case "InputCancelled":
      break;
    case "InputArrived": {
      const now = open();
      if (now?.activity._tag === "Idle" && isInputs(now.queued)) {
        record({ _tag: "TurnRequested", inputs: now.queued });
        requests.push({ _tag: "StartTurn", inputs: now.queued });
      }
      break;
    }
    case "TurnStarted":
      askModel(observation.turn);
      break;
    case "ModelResponded": {
      const now = open();
      const turn = inTurn(current);
      if (now === undefined || turn === undefined) break;
      if (turn.stage === "final") {
        if (isInputs(now.queued)) nextStep(turn.turn);
        else record({ _tag: "TurnEnded", turn: turn.turn, ending: { _tag: "Answered" } });
        break;
      }
      for (const [call, known] of turn.calls)
        requests.push({ _tag: "RunTool", call, tool: known.tool, input: known.input });
      break;
    }
    case "ModelFailed":
      endWithout(observation.turn, { _tag: "Failed", failure: observation.failure });
      break;
    case "ModelVetoed":
      endWithout(observation.turn, { _tag: "Vetoed", reason: observation.reason });
      break;
    case "ToolEnded":
      afterCallSettled();
      break;
    default:
      observation satisfies never;
  }
  return { decisions, requests };
}
