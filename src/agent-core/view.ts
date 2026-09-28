/**
 * The conversation view: what a person reading the session sees. It is a function of the facts,
 * built one fact at a time, so a live display and a display built after reloading the journal
 * apply the same function to the same facts.
 */

import type { Authority } from "./decision.ts";
import type { Fact, Journal } from "./fact.ts";
import type { CallId, FailureText, InputText, Seq, TurnId } from "./names.ts";
import type { InputSource, ModelPart, ToolOutcome } from "./observation.ts";

/**
 * Where an input is: waiting for a turn, given to one, cancelled by its sender, or dropped because
 * the turn it waited for failed.
 */
export type InputStatus =
  | { readonly _tag: "Queued" }
  | { readonly _tag: "Given"; readonly turn: TurnId }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Dropped"; readonly turn: TurnId };

export type Entry =
  | {
      readonly _tag: "Input";
      readonly seq: Seq;
      readonly from: InputSource;
      readonly text: InputText;
      readonly status: InputStatus;
    }
  | { readonly _tag: "ModelResponse"; readonly turn: TurnId; readonly parts: ReadonlyArray<ModelPart> }
  | { readonly _tag: "ModelFailure"; readonly turn: TurnId; readonly failure: FailureText }
  | { readonly _tag: "ToolRefused"; readonly call: CallId; readonly by: Authority }
  | { readonly _tag: "ToolResult"; readonly call: CallId; readonly outcome: ToolOutcome }
  | { readonly _tag: "TurnEnded"; readonly turn: TurnId; readonly ended: "answered" | "failed" }
  | { readonly _tag: "NotExpected"; readonly observation: Seq };

export type Conversation = ReadonlyArray<Entry>;

function setStatus(view: Conversation, inputs: ReadonlyArray<Seq>, status: InputStatus): Conversation {
  return view.map((entry) =>
    entry._tag === "Input" && inputs.includes(entry.seq) ? { ...entry, status } : entry,
  );
}

/** The view after one more fact. */
export function viewFact(view: Conversation, fact: Fact): Conversation {
  switch (fact._tag) {
    case "Observed": {
      const observation = fact.observation;
      switch (observation._tag) {
        case "SessionOpened":
        case "PermissionAnswered":
          return view;
        case "InputArrived":
          return [
            ...view,
            {
              _tag: "Input",
              seq: fact.seq,
              from: observation.from,
              text: observation.text,
              status: { _tag: "Queued" },
            },
          ];
        case "InputCancelled":
          return setStatus(view, [observation.input], { _tag: "Cancelled" });
        case "ModelResponded":
          return [...view, { _tag: "ModelResponse", turn: observation.turn, parts: observation.parts }];
        case "ModelFailed":
          return [...view, { _tag: "ModelFailure", turn: observation.turn, failure: observation.failure }];
        case "ToolEnded":
          return [...view, { _tag: "ToolResult", call: observation.call, outcome: observation.outcome }];
        default:
          return observation satisfies never;
      }
    }
    case "Decided": {
      const decision = fact.decision;
      switch (decision._tag) {
        case "TurnStarted":
        case "InputDelivered":
          return setStatus(view, decision.inputs, { _tag: "Given", turn: decision.turn });
        case "InputDropped":
          return setStatus(view, decision.inputs, { _tag: "Dropped", turn: decision.turn });
        case "ToolCallRefused":
          return [...view, { _tag: "ToolRefused", call: decision.call, by: decision.by }];
        case "TurnAnswered":
          return [...view, { _tag: "TurnEnded", turn: decision.turn, ended: "answered" }];
        case "TurnFailed":
          return [...view, { _tag: "TurnEnded", turn: decision.turn, ended: "failed" }];
        case "ObservationNotExpected":
          return [...view, { _tag: "NotExpected", observation: decision.observation }];
        case "ModelAsked":
        case "ToolCallAllowed":
          return view;
        default:
          return decision satisfies never;
      }
    }
    default:
      return fact satisfies never;
  }
}

export function conversation(journal: Journal): Conversation {
  return journal.reduce(viewFact, []);
}
