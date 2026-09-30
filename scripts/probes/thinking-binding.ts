/**
 * Live probe: does thinking sent back the way the Anthropic adapter sends it stay valid, and does a
 * mid-conversation `system` message (a notice) that is not kept in later requests invalidate it?
 *
 * Makes one tool-calling request, then sends the tool result back twice: once with the notice kept
 * where it was, once with it dropped and a new notice at the end, as `AgentContextAssembler` does.
 * Both follow-ups set `prefix_mismatch_behavior: "error"`, so a thinking block that fails the check
 * fails the request with a 400.
 *
 *   ANTHROPIC_API_KEY=... bun scripts/probes/thinking-binding.ts [model]
 */

const key = process.env["ANTHROPIC_API_KEY"];
if (key === undefined || key === "") {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(2);
}
const model = process.argv[2] ?? "claude-fable-5-1";

type Block = Record<string, unknown>;
type Message = { role: string; content: string | ReadonlyArray<Block> };

const system = "You are a calculator. Use the add tool for every sum.";
const tools = [
  {
    name: "add",
    description: "Adds two numbers.",
    input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
];
const thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } };

/** Sends with the check set to `error`, or, with `binding` false, as the adapter does: no beta, no binding field. */
async function send(messages: ReadonlyArray<Message>, binding = true) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key as string,
      "anthropic-version": "2023-06-01",
      ...(binding ? { "anthropic-beta": "thinking-binding-controls-2026-08-01" } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      tools,
      ...(binding ? { thinking } : {}),
      messages,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The blocks as the adapter sends them back: text, thinking and tool_use rebuilt; anything else verbatim. */
function asSentBack(content: ReadonlyArray<Block>): ReadonlyArray<Block> {
  return content.map((block) => {
    switch (block["type"]) {
      case "text":
        return { type: "text", text: block["text"] };
      case "thinking":
        return { type: "thinking", thinking: block["thinking"], signature: block["signature"] };
      case "tool_use":
        return { type: "tool_use", id: block["id"], name: block["name"], input: block["input"] };
      default:
        return block;
    }
  });
}

function report(label: string, result: { status: number; body: Record<string, unknown> }) {
  const transformations = result.body["input_transformations"];
  console.log(
    JSON.stringify({
      label,
      status: result.status,
      stop_reason: result.body["stop_reason"],
      input_transformations: Array.isArray(transformations) ? transformations : transformations ?? null,
      error: result.body["error"] ?? null,
    }),
  );
}

const question: Message = {
  role: "user",
  content:
    "Of 1873, 4127, 2946, 6054, 3381 and 7519, exactly two are the smallest and largest primes in the list. " +
    "Work out which, then add those two with the tool.",
};
const notice = (at: string): Message => ({ role: "system", content: `The current time is ${at}.` });

const first = await send([question, notice("2026-09-30T10:00:00Z")]);
report("first", first);
const content = first.body["content"];
if (first.status !== 200 || !Array.isArray(content)) process.exit(1);
const blocks = content as ReadonlyArray<Block>;
console.log(JSON.stringify({ blocks: blocks.map((block) => block["type"]), thinkingEmpty: blocks.some((b) => b["type"] === "thinking" && b["thinking"] === "") }));
const call = blocks.find((block) => block["type"] === "tool_use");
if (call === undefined || !blocks.some((block) => block["type"] === "thinking")) {
  console.log("inconclusive: the first response has no thinking block or no tool call");
  process.exit(1);
}
const reply: Message = { role: "assistant", content: asSentBack(blocks) };
const result: Message = { role: "user", content: [{ type: "tool_result", tool_use_id: call["id"], content: "5555" }] };

report("notice kept in place", await send([question, notice("2026-09-30T10:00:00Z"), reply, result]));
report("notice dropped, new one at the end", await send([question, reply, result, notice("2026-09-30T10:00:05Z")]));
report(
  "notice dropped, sent as the adapter sends it",
  await send([question, reply, result, notice("2026-09-30T10:00:05Z")], false),
);
