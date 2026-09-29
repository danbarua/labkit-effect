/**
 * Projects a Claude Code session file into a trajectory: its records become our observations, the
 * core decides what follows exactly as it does live, and the facts it records are the trajectory.
 * Every record kind the importer does not map is counted in a report beside it, with how often the
 * core found an observation it did not expect.
 *
 *   bun scripts/trajectories/claude-code.ts <session.jsonl> [out-dir]
 *
 * `importClaudeCode` does the projection for a caller that writes elsewhere, such as the sweep.
 *
 * The output is regenerated, never edited: change the importer or the core, then run it again.
 * The source file is only read.
 *
 * Mapping:
 * - a user message with text is `InputArrived`, from the user, or from the system when Claude Code
 *   marks it meta (a hook's feedback, a message from another session); while the agent is idle a
 *   turn is started, as the loop does;
 * - a `compact_boundary` record and the summary message after it are one `Compacted`: the window is
 *   the boundary's uuid, the previous window the file's previous boundary, `through` the last
 *   position before the boundary, and `kept` the positions of the messages the boundary names as
 *   kept verbatim. A boundary with nothing before it in the file is counted, not mapped;
 * - the assistant records with one message id are one `ModelResponded`, however other records
 *   interleave with them: `text` is `Text`, `thinking` with its signature is `Thinking`, `tool_use`
 *   is `ToolCall`, anything else is `Unrecognised`; the message's id and usage are its metadata,
 *   and its `stop_reason` is classified as the Anthropic adapter classifies it.
 *   Claude Code starts a tool as soon as its call has streamed in, so a result can be recorded
 *   before the rest of its message; such results are given after the message, and the early start
 *   is not represented;
 * - a `tool_result` block is `ToolEnded`: `Failed` (the tool's own report) when `is_error`,
 *   otherwise `Succeeded`;
 * - after a final answer the core asks `BeforeTurnEnded`; a Stop hook's feedback that follows is
 *   given to the turn first, and the review is answered (`TurnEndReviewed`) at the next record that
 *   is not such feedback.
 */

import { basename } from "node:path";
import { eachRecord, type Imported, type Json, json, projection, type Record_, str, text, writeTrajectory } from "./project.ts";
import { anthropicEndings } from "../../src/agent-effect/anthropic-client.ts";
import { endingOf } from "../../src/agent-effect/shaping.ts";

export async function importClaudeCode(source: string): Promise<Imported> {
  const projected = projection();
  const { count } = projected;

  const state = {
    turns: 0,
    records: 0,
    pending: undefined as
      | { id: string; uuids: Array<Json>; model: string; blocks: Array<Json>; usage: Json; stop: Json }
      | undefined,
    /** Tool results recorded while their message was still arriving, given after it. */
    held: [] as Array<{ result: Record_; uuid: Json | undefined }>,
    /** A turn whose `BeforeTurnEnded` is not answered yet: a Stop hook's feedback may still come. */
    review: undefined as string | undefined,
    /** The positions recorded for each Claude Code record, by its uuid. */
    positions: new Map<string, Array<number>>(),
    /** Each record's type and subtype, by its uuid. */
    kinds: new Map<string, string>(),
    /** A boundary whose summary message has not arrived yet. */
    boundary: undefined as { window: string; through: number; kept: ReadonlyArray<string> } | undefined,
    /** The window of the file's last boundary. */
    window: undefined as string | undefined,
  };

  const placed = (uuid: Json | undefined, seq: number): void => {
    if (typeof uuid !== "string") return;
    state.positions.set(uuid, [...(state.positions.get(uuid) ?? []), seq]);
  };


  /** Records the observation and what follows from it; returns its position. */
  function observe(raw: unknown): number {
    const { seq, requests } = projected.observe(raw);
    for (const request of requests) if (request._tag === "BeforeTurnEnded") state.review = request.turn;
    const observation = raw as { _tag: string };
    if (observation._tag === "InputArrived" && projected.world().agent.state._tag === "Idle") {
      state.turns += 1;
      observe({ _tag: "TurnStarted", turn: `turn-${state.turns}` });
    }
    return seq;
  }

  function currentTurn(): string {
    const agent = projected.world().agent.state;
    return agent._tag === "Running" ? agent.turn : `turn-${state.turns}`;
  }

  function part(block: Json): unknown {
    if (typeof block === "object" && block !== null && !Array.isArray(block)) {
      const b = block as Record_;
      if (b["type"] === "text" && typeof b["text"] === "string") return { _tag: "Text", text: b["text"] };
      if (b["type"] === "thinking" && typeof b["thinking"] === "string" && typeof b["signature"] === "string")
        return { _tag: "Thinking", text: b["thinking"], signature: b["signature"] };
      if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string")
        return { _tag: "ToolCall", call: b["id"], tool: b["name"], input: json(b["input"] ?? {}) };
    }
    return { _tag: "Unrecognised", received: json(block) };
  }

  /** Answers the open `BeforeTurnEnded`: whatever feedback there was has been given. */
  function flushReview(): void {
    const turn = state.review;
    if (turn === undefined) return;
    state.review = undefined;
    observe({ _tag: "TurnEndReviewed", turn });
  }

  /** The assistant message gathered so far, as one model response. */
  function flushResponse(): void {
    const pending = state.pending;
    if (pending === undefined) return;
    state.pending = undefined;
    const seq = observe({
      _tag: "ModelResponded",
      turn: currentTurn(),
      provider: "anthropic",
      model: pending.model,
      parts: pending.blocks.map(part),
      stop: typeof pending.stop === "string" ? pending.stop : JSON.stringify(pending.stop),
      ending: endingOf(anthropicEndings, pending.stop),
      metadata: json({ id: pending.id, usage: pending.usage }),
    });
    for (const uuid of pending.uuids) placed(uuid, seq);
    const held = state.held.splice(0);
    for (const { result, uuid } of held) toolEnded(result, uuid);
  }

  function toolEnded(result: Record_, uuid: Json | undefined): void {
    const seq = observe({
      _tag: "ToolEnded",
      call: str(result["tool_use_id"]),
      outcome:
        result["is_error"] === true
          ? { _tag: "Failed", reason: { _tag: "Reported", error: resultContent(result["content"]) } }
          : { _tag: "Succeeded", output: resultContent(result["content"]) },
    });
    placed(uuid, seq);
  }

  function resultContent(content: Json | undefined): unknown {
    return typeof content === "string" ? text(content) : json(content ?? null);
  }

  function onRecord(record: Record_): void {
    state.records += 1;
    const type = typeof record["type"] === "string" ? record["type"] : "<no type>";
    const message = record["message"];
    const subtype = typeof record["subtype"] === "string" ? `/${record["subtype"]}` : "";
    if (typeof record["uuid"] === "string") state.kinds.set(record["uuid"], `${type}${subtype}`);
    if (record["isSidechain"] === true) return count(`${type} (sidechain: a subagent)`);
    if (type === "assistant" && typeof message === "object" && message !== null && !Array.isArray(message)) {
      const m = message as Record_;
      const id = typeof m["id"] === "string" ? m["id"] : "";
      if (state.pending !== undefined && state.pending.id !== id) flushResponse();
      if (state.pending === undefined) flushReview();
      const blocks = Array.isArray(m["content"]) ? (m["content"] as Array<Json>) : [];
      state.pending = {
        id,
        uuids: [...(state.pending?.uuids ?? []), record["uuid"] ?? null],
        model: typeof m["model"] === "string" ? m["model"] : "unknown",
        blocks: [...(state.pending?.blocks ?? []), ...blocks],
        usage: m["usage"] ?? null,
        stop: m["stop_reason"] ?? null,
      };
      return;
    }
    if (type === "user" && typeof message === "object" && message !== null && !Array.isArray(message)) {
      const content = (message as Record_)["content"];
      const blocks = Array.isArray(content) ? (content as Array<Json>) : [];
      const results = blocks.filter((b) => (b as Record_ | null)?.["type"] === "tool_result") as Array<Record_>;
      const texts = blocks.flatMap((b) => {
        const r = b as Record_ | null;
        return r?.["type"] === "text" && typeof r["text"] === "string" ? [r["text"]] : [];
      });
      const input = typeof content === "string" ? content : texts.length > 0 ? texts.join("\n") : undefined;
      // Results that arrive while their message is still being recorded (Claude Code starts a tool
      // as soon as its call has streamed in) are held until the message is complete.
      if (input === undefined && state.pending !== undefined) {
        state.held.push(...results.map((result) => ({ result, uuid: record["uuid"] })));
        return;
      }
      flushResponse();
      const stopHook = record["isMeta"] === true && typeof content === "string" && content.startsWith("Stop hook feedback");
      if (!stopHook) flushReview();
      const boundary = state.boundary;
      if (record["isCompactSummary"] === true && boundary !== undefined && input !== undefined) {
        state.boundary = undefined;
        const kept = boundary.kept.flatMap((uuid) => state.positions.get(uuid) ?? []);
        for (const uuid of boundary.kept.filter((kept) => !state.positions.has(kept)))
          count(`kept by a compaction, with no position: ${state.kinds.get(uuid) ?? "not in the file"}`);
        observe({
          _tag: "Compacted",
          window: boundary.window,
          ...(state.window === undefined ? {} : { previous: state.window }),
          summary: text(input),
          through: boundary.through,
          kept,
        });
        state.window = boundary.window;
        return;
      }
      for (const result of results) toolEnded(result, record["uuid"]);
      // A meta message is shown to the model but was not typed by the user: a hook's feedback, a
      // message from another session, a command's output.
      // A summary with no boundary before it is still shown to the model: as input from the system.
      if (record["isCompactSummary"] === true) count("user (compaction summary with no boundary, given as input)");
      const from = record["isMeta"] === true || record["isCompactSummary"] === true ? { _tag: "System" } : { _tag: "User" };
      if (input !== undefined) placed(record["uuid"], observe({ _tag: "InputArrived", from, text: input }));
      const others = blocks.filter((b) => !["tool_result", "text"].includes(str((b as Record_ | null)?.["type"])));
      for (const other of others) count(`user block: ${str((other as Record_ | null)?.["type"])}`);
      return;
    }
    if (type === "system" && record["subtype"] === "compact_boundary") {
      flushResponse();
      flushReview();
      if (projected.recorded() === 0) return count("system/compact_boundary (nothing before it in the file)");
      const metadata = record["compactMetadata"] as Record_ | undefined;
      const preserved = metadata?.["preservedMessages"] as Record_ | undefined;
      const all = preserved?.["allUuids"];
      state.boundary = {
        window: str(record["uuid"]),
        through: projected.recorded(),
        kept: Array.isArray(all) ? all.flatMap((uuid) => (typeof uuid === "string" ? [uuid] : [])) : [],
      };
      return;
    }
    count(`${type}${subtype}`);
  }

  await eachRecord(source, onRecord, count);
  flushResponse();
  flushReview();
  if (state.boundary !== undefined) count("system/compact_boundary (no summary after it)");
  return projected.imported(source, state.records, state.turns);
}

if (import.meta.main) {
  const [source, outDir = "trajectories/claude-code"] = process.argv.slice(2);
  if (source === undefined) throw new Error("usage: bun scripts/trajectories/claude-code.ts <session.jsonl> [out-dir]");
  const imported = await importClaudeCode(source);
  writeTrajectory(outDir, basename(source, ".jsonl"), imported);
  console.log(JSON.stringify(imported.report, null, 2));
}
