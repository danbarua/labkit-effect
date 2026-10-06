/**
 * Print mode (`-p`): one prompt, the answer printed, then exit. With text output, only the answer is
 * printed; with `json`, the answer and the session's usage and cost, in the shape of Claude Code's
 * result; with `stream-json`, each fact as it is recorded, then the result. The process exits with 0
 * only when the turn completed; any other ending, or no ending, exits with failure.
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

/** Returns the result of the session's last turn. */
const resultOf = (facts: ReadonlyArray<Fact>, config: Config, started: number, known: Capabilities | undefined) => {
  const turn = lastTurn(facts);
  const ended = endingOf(facts, turn);
  const gauge = contextGauge(facts, config.target.provider, config.target.model, known);
  return {
    type: "result",
    subtype: ended?._tag ?? "NotEnded",
    is_error: ended?._tag !== "Completed",
    duration_ms: Date.now() - started,
    num_turns: facts.filter((fact) => fact._tag === "Decided" && (fact.decision._tag === "AskModel" || fact.decision._tag === "TellModel")).length,
    result: ended?._tag === "Failed" ? ended.failure : answerTo(facts, turn),
    session_id: config.sessionId,
    model: `${config.target.provider}/${config.target.model}`,
    ...(gauge === undefined ? {} : { total_cost_usd: gauge.cost.amount, context: { used: gauge.used, size: gauge.size } }),
  };
};

/**
 * Prints the session's facts in order as they are recorded, each once: a new fact wakes the printer,
 * which prints from where it left off. `finish` stops it and prints any remaining facts.
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

/** Formats the result for `format`: indented JSON, one line of JSON, or the answer's text. */
const printedAs = (format: OutputFormat, result: { readonly result: string }): string => {
  switch (format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "stream-json":
      return JSON.stringify(result);
    case "text":
      return result.result;
    default:
      return format satisfies never;
  }
};

export const printOnce = (session: Session, config: Config, prompt: string, format: OutputFormat, facts: boolean) =>
  Effect.gen(function* () {
    const started = Date.now();
    const printer = facts || format === "stream-json" ? yield* printingFacts(session) : undefined;
    yield* ask(session, prompt);
    if (printer !== undefined) yield* printer.finish;
    const known = yield* knownCapabilities(config.target.provider, config.target.model);
    const result = resultOf(yield* session.facts, config, started, known);
    yield* Console.log(printedAs(format, result));
    if (result.is_error) return yield* invalid(`The turn ended ${result.subtype}.`);
  });
