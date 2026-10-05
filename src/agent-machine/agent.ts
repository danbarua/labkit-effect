/**
 * The agent: the parent of conversation turns.
 *
 * - Input that arrives while no turn runs waits in the agent's mailbox.
 * - The layers around the core decide when a turn starts, and report `TurnStarted`. The agent then
 *   opens the turn and passes it each waiting input.
 * - Input that arrives while a turn runs is passed to that turn.
 * - The agent takes a compaction window or a change of model at once while no turn runs, and
 *   passes it to the running turn otherwise.
 */

import { type AgentObservation, type Send, type ToAgent, toConversationTurn } from "./messages.ts";
import type { TurnId } from "./names.ts";
import { becomes, type Table } from "./table.ts";

export type AgentState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly turn: TurnId };

export type AgentMessage = AgentObservation | ToAgent;

export const openingAgent: AgentState = { _tag: "Idle" };

export const agentTable: Table<AgentState, AgentMessage, Send> = {
  Idle: {
    SessionOpened: (state) => becomes(state),
    InputArrived: "deferred",
    CompactionWindow: (state, _message, { seq }) => ({
      ...becomes(state),
      decisions: [{ _tag: "WindowOpened", compaction: seq }],
    }),
    ModelChangeArrived: (state, _message, { seq }) => ({
      ...becomes(state),
      decisions: [{ _tag: "ModelChangeTaken", change: seq }],
    }),
    TurnStarted: (_state, message) => ({
      ...becomes({ _tag: "Running", turn: message.turn }),
      sends: [toConversationTurn(message.turn, { _tag: "TurnOpened" })],
    }),
    TurnFinished: "ignored",
  },
  Running: {
    SessionOpened: "ignored",
    InputArrived: (state, _message, { seq }) => ({
      ...becomes(state),
      sends: [toConversationTurn(state.turn, { _tag: "Steer", input: seq })],
    }),
    CompactionWindow: (state, _message, { seq }) => ({
      ...becomes(state),
      sends: [toConversationTurn(state.turn, { _tag: "Compact", compaction: seq })],
    }),
    ModelChangeArrived: (state, _message, { seq }) => ({
      ...becomes(state),
      sends: [toConversationTurn(state.turn, { _tag: "ChangeModel", change: seq })],
    }),
    TurnStarted: "ignored",
    TurnFinished: () => becomes({ _tag: "Idle" }),
  },
};
