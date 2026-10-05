/**
 * Facts: recorded observations and recorded decisions. Each fact has its position in the session
 * (`seq`) and the time it was recorded.
 *
 * - An observation is recorded with its origin: who or what reported it.
 * - A decision is the core's own, and is recorded at the time of the observation it follows from.
 * - The machines compute from positions only. The layer that records facts adds the time.
 */

import { Schema } from "effect";
import { Decision } from "./decision.ts";
import { Seq } from "./names.ts";
import { Observation } from "./observation.ts";
import { Origin } from "./origin.ts";

/** When a fact was recorded, in UTC; written as an ISO 8601 string. */
export const RecordedAt = Schema.DateTimeUtcFromString;

export const Fact = Schema.Union([
  Schema.TaggedStruct("Observed", { seq: Seq, time: RecordedAt, origin: Origin, observation: Observation }),
  Schema.TaggedStruct("Decided", { seq: Seq, time: RecordedAt, decision: Decision }),
]);
export type Fact = typeof Fact.Type;
