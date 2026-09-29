/**
 * The agent: the parent of conversation turns. Input that arrives while no turn is running waits in
 * the agent's mailbox. When a turn starts (the layers around the core decide when, and report
 * `TurnStarted`), the agent opens it and passes it each waiting input; input that arrives while a
 * turn runs is passed to that turn. A compaction or a change of model is taken at once while no turn
 * runs, and passed to the running turn otherwise.
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
