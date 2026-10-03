/**
 * Print mode (`-p`): one input, the answer printed, and the process ends. As text, the answer alone;
 * as `json`, the answer with the session's figures, in the shape of Claude Code's result; as
 * `stream-json`, every fact as it is recorded and then the result. A turn that did not end with an
 * answer fails the process.
 */

import { Console, Effect, Fiber, PubSub, Ref, Schema } from "effect";
import { Fact } from "../../agent-machine/fact.ts";
import { contextGauge } from "../../agent-session/accounting.ts";
import type { Session } from "../../agent-session/loop.ts";
import { type Capabilities, knownCapabilities } from "../../agent-session/configuration/well-known-models.ts";
import { invalid } from "./invalid.ts";
import { answerTo, ask, type Config, endingOf, lastTurn } from "./session.ts";

export type OutputFormat = "text" | "json" | "stream-json";

const encodeFact = Schema.encodeSync(Fact);

/** The result of the session's last turn. */
const resultOf = (facts: ReadonlyArray<Fact>, config: Config, started: number, known: Capabilities | undefined) => {
  const turn = lastTurn(facts);
  const ended = endingOf(facts, turn);
  const gauge = contextGauge(facts, config.target.provider, config.target.model, known);
  return {
    type: "result",
    subtype: ended?._tag ?? "NotEnded",
    is_error: ended === undefined || ended._tag === "Failed" || ended._tag === "Vetoed" || ended._tag === "Interrupted",
    duration_ms: Date.now() - started,
    num_turns: facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel")).length,
    result: ended?._tag === "Failed" ? ended.failure : answerTo(facts, turn),
    session_id: config.sessionId,
    model: `${config.target.provider}/${config.target.model}`,
    ...(gauge === undefined ? {} : { total_cost_usd: gauge.cost.amount, context: { used: gauge.used, size: gauge.size } }),
  };
};

/**
 * Prints the session's facts as they are recorded, in order, each once: a new fact wakes the
 * printer, which prints the facts from where it had got to. `finish` stops it and prints the rest.
 */
const printingFacts = (session: Session) =>
  Effect.gen(function* () {
    const printed = yield* Ref.make(0);
    const printRest = Effect.gen(function* () {
      const all = yield* session.facts;
      const from = yield* Ref.getAndSet(printed, all.length);
      yield* Effect.forEach(all.slice(from), (fact) => Console.log(JSON.stringify({ type: "fact", fact: encodeFact(fact) })), { discard: true });
    });
    const recorded = yield* session.subscribe;
    const follower = yield* Effect.forkScoped(Effect.forever(PubSub.take(recorded).pipe(Effect.andThen(printRest))));
    return { finish: Fiber.interrupt(follower).pipe(Effect.andThen(printRest)) };
  });

export const printOnce = (session: Session, config: Config, prompt: string, format: OutputFormat, facts: boolean) =>
  Effect.gen(function* () {
    const started = Date.now();
    const printer = facts || format === "stream-json" ? yield* printingFacts(session) : undefined;
    yield* ask(session, prompt);
    if (printer !== undefined) yield* printer.finish;
    const known = yield* knownCapabilities(config.target.provider, config.target.model);
    const result = resultOf(yield* session.facts, config, started, known);
    yield* Console.log(format === "json" ? JSON.stringify(result, null, 2) : format === "stream-json" ? JSON.stringify(result) : result.result);
    if (result.is_error) return yield* invalid(`The turn ended ${result.subtype}.`);
  });
