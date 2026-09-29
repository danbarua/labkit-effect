/**
 * Projects a Codex session file (a rollout under `~/.codex/sessions`) into a trajectory: its
 * records become our observations, the core decides what follows exactly as it does live, and the
 * facts it records are the trajectory. Every record kind the importer does not map is counted in a
 * report beside it.
 *
 *   bun scripts/trajectories/codex.ts <rollout.jsonl> [out-dir]
 *
 * The output is regenerated, never edited: change the importer or the core, then run it again.
 * The source file is only read.
 *
 * Mapping:
 * - `session_meta` is `SessionOpened`: the model is the first `turn_context`'s, asked through the
 *   header's `model_provider` (Codex's default provider, `openai`, when the header names none); the
 *   system prompt is the header's `base_instructions`. Codex does not record the tools a session
 *   is given in our shape, so none are recorded, and the report counts that;
 * - a subagent's session (a fork) starts with history copied from its parent before its first turn;
 *   those records are counted, not mapped;
 * - a user message is `InputArrived`: from the user when Codex marks its content as the user's text
 *   (or, for a record without that mark, when Codex also reports it as a UserMessage item), and
 *   from the system otherwise (instructions, environment context, plugin lists it adds). Developer
 *   messages (system prompts) are counted, not mapped;
 * - Codex names its turns (`task_started`): the turn is started, with Codex's id, at the first model
 *   item after it;
 * - the model items of one request (reasoning, assistant messages, tool calls) are one
 *   `ModelResponded`, ended by the `token_count` that follows them, by input, or by the turn's end:
 *   an assistant message's `output_text` is `Text`, a tool call is `ToolCall`, anything else
 *   (reasoning, a web search the provider ran) is `Unrecognised`. Codex records no stop reason, and
 *   its older versions do not mark which message is the final answer, so the response is classified
 *   by what Codex did next: `Complete` when it has a tool call or a message marked as the final
 *   answer, or when the turn ended or input came next; `CutShort` when Codex asked the model again.
 *   Tool outputs recorded before the response is complete are given after it;
 * - a tool call's output is `ToolEnded` with `Succeeded`: Codex records no failure flag;
 * - after a final answer the core asks `BeforeTurnEnded`; it is answered (`TurnEndReviewed`) at the
 *   next record that is not input to the same turn;
 * - `turn_aborted` is `TurnInterrupted`;
 * - `compacted` is a `CompactionWindow`: its window ids are Codex's, and nothing is kept by position.
 *   Its replacement history is the window's summary, kept apart from the facts (`summaries.jsonl`). Codex asks the model for the summary in the turn, and records
 *   its answer as a final answer; a response whose text the replacement history carries is that
 *   request, part of the compaction, and is counted, not mapped.
 */

import { basename } from "node:path";
import {
  eachRecord,
  type Imported,
  isRecord,
  type Json,
  json,
  projection,
  type Record_,
  str,
  text,
  writeTrajectory,
} from "./project.ts";

const modelItems = new Set(["message", "reasoning", "custom_tool_call", "function_call", "tool_search_call", "web_search_call"]);
const toolOutputs = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);

export async function importCodex(source: string): Promise<Imported> {
  const projected = projection();
  const { count } = projected;
  const records: Array<Record_> = [];
  eachRecord(source, (record) => records.push(record), count);

  // Texts Codex reports as the user's own messages.
  const userTexts = new Set(
    records.flatMap((record) => {
      const payload = record["payload"];
      if (!isRecord(payload) || payload["type"] !== "item_completed" || !isRecord(payload["item"])) return [];
      const item = payload["item"];
      if (item["type"] !== "UserMessage" || !Array.isArray(item["content"])) return [];
      return item["content"].flatMap((block) => (isRecord(block) && typeof block["text"] === "string" ? [block["text"]] : []));
    }),
  );

  /**
   * The first model the record names, in a `turn_context` or in the settings a `thread_settings_applied`
   * event reports: the model the session's first turn asks.
   */
  const firstModel = (): string | undefined =>
    records.flatMap((record) => {
      const payload = record["payload"];
      if (!isRecord(payload)) return [];
      if (record["type"] === "turn_context" && typeof payload["model"] === "string") return [payload["model"]];
      const settings = payload["type"] === "thread_settings_applied" ? payload["thread_settings"] : undefined;
      return isRecord(settings) && typeof settings["model"] === "string" ? [settings["model"]] : [];
    })[0];

  const state = {
    turns: 0,
    /** The turn Codex last started. */
    turn: undefined as string | undefined,
    model: "unknown",
    /** Whether a `session_meta` has been read. */
    session: false,
    /** The session's id, once it is opened. */
    opened: undefined as string | undefined,
    pending: [] as Array<Record_>,
    /** The usage a `token_count` reported for the pending response; set once the response is complete. */
    usage: undefined as Json | undefined,
    /** Tool outputs recorded while their response was still arriving, given after it. */
    held: [] as Array<Record_>,
    /** A turn whose `BeforeTurnEnded` is not answered yet. */
    review: undefined as string | undefined,
  };

  function observe(raw: unknown): number {
    const { seq, requests } = projected.observe(raw);
    for (const request of requests) if (request._tag === "BeforeTurnEnded") state.review = request.turn;
    return seq;
  }

  const running = (): string | undefined => {
    const agent = projected.world().agent.state;
    return agent._tag === "Running" ? agent.turn : undefined;
  };

  function flushReview(): void {
    const turn = state.review;
    if (turn === undefined) return;
    state.review = undefined;
    observe({ _tag: "TurnEndReviewed", turn });
  }

  function part(item: Record_): ReadonlyArray<unknown> {
    const type = item["type"];
    if (type === "message" && Array.isArray(item["content"]))
      return item["content"].map((block) =>
        isRecord(block) && block["type"] === "output_text" && typeof block["text"] === "string"
          ? { _tag: "Text", text: block["text"] }
          : { _tag: "Unrecognised", received: json(block) },
      );
    if (type === "custom_tool_call")
      return [{ _tag: "ToolCall", call: str(item["call_id"]), tool: str(item["name"]), input: text(str(item["input"])) }];
    if (type === "function_call")
      return [
        {
          _tag: "ToolCall",
          call: str(item["call_id"]),
          tool: str(item["name"]),
          input: { mediaType: "application/json", body: { _tag: "Text", text: str(item["arguments"]) } },
        },
      ];
    if (type === "tool_search_call")
      return [{ _tag: "ToolCall", call: str(item["call_id"]), tool: "tool_search", input: json(item["arguments"] ?? null) }];
    return [{ _tag: "Unrecognised", received: json(item) }];
  }

  /**
   * The model items gathered so far, as one response. `askedAgain` says whether Codex's next act was
   * another request to the model, which makes a response with no tool call and no final answer one
   * that was cut short.
   */
  function flushResponse(askedAgain = false): void {
    const items = state.pending.splice(0);
    const usage = state.usage ?? null;
    state.usage = undefined;
    if (items.length === 0) return;
    const parts = items.flatMap(part);
    const complete =
      !askedAgain ||
      items.some((item) => item["type"] !== "message" && item["type"] !== "reasoning" && item["type"] !== "web_search_call") ||
      items.some((item) => item["type"] === "message" && item["phase"] === "final_answer");
    observe({
      _tag: "ModelResponded",
      turn: running() ?? state.turn ?? "",
      provider: "openai",
      model: state.model,
      parts,
      ending: { _tag: complete ? "Complete" : "CutShort" },
      metadata: json({ items: items.map((item) => item["id"] ?? null), usage }),
    });
    for (const output of state.held.splice(0)) toolEnded(output);
  }

  function toolEnded(output: Record_): void {
    const result = output["type"] === "tool_search_output" ? output["tools"] : output["output"];
    observe({
      _tag: "ToolEnded",
      call: str(output["call_id"]),
      outcome: { _tag: "Succeeded", output: typeof result === "string" ? text(result) : json(result ?? null) },
    });
  }

  function userInput(payload: Record_): void {
    const content = Array.isArray(payload["content"]) ? payload["content"] : [];
    const texts = content.flatMap((block) =>
      isRecord(block) && block["type"] === "input_text" && typeof block["text"] === "string" ? [block["text"]] : [],
    );
    for (const block of content)
      if (!isRecord(block) || block["type"] !== "input_text") count(`user block: ${isRecord(block) ? str(block["type"]) : "?"}`);
    if (texts.length === 0) return;
    const input = texts.join("\n");
    const meta = payload["internal_chat_message_metadata_passthrough"];
    const kinds = isRecord(meta) && Array.isArray(meta["content_item_kinds"]) ? meta["content_item_kinds"] : undefined;
    const fromUser = kinds === undefined ? userTexts.has(input) : kinds.every((kind) => kind === "user.text");
    const sameTurn = isRecord(meta) && state.review !== undefined && meta["turn_id"] === state.review;
    if (!sameTurn) flushReview();
    observe({ _tag: "InputArrived", from: { _tag: fromUser ? "User" : "System" }, text: input });
    if (sameTurn) flushReview();
  }

  function onRecord(record: Record_): void {
    projected.readAt(record["timestamp"]);
    const type = str(record["type"]);
    const payload = isRecord(record["payload"]) ? record["payload"] : {};
    const kind = str(payload["type"]);
    if (type === "session_meta") {
      if (state.session) return count("session_meta (another in the same file)");
      state.session = true;
      const model = firstModel();
      if (model === undefined) return count("session_meta (no record names a model)");
      const instructions = payload["base_instructions"];
      const system = isRecord(instructions) ? instructions["text"] : undefined;
      if (payload["model_provider"] === undefined) count("session opened on Codex's default provider, openai");
      count("session opened without its tools (not in the record)");
      observe({
        _tag: "SessionOpened",
        session: str(payload["id"]),
        model: { provider: typeof payload["model_provider"] === "string" ? payload["model_provider"] : "openai", model },
        ...(typeof system === "string" ? { system: text(system) } : {}),
      });
      state.opened = str(payload["id"]);
      return;
    }
    if (state.turn === undefined && (type === "response_item" || type === "compacted" || type === "event_msg") && kind !== "task_started")
      return count(`${type}${kind === "" ? "" : `/${kind}`} before the first turn (copied from the session forked from)`);
    if (type === "turn_context") {
      if (typeof payload["model"] === "string") state.model = payload["model"];
      return count("turn_context (the model is read from it)");
    }
    if (type === "response_item" && kind === "message" && payload["role"] === "developer")
      return count("developer message (a system prompt)");
    if (type === "response_item" && kind === "message" && payload["role"] === "user") {
      flushResponse();
      return userInput(payload);
    }
    if (type === "response_item" && modelItems.has(kind)) {
      if (state.held.length > 0 || state.usage !== undefined) flushResponse(true);
      flushReview();
      if (running() === undefined && state.turn !== undefined) {
        state.turns += 1;
        observe({ _tag: "TurnStarted", turn: state.turn });
      }
      state.pending.push(payload);
      return;
    }
    if (type === "response_item" && toolOutputs.has(kind)) {
      if (state.pending.length > 0) state.held.push(payload);
      else toolEnded(payload);
      return;
    }
    if (type === "event_msg" && kind === "token_count") {
      if (state.pending.length > 0) state.usage = payload["info"] ?? null;
      return;
    }
    if (type === "event_msg" && kind === "task_started") {
      flushResponse();
      flushReview();
      state.turn = str(payload["turn_id"]);
      return;
    }
    if (type === "event_msg" && kind === "task_complete") {
      flushResponse();
      flushReview();
      if (running() !== undefined) count(running() === str(payload["turn_id"]) ? "task_complete while the turn still runs" : "task_complete while another turn runs");
      return;
    }
    if (type === "event_msg" && kind === "turn_aborted") {
      flushResponse();
      flushReview();
      const turn = running();
      if (turn === undefined) return count("turn_aborted before the model was asked");
      observe({ _tag: "TurnInterrupted", turn });
      return;
    }
    if (type === "compacted") {
      const history = JSON.stringify(payload["replacement_history"] ?? null);
      const written = state.pending.flatMap((item) =>
        Array.isArray(item["content"])
          ? item["content"].flatMap((block) => (isRecord(block) && typeof block["text"] === "string" ? [block["text"]] : []))
          : [],
      );
      if (written.length > 0 && written.every((line) => history.includes(JSON.stringify(line).slice(1, -1)))) {
        state.pending.splice(0);
        state.usage = undefined;
        count("the model's summary for a compaction");
      }
      flushResponse();
      flushReview();
      if (!projected.begun()) return count("compacted (nothing before it in the file)");
      const previous = payload["previous_window_id"];
      const window = str(payload["window_id"]);
      observe({
        _tag: "CompactionWindow",
        window,
        ...(typeof previous === "string" ? { previous } : {}),
        through: projected.recorded(),
        kept: [],
      });
      if (state.opened === undefined) count("compaction summary kept nowhere (the session was not opened)");
      else projected.summarise({ session: state.opened, window, summary: json(payload["replacement_history"] ?? null) });
      return;
    }
    count(kind === "" ? type : `${type}/${kind}`);
  }

  for (const record of records) {
    try {
      onRecord(record);
    } catch (error) {
      count(`<record not mapped: ${error instanceof Error ? error.message.slice(0, 60) : "?"}>`);
    }
  }
  flushResponse();
  flushReview();
  return projected.imported(source, records.length, state.turns);
}

if (import.meta.main) {
  const [source, outDir = "trajectories/codex"] = process.argv.slice(2);
  if (source === undefined) throw new Error("usage: bun scripts/trajectories/codex.ts <rollout.jsonl> [out-dir]");
  const imported = await importCodex(source);
  writeTrajectory(outDir, basename(source, ".jsonl"), imported);
  console.log(JSON.stringify(imported.report, null, 2));
}
