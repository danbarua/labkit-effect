/**
 * Tool usage as Effect metrics, recorded while tools run: a count of runs and a timer, each with the
 * session, the tool, and how the run ended as attributes. The session is read from `CurrentWork`,
 * which the loop sets around each request; the tool runner is not given it.
 *
 * `CountedToolRunner` wraps any tool runner. Metrics are read with `Metric.snapshot`, or sent as
 * OTLP by `OtlpFromEnv` in `telemetry.ts`.
 */

import { Effect, Layer, Metric } from "effect";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import { ToolRunner } from "../agent-session/contracts.ts";
import { CurrentWork } from "../agent-session/work.ts";

export const toolRuns = Metric.counter("agent.tool.runs", { description: "Tool runs, by session, tool and outcome." });

export const toolRunTime = Metric.timer("agent.tool.run_time", { description: "How long tool runs take, by session, tool and outcome." });

/** How a run ended, as one attribute value: `Succeeded`, or the reason it failed. */
const ended = (outcome: ToolOutcome): string => (outcome._tag === "Succeeded" ? "Succeeded" : outcome.reason._tag);

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
            yield* Metric.update(Metric.withAttributes(toolRuns, attributes), 1);
            yield* Metric.update(Metric.withAttributes(toolRunTime, attributes), took);
            return outcome;
          }),
      };
    }),
  ).pipe(Layer.provide(inner));
