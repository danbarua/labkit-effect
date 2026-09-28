/**
 * The conversation view: what a person reading the session sees, including how much of it the
 * model has seen. It is a function of the facts, built one fact at a time, so a live display and a
 * display built after reloading the journal apply the same function to the same facts.
 *
 * The model has seen a fact once it has responded to a request that contained it, the way the
 * harness has observed a tool once the tool's result arrives. A request that fails leaves what it
 * carried unseen.
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

/** Every entry carries the position of the fact it shows. */
export type Entry =
  | {
      readonly _tag: "Input";
      readonly seq: Seq;
      readonly from: InputSource;
      readonly text: InputText;
      readonly status: InputStatus;
    }
  | {
      readonly _tag: "ModelResponse";
      readonly seq: Seq;
      readonly turn: TurnId;
      readonly parts: ReadonlyArray<ModelPart>;
    }
  | { readonly _tag: "ModelFailure"; readonly seq: Seq; readonly turn: TurnId; readonly failure: FailureText }
  | { readonly _tag: "ToolRefused"; readonly seq: Seq; readonly call: CallId; readonly by: Authority }
  | { readonly _tag: "ToolResult"; readonly seq: Seq; readonly call: CallId; readonly outcome: ToolOutcome }
  | { readonly _tag: "TurnEnded"; readonly seq: Seq; readonly turn: TurnId; readonly ended: "answered" | "failed" }
  | { readonly _tag: "NotExpected"; readonly seq: Seq; readonly observation: Seq };

export interface Conversation {
  readonly entries: ReadonlyArray<Entry>;
  /** The model has seen every fact through this position; undefined before its first response. */
  readonly seenThrough: Seq | undefined;
  /** How far the request in flight goes; undefined when no request is in flight. */
  readonly sentThrough: Seq | undefined;
}

export const emptyConversation: Conversation = {
  entries: [],
  seenThrough: undefined,
  sentThrough: undefined,
};

function setStatus(view: Conversation, inputs: ReadonlyArray<Seq>, status: InputStatus): Conversation {
  return {
    ...view,
    entries: view.entries.map((entry) =>
      entry._tag === "Input" && inputs.includes(entry.seq) ? { ...entry, status } : entry,
    ),
  };
}

function add(view: Conversation, entry: Entry): Conversation {
  return { ...view, entries: [...view.entries, entry] };
}

/** The view after one more fact. */
export function viewFact(view: Conversation, fact: Fact): Conversation {
  const seq = fact.seq;
  switch (fact._tag) {
    case "Observed": {
      const observation = fact.observation;
      switch (observation._tag) {
        case "SessionOpened":
        case "PermissionAnswered":
          return view;
        case "InputArrived":
          return add(view, {
            _tag: "Input",
            seq,
            from: observation.from,
            text: observation.text,
            status: { _tag: "Queued" },
          });
        case "InputCancelled":
          return setStatus(view, [observation.input], { _tag: "Cancelled" });
        case "ModelResponded":
          return add(
            { ...view, seenThrough: view.sentThrough ?? view.seenThrough, sentThrough: undefined },
            { _tag: "ModelResponse", seq, turn: observation.turn, parts: observation.parts },
          );
        case "ModelFailed":
          return add(
            { ...view, sentThrough: undefined },
            { _tag: "ModelFailure", seq, turn: observation.turn, failure: observation.failure },
          );
        case "ToolEnded":
          return add(view, { _tag: "ToolResult", seq, call: observation.call, outcome: observation.outcome });
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
        case "ModelAsked":
          return { ...view, sentThrough: decision.through };
        case "ToolCallRefused":
          return add(view, { _tag: "ToolRefused", seq, call: decision.call, by: decision.by });
        case "TurnAnswered":
          return add(view, { _tag: "TurnEnded", seq, turn: decision.turn, ended: "answered" });
        case "TurnFailed":
          return add(view, { _tag: "TurnEnded", seq, turn: decision.turn, ended: "failed" });
        case "ObservationNotExpected":
          return add(view, { _tag: "NotExpected", seq, observation: decision.observation });
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
  return journal.reduce(viewFact, emptyConversation);
}

/**
 * What the model is shown and has not seen: inputs given to a turn, tool results and refusals that
 * no request it responded to contained. Its own responses are not in this list.
 */
export function unseen(view: Conversation): ReadonlyArray<Entry> {
  const seen = view.seenThrough;
  return view.entries.filter((entry) => {
    const shown =
      (entry._tag === "Input" && entry.status._tag === "Given") ||
      entry._tag === "ToolResult" ||
      entry._tag === "ToolRefused";
    return shown && (seen === undefined || entry.seq > seen);
  });
}
