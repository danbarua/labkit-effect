/**
 * What every importer shares: records observations and the core's decisions after them, counts
 * what it does not map, and writes the trajectory and its report.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime, Option, Schema } from "effect";
import { WindowSummary } from "../../src/agent-context/forks.ts";
import { Fact } from "../../src/agent-core/fact.ts";
import { HarnessPart, Seq, ToolName, Via } from "../../src/agent-core/names.ts";
import { Observation } from "../../src/agent-core/observation.ts";
import type { Origin } from "../../src/agent-core/origin.ts";
import type { EffectRequest } from "../../src/agent-core/request.ts";
import { deliver, emptyWorld, type World } from "../../src/agent-core/router.ts";

export type Json = Schema.Json;
export type Record_ = { readonly [key: string]: Json };

/**
 * What an import produced: the facts, the summaries of its compaction windows (held apart from the
 * facts, as compaction forks' summaries), and the report of what was and was not mapped.
 */
export interface Imported {
  readonly facts: ReadonlyArray<unknown>;
  readonly summaries: ReadonlyArray<unknown>;
  readonly report: {
    readonly source: string;
    readonly records: number;
    readonly facts: number;
    readonly turns: number;
    readonly decisions: Record<string, number>;
    readonly unmapped: Record<string, number>;
  };
}

export const json = (value: Json) => ({ mediaType: "application/json", body: { _tag: "Text", text: JSON.stringify(value) } });
export const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } });
export const str = (value: Json | undefined): string => (typeof value === "string" ? value : "");
export const isRecord = (value: Json | undefined): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface Projection {
  /**
   * The time of the source record being read, as an ISO 8601 string. A fact is recorded at the
   * latest time read so far, so times never go backwards, even where the importer holds a record
   * back and records it after a later one. A fact recorded before any record has had a time fails
   * the import.
   */
  readonly readAt: (time: Json | undefined) => void;
  /** Records the observation and the decisions after it; returns its position and the requests. */
  readonly observe: (raw: unknown) => { readonly seq: number; readonly requests: ReadonlyArray<EffectRequest> };
  readonly count: (kind: string) => void;
  /** Keeps a compaction window's summary, apart from the facts. */
  readonly summarise: (raw: unknown) => void;
  readonly world: () => World;
  /** How many facts are recorded: the position of the last. */
  readonly recorded: () => number;
  /** Whether anything but the session's opening has been recorded: the conversation has begun. */
  readonly begun: () => boolean;
  readonly imported: (source: string, records: number, turns: number) => Imported;
}

/**
 * Where an imported observation came from, as far as the record says. `harness` names the harness
 * whose session file is read: a user's input and the session's opening came from the user through
 * it, a response from its provider, a tool's outcome from the tool when the record has the call,
 * and everything else from that harness itself.
 */
function originOf(observation: Observation, harness: string, tools: ReadonlyMap<string, string>): Origin {
  const itself: Origin = { _tag: "Harness", part: HarnessPart.make(harness) };
  switch (observation._tag) {
    case "SessionOpened":
      return { _tag: "User", via: Via.make(harness) };
    case "InputArrived":
      return observation.from._tag === "User" ? { _tag: "User", via: Via.make(harness) } : itself;
    case "ModelResponded":
      return { _tag: "Provider", provider: observation.provider };
    case "ToolEnded": {
      const tool = tools.get(observation.call);
      return tool === undefined ? itself : { _tag: "Tool", tool: ToolName.make(tool) };
    }
    default:
      return itself;
  }
}

/** A projection of the session file of `harness` ("claude-code", "codex"). */
export function projection(harness: string): Projection {
  const facts: Array<unknown> = [];
  const summaries: Array<unknown> = [];
  const summary = Schema.decodeUnknownSync(WindowSummary);
  const encodeSummary = Schema.encodeSync(WindowSummary);
  const unmapped = new Map<string, number>();
  const decode = Schema.decodeUnknownSync(Observation);
  const encodeFact = Schema.encodeSync(Fact);
  const state = { world: emptyWorld as World, time: undefined as DateTime.Utc | undefined, begun: false };
  const tools = new Map<string, string>();

  return {
    readAt: (time) => {
      const read = typeof time === "string" ? DateTime.make(time) : Option.none();
      if (Option.isNone(read)) return;
      const utc = DateTime.toUtc(read.value);
      state.time = state.time === undefined ? utc : DateTime.max(state.time, utc);
    },
    observe: (raw) => {
      const observation = decode(raw);
      const time = state.time;
      if (time === undefined) throw new Error(`a ${observation._tag} came before any record with a time`);
      const seq = Seq.make(facts.length + 1);
      const outcome = deliver(state.world, seq, observation);
      state.world = outcome.world;
      if (observation._tag !== "SessionOpened") state.begun = true;
      if (observation._tag === "ModelResponded")
        for (const part of observation.parts) if (part._tag === "ToolCall") tools.set(part.call, part.tool);
      facts.push(encodeFact({ _tag: "Observed", seq, time, origin: originOf(observation, harness, tools), observation }));
      for (const decision of outcome.decisions)
        facts.push(encodeFact({ _tag: "Decided", seq: Seq.make(facts.length + 1), time, decision }));
      return { seq, requests: outcome.requests };
    },
    count: (kind) => {
      unmapped.set(kind, (unmapped.get(kind) ?? 0) + 1);
    },
    summarise: (raw) => {
      summaries.push(encodeSummary(summary(raw)));
    },
    world: () => state.world,
    recorded: () => facts.length,
    begun: () => state.begun,
    imported: (source, records, turns) => {
      const decided = new Map<string, number>();
      for (const fact of facts as Array<{ _tag: string; decision?: { _tag: string } }>)
        if (fact._tag === "Decided" && fact.decision !== undefined)
          decided.set(fact.decision._tag, (decided.get(fact.decision._tag) ?? 0) + 1);
      return {
        facts,
        summaries,
        report: {
          source,
          records,
          facts: facts.length,
          turns,
          decisions: Object.fromEntries([...decided].sort((a, b) => b[1] - a[1])),
          unmapped: Object.fromEntries([...unmapped].sort((a, b) => b[1] - a[1])),
        },
      };
    },
  };
}

/**
 * Calls `onRecord` with each JSON line of the file; a line that fails is counted by its error. Lines
 * are split on `\n` only: Node's line reader also splits on U+2028, which JSON strings may hold.
 */
export function eachRecord(source: string, onRecord: (record: Record_) => void, count: (kind: string) => void): void {
  for (const line of readFileSync(source, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      onRecord(JSON.parse(line) as Record_);
    } catch (error) {
      count(`<unreadable line: ${error instanceof Error ? error.message.slice(0, 60) : "?"}>`);
    }
  }
}

/**
 * Writes an import's facts, its window summaries (when it has any) and its report as
 * `<name>.facts.jsonl`, `<name>.summaries.jsonl` and `<name>.report.json` in `outDir`.
 */
export function writeTrajectory(outDir: string, name: string, imported: Imported): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.facts.jsonl`), `${imported.facts.map((fact) => JSON.stringify(fact)).join("\n")}\n`);
  if (imported.summaries.length > 0)
    writeFileSync(
      join(outDir, `${name}.summaries.jsonl`),
      `${imported.summaries.map((summary) => JSON.stringify(summary)).join("\n")}\n`,
    );
  writeFileSync(join(outDir, `${name}.report.json`), `${JSON.stringify(imported.report, null, 2)}\n`);
}
