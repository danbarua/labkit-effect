/**
 * The router delivers each observation to the machine it is addressed to, then delivers the
 * messages machines send, in the order sent, until none are left.
 *
 * - An observation's address comes from its own fields: input, a compaction, a change of model and
 *   a turn's start go to the agent; a model's response and a turn's end review to the turn they
 *   name; a tool's end to the call it names.
 * - Only messages between machines create machines: the agent opens a turn, a turn starts its
 *   steps, a step opens its calls.
 * - Every machine has a mailbox. A message its table defers waits there, with its own position;
 *   right after each transition the machine's mailbox is tried again, in order, until nothing more
 *   is taken. A waiting message the machine's new state ignores is discarded, recording nothing.
 * - `InputCancelled` withdraws the input it names from whichever mailbox holds it; if no mailbox
 *   does, nothing changes. This is the one place the router reads more than an address.
 * - An observation addressed to a turn or call that no machine exists for is recorded as
 *   `ObservationUndelivered`. One a machine's state ignores, or that a machine passes on and the next
 *   ignores, is recorded as `ObservationNotExpected`. Any other message between machines that is
 *   ignored records nothing.
 *
 * Decisions are recorded in order at the positions after the observation (the first at `seq + 1`);
 * the caller records them there.
 */

import { type AgentMessage, type AgentState, agentTable, openingAgent } from "./agent.ts";
import { type CallMessage, type CallState, callTable, openingCall } from "./call.ts";
import {
  type ConversationTurnMessage,
  type ConversationTurnState,
  conversationTurnTable,
  openingConversationTurn,
} from "./conversation-turn.ts";
import type { Decision } from "./decision.ts";
import type { Send, StepAddress } from "./messages.ts";
import { type CallId, Seq, type StepIndex, type TurnId } from "./names.ts";
import type { Observation } from "./observation.ts";
import type { EffectRequest } from "./request.ts";
import { step, type Table, type Tagged } from "./table.ts";
import { openingTurnStep, type TurnStepMessage, type TurnStepState, turnStepTable } from "./turn-step.ts";

/** A message waiting in a mailbox, with the position of the observation it came from. */
export interface Waiting<Message> {
  readonly message: Message;
  readonly seq: Seq;
}

/** A machine: its state, and the messages waiting in its mailbox, oldest first. */
export interface Machine<State, Message> {
  readonly state: State;
  readonly mailbox: ReadonlyArray<Waiting<Message>>;
}

export interface World {
  readonly agent: Machine<AgentState, AgentMessage>;
  readonly turns: ReadonlyMap<TurnId, Machine<ConversationTurnState, ConversationTurnMessage>>;
  readonly steps: ReadonlyMap<TurnId, ReadonlyMap<StepIndex, Machine<TurnStepState, TurnStepMessage>>>;
  readonly calls: ReadonlyMap<CallId, Machine<CallState, CallMessage>>;
}

const fresh = <State, Message>(state: State): Machine<State, Message> => ({ state, mailbox: [] });

export const emptyWorld: World = { agent: fresh(openingAgent), turns: new Map(), steps: new Map(), calls: new Map() };

export interface Delivered {
  readonly world: World;
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
}

interface Outputs {
  readonly decisions: ReadonlyArray<Decision>;
  readonly requests: ReadonlyArray<EffectRequest>;
  readonly sends: ReadonlyArray<Send>;
}

const none: Outputs = { decisions: [], requests: [], sends: [] };

function joined(first: Outputs, second: Outputs): Outputs {
  return {
    decisions: [...first.decisions, ...second.decisions],
    requests: [...first.requests, ...second.requests],
    sends: [...first.sends, ...second.sends],
  };
}

/** What a machine did with a message: ignored it, deferred it, or acted on it. */
type Handled<State, Message> =
  | { readonly _tag: "Ignored" }
  | { readonly _tag: "Deferred"; readonly machine: Machine<State, Message> }
  | { readonly _tag: "Acted"; readonly machine: Machine<State, Message>; readonly outputs: Outputs };

/** Tries the mailbox again, in order, until a pass takes nothing. */
function retried<State extends Tagged, Message extends Tagged>(
  table: Table<State, Message, Send>,
  machine: Machine<State, Message>,
  outputs: Outputs,
): { readonly machine: Machine<State, Message>; readonly outputs: Outputs } {
  const pass = machine.mailbox.reduce<{
    readonly state: State;
    readonly kept: ReadonlyArray<Waiting<Message>>;
    readonly outputs: Outputs;
    readonly took: boolean;
  }>(
    (done, waiting) => {
      const next = step(table, done.state, waiting.message, { seq: waiting.seq });
      if (next === "deferred") return { ...done, kept: [...done.kept, waiting] };
      if (next === "ignored") return done;
      return { state: next.state, kept: done.kept, outputs: joined(done.outputs, next), took: true };
    },
    { state: machine.state, kept: [], outputs, took: false },
  );
  const after: Machine<State, Message> = { state: pass.state, mailbox: pass.kept };
  return pass.took ? retried(table, after, pass.outputs) : { machine: after, outputs: pass.outputs };
}

function handle<State extends Tagged, Message extends Tagged>(
  table: Table<State, Message, Send>,
  machine: Machine<State, Message>,
  waiting: Waiting<Message>,
): Handled<State, Message> {
  const next = step(table, machine.state, waiting.message, { seq: waiting.seq });
  if (next === "ignored") return { _tag: "Ignored" };
  if (next === "deferred") return { _tag: "Deferred", machine: { ...machine, mailbox: [...machine.mailbox, waiting] } };
  const done = retried(table, { state: next.state, mailbox: machine.mailbox }, joined(none, next));
  return { _tag: "Acted", machine: done.machine, outputs: done.outputs };
}

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  return new Map([...map, [key, value]]);
}

/** The world with `handled` applied through `put`, and what it produced; undefined when ignored. */
function applied<State, Message>(
  handled: Handled<State, Message>,
  put: (machine: Machine<State, Message>) => World,
): { readonly world: World; readonly outputs: Outputs } | undefined {
  switch (handled._tag) {
    case "Ignored":
      return undefined;
    case "Deferred":
      return { world: put(handled.machine), outputs: none };
    case "Acted":
      return { world: put(handled.machine), outputs: handled.outputs };
    default:
      return handled satisfies never;
  }
}

const toAgent = (world: World, message: AgentMessage, seq: Seq) =>
  applied(handle(agentTable, world.agent, { message, seq }), (agent) => ({ ...world, agent }));

const toTurn = (world: World, turn: TurnId, machine: World["turns"] extends ReadonlyMap<TurnId, infer M> ? M : never, message: ConversationTurnMessage, seq: Seq) =>
  applied(handle(conversationTurnTable, machine, { message, seq }), (next) => ({ ...world, turns: withEntry(world.turns, turn, next) }));

const toStep = (world: World, address: StepAddress, message: TurnStepMessage, seq: Seq) => {
  const ofTurn = world.steps.get(address.turn) ?? new Map<StepIndex, Machine<TurnStepState, TurnStepMessage>>();
  const machine = ofTurn.get(address.index) ?? fresh<TurnStepState, TurnStepMessage>(openingTurnStep(address));
  return applied(handle(turnStepTable, machine, { message, seq }), (next) => ({
    ...world,
    steps: withEntry(world.steps, address.turn, withEntry(ofTurn, address.index, next)),
  }));
};

const toCall = (world: World, call: CallId, machine: Machine<CallState, CallMessage>, message: CallMessage, seq: Seq) =>
  applied(handle(callTable, machine, { message, seq }), (next) => ({ ...world, calls: withEntry(world.calls, call, next) }));

/** A message between machines, delivered; a machine it names that does not exist yet is created. */
function send(world: World, sent: Send, seq: Seq) {
  switch (sent._tag) {
    case "ToAgent":
      return toAgent(world, sent.message, seq);
    case "ToConversationTurn":
      return toTurn(world, sent.turn, world.turns.get(sent.turn) ?? fresh(openingConversationTurn(sent.turn)), sent.message, seq);
    case "ToTurnStep":
      return toStep(world, sent.step, sent.message, seq);
    case "ToCall":
      return toCall(world, sent.call, world.calls.get(sent.call) ?? fresh(openingCall(sent.call)), sent.message, seq);
    default:
      return sent satisfies never;
  }
}

/** Whether the message is the observation itself, passed on by the machine it was delivered to. */
function isPassedOn(sent: Send): boolean {
  if (sent._tag !== "ToTurnStep") return false;
  switch (sent.message._tag) {
    case "ModelResponded":
    case "ModelFailed":
    case "ModelAttemptFailed":
    case "NoticeInserted":
    case "ModelRequestDispatched":
    case "SettingAdjusted":
    case "ToolCallArrived":
    case "ModelVetoed":
      return true;
    case "StepStart":
    case "CallSettled":
      return false;
    default:
      return sent.message satisfies never;
  }
}

/**
 * Delivers the messages in order, and those they lead to after them, until none are left. An
 * observation passed on and ignored is recorded as `ObservationNotExpected`, as it would be had the
 * first machine ignored it.
 */
function drain(done: Delivered, pending: ReadonlyArray<Send>, seq: Seq): Delivered {
  const [next, ...rest] = pending;
  if (next === undefined) return done;
  const result = send(done.world, next, seq);
  return result === undefined
    ? drain(
        isPassedOn(next)
          ? { ...done, decisions: [...done.decisions, { _tag: "ObservationNotExpected", observation: seq }] }
          : done,
        rest,
        seq,
      )
    : drain(
        {
          world: result.world,
          decisions: [...done.decisions, ...result.outputs.decisions],
          requests: [...done.requests, ...result.outputs.requests],
        },
        [...rest, ...result.outputs.sends],
        seq,
      );
}

/** The world with the input recorded at `input` withdrawn from every mailbox that holds it. */
function withdrawn(world: World, input: Seq): World {
  const turns = new Map(
    [...world.turns].map(([turn, machine]) => [
      turn,
      {
        ...machine,
        mailbox: machine.mailbox.filter((waiting) => !(waiting.message._tag === "Steer" && waiting.message.input === input)),
      },
    ]),
  );
  const agent = {
    ...world.agent,
    mailbox: world.agent.mailbox.filter((waiting) => !(waiting.message._tag === "InputArrived" && waiting.seq === input)),
  };
  return { ...world, agent, turns };
}

/** What follows from `observation`, recorded at `seq`. */
export function deliver(world: World, seq: Seq, observation: Observation): Delivered {
  const nothing: Delivered = { world, decisions: [], requests: [] };
  const routed = ((): ReturnType<typeof send> | "undelivered" => {
    switch (observation._tag) {
      case "SessionOpened":
      case "InputArrived":
      case "CompactionWindow":
      case "ModelChangeArrived":
      case "TurnStarted":
        return toAgent(world, observation, seq);
      case "InputCancelled":
        return { world: withdrawn(world, observation.input), outputs: none };
      case "ModelResponded":
      case "ModelFailed":
      case "ModelAttemptFailed":
      case "NoticeInserted":
      case "ModelRequestDispatched":
      case "SettingAdjusted":
      case "ToolCallArrived":
      case "ModelVetoed":
      case "TurnEndReviewed":
      case "TurnHoldsExhausted":
      case "TurnInterrupted": {
        const machine = world.turns.get(observation.turn);
        return machine === undefined ? "undelivered" : toTurn(world, observation.turn, machine, observation, seq);
      }
      case "ToolCallDispatched":
      case "ToolEnded": {
        const machine = world.calls.get(observation.call);
        return machine === undefined ? "undelivered" : toCall(world, observation.call, machine, observation, seq);
      }
      default:
        return observation satisfies never;
    }
  })();
  if (routed === "undelivered") return { ...nothing, decisions: [{ _tag: "ObservationUndelivered", observation: seq }] };
  if (routed === undefined) return { ...nothing, decisions: [{ _tag: "ObservationNotExpected", observation: seq }] };
  return drain(
    { world: routed.world, decisions: routed.outputs.decisions, requests: routed.outputs.requests },
    routed.outputs.sends,
    seq,
  );
}
