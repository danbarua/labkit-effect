/**
 * Live probe: does the Responses API accept a reasoning item sent back the way the OpenAI adapter
 * sends it (the item as received, then the `function_call` rebuilt without its item `id`)?
 *
 * Makes one tool-calling request with reasoning, then sends the tool output back: with the
 * reasoning item as received, without it, and (with `store: false`, where the item carries
 * `encrypted_content`) as received again.
 *
 *   OPENAI_API_KEY=... bun scripts/probes/reasoning-items.ts [model]
 */

const key = process.env["OPENAI_API_KEY"];
if (key === undefined || key === "") {
  console.error("OPENAI_API_KEY is not set");
  process.exit(2);
}
const model = process.argv[2] ?? "gpt-5.4-mini";

type Item = Record<string, unknown>;

const tools = [
  {
    type: "function",
    name: "add",
    description: "Adds two numbers.",
    parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
];
const question: Item = {
  role: "user",
  content: [
    {
      type: "input_text",
      text:
        "Of 1873, 4127, 2946, 6054, 3381 and 7519, exactly two are the smallest and largest primes in the list. " +
        "Work out which, then add those two with the tool.",
    },
  ],
};

async function send(input: ReadonlyArray<Item>, store: boolean) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, tools, input, store, reasoning: { effort: "medium" } }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function report(label: string, result: { status: number; body: Record<string, unknown> }) {
  const usage = result.body["usage"] as Record<string, unknown> | undefined;
  console.log(
    JSON.stringify({
      label,
      status: result.status,
      output: Array.isArray(result.body["output"]) ? (result.body["output"] as ReadonlyArray<Item>).map((i) => i["type"]) : null,
      cached: (usage?.["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"] ?? null,
      reasoningTokens: (usage?.["output_tokens_details"] as Record<string, unknown> | undefined)?.["reasoning_tokens"] ?? null,
      error: result.body["error"] ?? null,
    }),
  );
}

/** A function_call as the adapter sends it back: call_id, name and arguments, no item id. */
const rebuilt = (call: Item): Item => ({ type: "function_call", call_id: call["call_id"], name: call["name"], arguments: call["arguments"] });

async function probe(store: boolean) {
  const first = await send([question], store);
  report(`first (store: ${store})`, first);
  const output = first.body["output"];
  if (first.status !== 200 || !Array.isArray(output)) return;
  const items = output as ReadonlyArray<Item>;
  const reasoning = items.find((item) => item["type"] === "reasoning");
  const call = items.find((item) => item["type"] === "function_call");
  console.log(JSON.stringify({ store, reasoningKeys: reasoning === undefined ? null : Object.keys(reasoning) }));
  if (reasoning === undefined || call === undefined) {
    console.log("inconclusive: no reasoning item or no function call");
    return;
  }
  const result: Item = { type: "function_call_output", call_id: call["call_id"], output: "8892" };
  report(`reasoning as received (store: ${store})`, await send([question, reasoning, rebuilt(call), result], store));
  report(`reasoning left out (store: ${store})`, await send([question, rebuilt(call), result], store));
}

await probe(true);
await probe(false);
