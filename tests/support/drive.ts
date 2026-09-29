/**
 * Plays the part of the layer around the core: records each observation, asks the machine what
 * follows, records the decisions, and collects the effect requests. It starts turns by the loop's
 * rule (input arrives while the agent is idle), naming them `turn-1`, `turn-2`, …, and answers
 * `BeforeTurnEnded` at once, as a layer with no turn-end hooks does; every other request is left to
 * the test.
 */

import { DateTime, Schema } from "effect";
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
  /** Whether the driver starts turns; a test that starts them itself sets false. */
  startsTurns: boolean;
  /** Whether the driver answers `BeforeTurnEnded` at once, as a layer with no hooks does. */
  reviewsTurnEnds: boolean;
}

/** The opening of session "s1", asking model "boring-1", with no system prompt or tools. */
export const opened = { _tag: "SessionOpened", session: "s1", model: { provider: "boring", model: "boring-1" } };

export function open(): Session {
  return { world: emptyWorld, journal: [], requests: [], turns: 0, startsTurns: true, reviewsTurnEnds: true };
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
  // A test's clock: each observation is recorded one second after the one before, from the epoch.
  const time = DateTime.makeUnsafe(seq * 1000);
  record(session, { _tag: "Observed", seq, time, observation });
  for (const decision of outcome.decisions)
    record(session, { _tag: "Decided", seq: Seq.make(session.journal.length + 1), time, decision });
  session.requests.push(...outcome.requests);
  for (const request of outcome.requests)
    if (request._tag === "BeforeTurnEnded" && session.reviewsTurnEnds)
      observe(session, { _tag: "TurnEndReviewed", turn: request.turn });
  if (observation._tag === "InputArrived" && session.startsTurns && session.world.agent.state._tag === "Idle") {
    session.turns += 1;
    observe(session, { _tag: "TurnStarted", turn: `turn-${session.turns}` });
  }
  return seq;
}

/** The decisions recorded after position `seq`, by tag. */
export function decidedAfter(session: Session, seq: Seq): Array<Fact> {
  return session.journal.filter((fact) => fact.seq > seq && fact._tag === "Decided");
}
