/**
 * Where a session's tools come from: an ordered list of sources (the host's own tools, an MCP
 * server's, an extension's), each offering its tools and running calls to them. The tools are
 * joined in order into the catalog a session opens with (`offeredTools`), and a call goes to the
 * source that offered its tool (`SourcedToolRunner`).
 *
 * A source with a namespace offers each of its tools as `<namespace>__<tool>`, so the tools of two
 * sources never share a name: an MCP server's source takes `mcp__<server>`, as Claude Code names
 * them. The host's own tools have none, and keep their names. A source is asked to run a call by
 * its own name for the tool.
 */

import { Context, Effect, Layer } from "effect";
import { type CallId, ToolName } from "../agent-machine/names.ts";
import type { ToolOutcome } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";
import { ToolRunner, type ToolSpec } from "./contracts.ts";

export interface ToolSource {
  /**
   * What the source's tools are offered under, if anything. None for the host's own tools: sessions
   * already recorded calls to them by their names, and a session that goes on from its facts runs
   * those calls again by the names recorded.
   */
  readonly namespace?: string;
  readonly tools: ReadonlyArray<ToolSpec>;
  /** Runs a call to one of its tools, named as the source names it. */
  readonly run: (tool: ToolName, input: Received, call: CallId) => Effect.Effect<ToolOutcome>;
}

/** A session's tool sources, in order. None by default. */
export const ToolSources = Context.Reference<ReadonlyArray<ToolSource>>("agent-session/ToolSources", { defaultValue: () => [] });

/** The tools of `sources` as offered, and how a call to one by that name is run. */
export interface Tools {
  readonly catalog: ReadonlyArray<ToolSpec>;
  readonly run: (tool: ToolName, input: Received, call: CallId) => Effect.Effect<ToolOutcome>;
}

interface Offered {
  readonly spec: ToolSpec;
  readonly own: ToolName;
  readonly source: ToolSource;
  readonly position: number;
}

const describe = ({ source, position }: Offered): string =>
  `source ${position + 1}${source.namespace === undefined ? " (no namespace)" : ` (namespace ${source.namespace})`}`;

/**
 * The tools of `sources`, in order, each by the name it is offered under, and a runner that sends a
 * call to the source that offered its tool; a name no source offers ends `NotFound`. Two tools
 * offered under one name (two sources without a namespace, or with the same one, offering a tool
 * of the same name) are a defect of the host that listed them: it dies, naming the tool and both
 * sources.
 */
export const toolsOf = (sources: ReadonlyArray<ToolSource>): Effect.Effect<Tools> => {
  const offered: ReadonlyArray<Offered> = sources.flatMap((source, position) =>
    source.tools.map((spec) => ({
      spec: { ...spec, name: source.namespace === undefined ? spec.name : ToolName.make(`${source.namespace}__${spec.name}`) },
      own: spec.name,
      source,
      position,
    })),
  );
  const names = offered.map((each) => each.spec.name);
  const twice = offered.find((each, index) => names.indexOf(each.spec.name) !== index);
  const first = twice === undefined ? undefined : offered.find((each) => each.spec.name === twice.spec.name);
  if (twice !== undefined && first !== undefined)
    return Effect.die(new Error(`Two tool sources offer a tool named ${twice.spec.name}: ${describe(first)} and ${describe(twice)}`));
  const byName = new Map(offered.map((each) => [each.spec.name, each] as const));
  return Effect.succeed({
    catalog: offered.map((each) => each.spec),
    run: (tool, input, call) => {
      const found = byName.get(tool);
      return found === undefined ? Effect.succeed<ToolOutcome>({ _tag: "Failed", reason: { _tag: "NotFound" } }) : found.source.run(found.own, input, call);
    },
  });
};

/** The tools a session's sources (`ToolSources`) offer, in order, by the names they are offered under. */
export const offeredTools: Effect.Effect<ReadonlyArray<ToolSpec>> = Effect.gen(function* () {
  return (yield* toolsOf(yield* ToolSources)).catalog;
});

/** The runner of a session's sources (`ToolSources`, as the layer is built): each call goes to the source that offered its tool. */
export const SourcedToolRunner: Layer.Layer<ToolRunner> = Layer.effect(
  ToolRunner,
  Effect.gen(function* () {
    const { run } = yield* toolsOf(yield* ToolSources);
    return { run };
  }),
);
