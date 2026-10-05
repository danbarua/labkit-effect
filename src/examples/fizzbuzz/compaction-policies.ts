/**
 * When to compact a FizzBuzz session, asked between turns.
 *
 * - `whenCountReaches` compacts after the turn in which the count reaches a key (the model's reply
 *   to the user's number), with that key's summarizer: a user asking for each compaction.
 * - `afterFizzBuzz` compacts after every turn in which the model classified a number as FizzBuzz,
 *   with the summarizer `chosen` gives for the session's n-th compaction (0 for the first).
 */

import type { CompactionPolicy, Summarizer } from "../../agent-context/compaction.ts";
import { Array as Arr, Option } from "effect";
import type { Fact } from "../../agent-machine/fact.ts";
import { PolicyName } from "../../agent-machine/names.ts";
import { parseJson } from "../../agent-session/received.ts";
import { isObject } from "../../agent-session/shaping.ts";

/** The position of the last fact that `is`, or -1. */
function lastAt(facts: ReadonlyArray<Fact>, is: (fact: Fact, at: number) => boolean): number {
  return Option.getOrElse(Arr.findLastIndex(facts, is), () => -1);
}

/** The facts of the last turn that ended: from its start to its end. */
function lastTurn(facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> {
  const ended = lastAt(facts, (fact) => fact._tag === "Decided" && fact.decision._tag === "TurnEnded");
  const started = lastAt(facts, (fact, at) => at < ended && fact._tag === "Observed" && fact.observation._tag === "TurnStarted");
  return ended === -1 ? [] : facts.slice(started, ended + 1);
}

export const whenCountReaches = (summarizers: ReadonlyMap<number, Summarizer>): CompactionPolicy => ({
  name: PolicyName.make(`when the count reaches ${[...summarizers.keys()].join(", ")}`),
  decide: (facts) => {
    // Between turns, the last input is the one the last turn was given.
    const input = facts[lastAt(facts, (fact) => fact._tag === "Observed" && fact.observation._tag === "InputArrived")];
    return input?._tag === "Observed" && input.observation._tag === "InputArrived"
      ? summarizers.get(Number(input.observation.text) + 1)
      : undefined;
  },
});

export const afterFizzBuzz = (chosen: (compacted: number) => Summarizer): CompactionPolicy => ({
  name: PolicyName.make("after every FizzBuzz"),
  decide: (facts) => {
    const fizzBuzz = lastTurn(facts).some(
      (fact) =>
        fact._tag === "Observed" &&
        fact.observation._tag === "ModelResponded" &&
        fact.observation.parts.some((part) => {
          if (part._tag !== "ToolCall" || part.tool !== "classify") return false;
          const input = parseJson(part.input);
          return "value" in input && isObject(input.value) && input.value["label"] === "FizzBuzz";
        }),
    );
    const compacted = facts.filter((fact) => fact._tag === "Observed" && fact.observation._tag === "CompactionWindow").length;
    return fizzBuzz ? chosen(compacted) : undefined;
  },
});
