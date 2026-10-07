/**
 * Tool usage as Effect metrics, recorded while tools run: a count of runs and a timer, each with the
 * session, the tool, and how the run ended as attributes. The session is read from `CurrentWork`,
 * which the loop sets around each request; the tool runner is not given it.
 *
 * The same run is described on the current span (the loop's `agent.tool.run`): `outcome` (how it
 * ended, as the metrics name it), `args_chars` (the size of the call's input, as JSON) and
 * `result_chars` (the size of what the tool returned: its output, or the error it reported; absent
 * when it returned nothing). A size is in characters for text; for content kept as bytes, it is
 * the number of bytes.
 *
 * `CountedToolRunner` wraps any tool runner. Metrics are read with `Metric.snapshot`, or sent as
 * OTLP by `OtlpFromEnv` in `telemetry.ts`.
 */

import { Effect, Layer, Metric } from "effect";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { ToolRunner } from "../agent-session/contracts.ts";
import { CurrentWork } from "../agent-session/work.ts";

export const toolRuns = Metric.counter("agent.tool.runs", { description: "Tool runs, by session, tool and outcome." });

export const toolRunTime = Metric.timer("agent.tool.run_time", { description: "How long tool runs take, by session, tool and outcome." });

/** How a run ended, as one attribute value: `Succeeded`, or the reason it failed. */
const ended = (outcome: ToolOutcome): string => (outcome._tag === "Succeeded" ? "Succeeded" : outcome.reason._tag);

/** Returns the size of `received`: its characters when it is text, else its bytes. */
const sizeOf = (received: Received): number => {
  switch (received.body._tag) {
    case "Text":
      return received.body.text.length;
    case "Bytes":
      return received.body.bytes.length;
    case "Stored":
      return received.body.size;
    default:
      return received.body satisfies never;
  }
};

/** Returns what the tool returned: its output, or the error it reported; undefined when the run returned nothing. */
const returned = (outcome: ToolOutcome): Received | undefined => {
  if (outcome._tag === "Succeeded") return outcome.output;
  return outcome.reason._tag === "Reported" ? outcome.reason.error : undefined;
};

export const CountedToolRunner = <E, R>(inner: Layer.Layer<ToolRunner, E, R>): Layer.Layer<ToolRunner, E, R> =>
  Layer.effect(
    ToolRunner,
    Effect.gen(function* () {
      const runner = yield* ToolRunner;
      return {
        run: (tool, input, call) =>
          Effect.gen(function* () {
            const [took, outcome] = yield* Effect.timed(runner.run(tool, input, call));
            const work = yield* CurrentWork;
            const attributes = {
              ...(work.session === undefined ? {} : { session: work.session }),
              tool,
              outcome: ended(outcome),
            };
            const result = returned(outcome);
            yield* Effect.annotateCurrentSpan({ outcome: attributes.outcome, args_chars: sizeOf(input), ...(result === undefined ? {} : { result_chars: sizeOf(result) }) });
            yield* Metric.update(Metric.withAttributes(toolRuns, attributes), 1);
            yield* Metric.update(Metric.withAttributes(toolRunTime, attributes), took);
            return outcome;
          }),
      };
    }),
  ).pipe(Layer.provide(inner));
