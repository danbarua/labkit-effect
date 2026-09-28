/**
 * Facts: recorded Observations and recorded Decisions. A session's journal is its facts in order.
 */

import { Schema } from "effect";
import { Decision } from "./decision.ts";
import { Seq } from "./names.ts";
import { Observation } from "./observation.ts";

export const Fact = Schema.Union([
  Schema.TaggedStruct("Observed", { seq: Seq, observation: Observation }),
  Schema.TaggedStruct("Decided", { seq: Seq, decision: Decision }),
]);
export type Fact = typeof Fact.Type;

export const Journal = Schema.Array(Fact);
export type Journal = typeof Journal.Type;
