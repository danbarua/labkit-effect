/**
 * Tool usage for one session, computed from its facts: for each tool, how many calls the model made,
 * and how many ended in each way. A call is matched to its end by its id; a call with no end yet is
 * counted as unfinished. Nothing is recorded: the numbers are recomputed from the facts on each read.
 */

import type { Fact } from "../agent-core/fact.ts";
import type { CallId, ToolName } from "../agent-core/names.ts";
import type { ToolOutcome } from "../agent-core/observation.ts";

export interface ToolStats {
  readonly calls: number;
  readonly succeeded: number;
  /** Failed calls by reason. */
  readonly failed: Readonly<Record<Extract<ToolOutcome, { _tag: "Failed" }>["reason"]["_tag"], number>>;
  readonly unfinished: number;
}

const none: ToolStats = {
  calls: 0,
  succeeded: 0,
  failed: { Reported: 0, NotFound: 0, InputRejected: 0, Vetoed: 0, Indeterminate: 0, NotRun: 0 },
  unfinished: 0,
};

export function toolStats(facts: ReadonlyArray<Fact>): ReadonlyMap<ToolName, ToolStats> {
  const calls = new Map<CallId, ToolName>(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ModelResponded"
        ? fact.observation.parts.flatMap((part) => (part._tag === "ToolCall" ? [[part.call, part.tool] as const] : []))
        : [],
    ),
  );
  const ends = new Map<CallId, ToolOutcome>(
    facts.flatMap((fact) =>
      fact._tag === "Observed" && fact.observation._tag === "ToolEnded"
        ? [[fact.observation.call, fact.observation.outcome] as const]
        : [],
    ),
  );
  return [...calls].reduce((stats, [call, tool]) => {
    const now = stats.get(tool) ?? none;
    const outcome = ends.get(call);
    const next: ToolStats =
      outcome === undefined
        ? { ...now, calls: now.calls + 1, unfinished: now.unfinished + 1 }
        : outcome._tag === "Succeeded"
          ? { ...now, calls: now.calls + 1, succeeded: now.succeeded + 1 }
          : {
              ...now,
              calls: now.calls + 1,
              failed: { ...now.failed, [outcome.reason._tag]: now.failed[outcome.reason._tag] + 1 },
            };
    return new Map([...stats, [tool, next]]);
  }, new Map<ToolName, ToolStats>());
}
