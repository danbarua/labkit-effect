/**
 * Plays the part of the layer around the core: records each observation, asks the machine what
 * follows, records the decisions, and collects the effect requests. It carries out `StartTurn`
 * itself, naming turns `turn-1`, `turn-2`, …; every other request is left to the test.
 */

import { Schema } from "effect";
import type { Fact } from "../../src/agent-core/fact.ts";
import { deliver, emptyWorld, type World } from "../../src/agent-core/router.ts";
import { Seq } from "../../src/agent-core/names.ts";
import { Observation } from "../../src/agent-core/observation.ts";
import type { EffectRequest } from "../../src/agent-core/request.ts";

export interface Session {
  world: World;
  journal: Array<Fact>;
  requests: Array<EffectRequest>;
  turns: number;
  /** Whether the driver carries out `StartTurn` requests; a test that plays that adapter sets false. */
  startsTurns: boolean;
}

export function open(): Session {
  return { world: emptyWorld, journal: [], requests: [], turns: 0, startsTurns: true };
}

function record(session: Session, fact: Fact): void {
  session.journal.push(fact);
}

/** Records `raw` as an observation, then everything that follows from it. Returns its position. */
export function observe(session: Session, raw: unknown): Seq {
  // Refusing unknown fields here catches a mistyped field in a test's own data.
  const observation = Schema.decodeUnknownSync(Observation)(raw, { onExcessProperty: "error" });
  const seq = Seq.make(session.journal.length + 1);
  const outcome = deliver(session.world, seq, observation);
  session.world = outcome.world;
  record(session, { _tag: "Observed", seq, observation });
  for (const decision of outcome.decisions)
    record(session, { _tag: "Decided", seq: Seq.make(session.journal.length + 1), decision });
  session.requests.push(...outcome.requests);
  for (const request of outcome.requests)
    if (request._tag === "StartTurn" && session.startsTurns) {
      session.turns += 1;
      observe(session, { _tag: "TurnStarted", turn: `turn-${session.turns}`, inputs: request.inputs });
    }
  return seq;
}

/** The decisions recorded after position `seq`, by tag. */
export function decidedAfter(session: Session, seq: Seq): Array<Fact> {
  return session.journal.filter((fact) => fact.seq > seq && fact._tag === "Decided");
}
