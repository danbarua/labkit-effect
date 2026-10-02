/**
 * A whole response served as the stream a provider would send for it, so a test states the response
 * and the adapter under test reads it as it reads a real one.
 */

type Json = Record<string, unknown>;

const events = (all: ReadonlyArray<Json>): Response =>
  new Response(all.map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** The events that deliver one content block: its start, what fills it, and its stop. */
function blockEvents(block: Json, index: number): ReadonlyArray<Json> {
  const start = (content_block: Json) => ({ type: "content_block_start", index, content_block });
  const delta = (each: Json) => ({ type: "content_block_delta", index, delta: each });
  const stop = { type: "content_block_stop", index };
  switch (block["type"]) {
    case "text":
      return [start({ ...block, text: "" }), delta({ type: "text_delta", text: block["text"] }), stop];
    case "thinking":
      return [
        start({ ...block, thinking: "", signature: "" }),
        delta({ type: "thinking_delta", thinking: block["thinking"] }),
        delta({ type: "signature_delta", signature: block["signature"] }),
        stop,
      ];
    case "tool_use":
      return [start({ ...block, input: {} }), delta({ type: "input_json_delta", partial_json: JSON.stringify(block["input"]) }), stop];
    default:
      return [start(block), stop];
  }
}

/**
 * A Messages API response as its stream. With `cut`, the last block's stop is left out, as when the
 * response is cut short while that block is arriving; with `unstopped`, the stream ends without
 * `message_stop`.
 */
export function anthropicStream(response: unknown, options: { readonly cut?: boolean; readonly unstopped?: boolean } = {}): Response {
  const { content, stop_reason, ...message } = response as Json;
  const blocks = (content as ReadonlyArray<Json>).flatMap(blockEvents);
  return events([
    { type: "message_start", message },
    ...(options.cut === true ? blocks.slice(0, -1) : blocks),
    { type: "message_delta", delta: { stop_reason } },
    ...(options.unstopped === true ? [] : [{ type: "message_stop" }]),
  ]);
}

/**
 * A Responses API response as its stream: each output item as it is done (one marked incomplete is
 * never done), then the whole response.
 */
export function openAiStream(whole: unknown): Response {
  const response = whole as Json;
  const output = (response["output"] ?? []) as ReadonlyArray<Json>;
  return events([
    ...output.flatMap((item, output_index) => {
      if (item["status"] === "incomplete") return [];
      const content = (Array.isArray(item["content"]) ? item["content"] : []) as ReadonlyArray<Json>;
      const summary = (Array.isArray(item["summary"]) ? item["summary"] : []) as ReadonlyArray<Json>;
      // The text the item's content and summary parts hold, as the deltas that add it, in two pieces each.
      const halves = (text: unknown) => (typeof text === "string" ? [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))] : []);
      return [
        { type: "response.output_item.added", output_index, item: { ...item, ...(item["type"] === "message" ? { content: [] } : {}), ...(item["type"] === "reasoning" ? { summary: [] } : {}) } },
        ...(item["type"] === "message"
          ? content.flatMap((part, content_index) => halves(part["text"]).map((delta) => ({ type: "response.output_text.delta", output_index, content_index, delta })))
          : []),
        ...(item["type"] === "reasoning"
          ? summary.flatMap((part, summary_index) => halves(part["text"]).map((delta) => ({ type: "response.reasoning_summary_text.delta", output_index, summary_index, delta })))
          : []),
        { type: "response.output_item.done", output_index, item },
      ];
    }),
    { type: response["status"] === "incomplete" ? "response.incomplete" : "response.completed", response },
  ]);
}

/**
 * A Chat Completions response as its stream: a chunk with the role, its content and each other text
 * field in two pieces, each tool call by its index with its arguments in two pieces, a chunk with
 * the `finish_reason`, a chunk with the usage and no choices, and `[DONE]`.
 */
export function chatStream(whole: unknown): Response {
  const response = whole as Json;
  const choice = ((response["choices"] ?? []) as ReadonlyArray<Json>)[0] ?? {};
  const message = (choice["message"] ?? {}) as Json;
  const { role: _role, tool_calls, ...fields } = message;
  const { choices: _choices, usage, ...rest } = response;
  const chunk = (delta: Json, finish: unknown = null) => ({ ...rest, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
  const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
  const chunks: Array<Json> = [chunk({ role: "assistant" })];
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === "string") for (const piece of halves(value)) chunks.push(chunk({ [field]: piece }));
    else if (value !== null && value !== undefined) chunks.push(chunk({ [field]: value }));
  }
  ((tool_calls ?? []) as ReadonlyArray<Json>).forEach((call, index) => {
    const fn = (call["function"] ?? {}) as Json;
    const [first = "", second = ""] = halves(typeof fn["arguments"] === "string" ? fn["arguments"] : "");
    chunks.push(chunk({ tool_calls: [{ index, id: call["id"], type: "function", function: { name: fn["name"], arguments: first } }] }));
    chunks.push(chunk({ tool_calls: [{ index, function: { arguments: second } }] }));
  });
  chunks.push(chunk({}, choice["finish_reason"] ?? "stop"));
  if (usage !== undefined) chunks.push({ ...rest, object: "chat.completion.chunk", choices: [], usage });
  return new Response([...chunks.map((each) => `data: ${JSON.stringify(each)}\n\n`), ": keepalive\n\n", "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
