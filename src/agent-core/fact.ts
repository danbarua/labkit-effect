/**
 * Facts: recorded Observations and recorded Decisions, each at its position in the session and with
 * the time it was recorded. A decision is recorded at the time of the observation it follows from.
 * The machines compute from positions only; time is added where facts are recorded.
 */

import { Schema } from "effect";
import { Decision } from "./decision.ts";
import { Seq } from "./names.ts";
import { Observation } from "./observation.ts";

/** When a fact was recorded, in UTC; written as an ISO 8601 string. */
export const RecordedAt = Schema.DateTimeUtcFromString;

export const Fact = Schema.Union([
  Schema.TaggedStruct("Observed", { seq: Seq, time: RecordedAt, observation: Observation }),
  Schema.TaggedStruct("Decided", { seq: Seq, time: RecordedAt, decision: Decision }),
]);
export type Fact = typeof Fact.Type;
