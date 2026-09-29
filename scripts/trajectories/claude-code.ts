/**
 * Projects a Claude Code session file into a trajectory: its records become our observations, the
 * core decides what follows exactly as it does live, and the facts it records are the trajectory.
 * Every record kind the importer does not map is counted in a report beside it, with how often the
 * core found an observation it did not expect.
 *
 *   bun scripts/trajectories/claude-code.ts <session.jsonl> [out-dir]
 *
 * The output is regenerated, never edited: change the importer or the core, then run it again.
 * The source file is only read.
 *
 * Mapping:
 * - a user message with text is `InputArrived`, from the user, or from the system when Claude Code
 *   marks it meta (a hook's feedback, a message from another session); while the agent is idle a
 *   turn is started, as the loop does;
 * - the assistant records with one message id are one `ModelResponded`, however other records
 *   interleave with them: `text` is `Text`, `thinking` with its signature is `Thinking`, `tool_use`
 *   is `ToolCall`, anything else is `Unrecognised`; the message's id and usage are its metadata.
 *   Claude Code starts a tool as soon as its call has streamed in, so a result can be recorded
 *   before the rest of its message; such results are given after the message, and the early start
 *   is not represented;
 * - a `tool_result` block is `ToolEnded`: `Failed` (the tool's own report) when `is_error`,
 *   otherwise `Succeeded`;
 * - after a final answer the core asks `BeforeTurnEnded`; a Stop hook's feedback that follows is
 *   given to the turn first, and the review is answered (`TurnEndReviewed`) at the next record that
 *   is not such feedback.
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import { Fact } from "../../src/agent-core/fact.ts";
import { Observation } from "../../src/agent-core/observation.ts";
import { deliver, emptyWorld, type World } from "../../src/agent-core/router.ts";
import { Seq } from "../../src/agent-core/names.ts";

type Json = Schema.Json;
type Record_ = { readonly [key: string]: Json };

const [source, outDir = "trajectories/claude-code"] = process.argv.slice(2);
if (source === undefined) throw new Error("usage: bun scripts/trajectories/claude-code.ts <session.jsonl> [out-dir]");

const json = (value: Json) => ({ mediaType: "application/json", body: { _tag: "Text", text: JSON.stringify(value) } });
const text = (value: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text: value } });

const state = {
  world: emptyWorld as World,
  facts: [] as Array<unknown>,
  turns: 0,
  unmapped: new Map<string, number>(),
  records: 0,
  pending: undefined as { id: string; model: string; blocks: Array<Json>; usage: Json; stop: Json } | undefined,
  /** Tool results recorded while their message was still arriving, given after it. */
  held: [] as Array<Record_>,
  /** A turn whose `BeforeTurnEnded` is not answered yet: a Stop hook's feedback may still come. */
  review: undefined as string | undefined,
};

const count = (kind: string): void => {
  state.unmapped.set(kind, (state.unmapped.get(kind) ?? 0) + 1);
};
const decode = Schema.decodeUnknownSync(Observation);
const encodeFact = Schema.encodeSync(Fact);

function observe(raw: unknown): void {
  const observation = decode(raw);
  const seq = Seq.make(state.facts.length + 1);
  const outcome = deliver(state.world, seq, observation);
  state.world = outcome.world;
  state.facts.push(encodeFact({ _tag: "Observed", seq, observation }));
  for (const decision of outcome.decisions)
    state.facts.push(encodeFact({ _tag: "Decided", seq: Seq.make(state.facts.length + 1), decision }));
  for (const request of outcome.requests) if (request._tag === "BeforeTurnEnded") state.review = request.turn;
  if (observation._tag === "InputArrived" && state.world.agent.state._tag === "Idle") {
    state.turns += 1;
    observe({ _tag: "TurnStarted", turn: `turn-${state.turns}` });
  }
}

function currentTurn(): string {
  const agent = state.world.agent.state;
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

const str = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/** The assistant message gathered so far, as one model response. */
function flushResponse(): void {
  const pending = state.pending;
  if (pending === undefined) return;
  state.pending = undefined;
  observe({
    _tag: "ModelResponded",
    turn: currentTurn(),
    provider: "anthropic",
    model: pending.model,
    parts: pending.blocks.map(part),
    stop: typeof pending.stop === "string" ? pending.stop : JSON.stringify(pending.stop),
    metadata: json({ id: pending.id, usage: pending.usage }),
  });
  const held = state.held.splice(0);
  for (const result of held) toolEnded(result);
}

function toolEnded(result: Record_): void {
  observe({
    _tag: "ToolEnded",
    call: str(result["tool_use_id"]),
    outcome:
      result["is_error"] === true
        ? { _tag: "Failed", reason: { _tag: "Reported", error: resultContent(result["content"]) } }
        : { _tag: "Succeeded", output: resultContent(result["content"]) },
  });
}

function resultContent(content: Json | undefined): unknown {
  return typeof content === "string" ? text(content) : json(content ?? null);
}

function onRecord(record: Record_): void {
  state.records += 1;
  const type = typeof record["type"] === "string" ? record["type"] : "<no type>";
  const message = record["message"];
  if (record["isSidechain"] === true) return count(`${type} (sidechain: a subagent)`);
  if (type === "assistant" && typeof message === "object" && message !== null && !Array.isArray(message)) {
    const m = message as Record_;
    const id = typeof m["id"] === "string" ? m["id"] : "";
    if (state.pending !== undefined && state.pending.id !== id) flushResponse();
    if (state.pending === undefined) flushReview();
    const blocks = Array.isArray(m["content"]) ? (m["content"] as Array<Json>) : [];
    state.pending = {
      id,
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
      state.held.push(...results);
      return;
    }
    flushResponse();
    const stopHook = record["isMeta"] === true && typeof content === "string" && content.startsWith("Stop hook feedback");
    if (!stopHook) flushReview();
    if (record["isCompactSummary"] === true) return count("user (compaction summary)");
    for (const result of results) toolEnded(result);
    // A meta message is shown to the model but was not typed by the user: a hook's feedback, a
    // message from another session, a command's output.
    const from = record["isMeta"] === true ? { _tag: "System" } : { _tag: "User" };
    if (input !== undefined) observe({ _tag: "InputArrived", from, text: input });
    const others = blocks.filter((b) => !["tool_result", "text"].includes(str((b as Record_ | null)?.["type"])));
    for (const other of others) count(`user block: ${str((other as Record_ | null)?.["type"])}`);
    return;
  }
  const subtype = typeof record["subtype"] === "string" ? `/${record["subtype"]}` : "";
  count(`${type}${subtype}`);
}

const lines = createInterface({ input: createReadStream(source), crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
  if (line.trim() === "") continue;
  try {
    onRecord(JSON.parse(line) as Record_);
  } catch (error) {
    count(`<unreadable line: ${error instanceof Error ? error.message.slice(0, 60) : "?"}>`);
  }
}
flushResponse();
flushReview();

const decided = new Map<string, number>();
for (const fact of state.facts as Array<{ _tag: string; decision?: { _tag: string } }>)
  if (fact._tag === "Decided" && fact.decision !== undefined)
    decided.set(fact.decision._tag, (decided.get(fact.decision._tag) ?? 0) + 1);

mkdirSync(outDir, { recursive: true });
const name = basename(source, ".jsonl");
writeFileSync(join(outDir, `${name}.facts.jsonl`), `${state.facts.map((fact) => JSON.stringify(fact)).join("\n")}\n`);
const report = {
  source,
  records: state.records,
  facts: state.facts.length,
  turns: state.turns,
  decisions: Object.fromEntries([...decided].sort((a, b) => b[1] - a[1])),
  unmapped: Object.fromEntries([...state.unmapped].sort((a, b) => b[1] - a[1])),
};
writeFileSync(join(outDir, `${name}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
