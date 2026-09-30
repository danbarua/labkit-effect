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
    ...output.flatMap((item, output_index) =>
      item["status"] === "incomplete" ? [] : [{ type: "response.output_item.done", output_index, item }],
    ),
    { type: response["status"] === "incomplete" ? "response.incomplete" : "response.completed", response },
  ]);
}
