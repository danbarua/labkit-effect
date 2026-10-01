# Grok (xAI)

What xAI's API takes and returns, as far as it matters to the adapters. The reference for the
Responses endpoint is https://docs.x.ai/developers/rest-api-reference/inference/responses.md, and
for compaction https://docs.x.ai/developers/advanced-api-usage/context-compaction.md.

The API key for testing is the keychain entry `labkit-xai`.

## Endpoints

Grok takes requests shaped for OpenAI's Chat Completions (`/v1/chat/completions`) and Responses
(`/v1/responses`) APIs; it also has a gRPC API and a WebSocket mode. Most of the Responses
request's optional parameters are OpenAI's, under OpenAI's names.

## Caching

Grok caches every request, and cannot be asked not to. A cache entry can be evicted at any time,
by server load or a restart. Requests that should read each other's cache are routed to the same
server by a conversation id:

- Chat Completions: the `x-grok-conv-id` HTTP header;
- Responses: the `prompt_cache_key` field in the request body;
- gRPC: `x-grok-conv-id` in the metadata.

What was read from the cache is reported in the usage. Chat Completions:

```json
{
  "usage": {
    "prompt_tokens": 125,
    "completion_tokens": 48,
    "total_tokens": 173,
    "prompt_tokens_details": { "text_tokens": 125, "audio_tokens": 0, "image_tokens": 0, "cached_tokens": 98 },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    }
  }
}
```

Responses:

```json
{
  "usage": {
    "input_tokens": 125,
    "output_tokens": 48,
    "total_tokens": 173,
    "input_tokens_details": { "cached_tokens": 98 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  }
}
```

In a stream, the first empty token is the cache lookup and prefill.

## Responses request parameters

- `instructions`: the system prompt, another way. It cannot be used with `previous_response_id`,
  where the previous response's system prompt is used.
- `max_output_tokens`: output and reasoning together; 128,000 when not given. (Of the providers
  here, only Anthropic requires the client to set an output limit.)
- `reasoning.effort`, or `reasoning_effort`, a non-standard alternative read only when `reasoning`
  is not given.
- `include`: extra output to return. `reasoning.encrypted_content` returns the reasoning, encrypted;
  there are tool-output options too. OpenAI's `message.output_text.logprobs` is accepted and
  ignored.
- `stream`: partial deltas as data-only server-sent events, ending with `data: [DONE]`. Off when not
  given.
- `tool_choice`: `none` (the model ignores the tools), `auto` (it decides), `required` (it must call
  one), or `{ "name": … }` to make it call that tool. `tools`: the tools the model may call, with
  JSON Schema for their input.
- `context_management`: directives such as compaction. Parsed, but not yet carried out.

A response's `status` is `completed`, `in_progress` or `incomplete`.

## Compaction

`POST /v1/responses/compact` takes the conversation to compact as `input`, the same shape as a
Responses request's, and returns one compaction item that stands in for all of it:

```json
{
  "id": "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A",
  "object": "response.compaction",
  "created_at": 1748895600,
  "model": "grok-4.7",
  "output": [{ "type": "compaction", "id": "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A", "encrypted_content": "<opaque blob>" }],
  "usage": {
    "input_tokens": 12000,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 800,
    "output_tokens_details": { "reasoning_tokens": 240 },
    "total_tokens": 12800,
    "dropped_message_count": 45
  }
}
```

The next request starts with the compaction item as returned, and the new user turn follows it:

```json
{
  "model": "grok-4.7",
  "input": [
    { "type": "compaction", "id": "cmp_abc123", "encrypted_content": "…" },
    { "role": "user", "content": "Based on our earlier conversation, what gives particles their mass?" }
  ]
}
```

The compaction output is not to be pruned or reordered: new turns go after it, never before. A
conversation that was compacted can be compacted again later, when it has grown long.

## What it did, measured with grok-4.7

The adapter reaches Grok through the Responses adapter (`xai-client.ts`). Chat Completions works as
well: its message carries `reasoning_content` as text, and a stream sends it in `delta`; the Chat
Completions adapter keeps it as `Unrecognised` and does not send it back.

- Streaming: the same events as OpenAI's (`response.output_item.done` for each item, then
  `response.completed` with the whole response), with `reasoning_summary_text.delta` events and a
  `sequence_number` on each. No `data: [DONE]` line ends a Responses stream.
- Reasoning: every response has a `reasoning` item with a `summary` and `encrypted_content`, whether
  or not `include` or `reasoning.summary` asks for them; `reasoning.summary` is ignored (the
  response says `detailed`). The summary reads as the reasoning itself. Grok reads the
  `encrypted_content` of a reasoning item sent back: without it, a request is counted as if the
  item were not there.
- Messages have no `phase`. A message sent back with `phase: commentary` is taken.
- Efforts: grok-4.5 to grok-4.7 take `minimal` to `xhigh` and refuse `none` and `max` with a 400;
  grok-4.20 and grok-build-0.1 refuse `reasoning.effort` of any value. `GET /v1/models` lists each
  model's efforts under `capabilities.reasoning_effort`. The adapter supports the latest three
  (4.5 to 4.7); their efforts are in `frontier.json`, and an effort a model does not take, thinking
  off included, is sent as the nearest it does.
- `max_output_tokens` limits the answer only. With 20, a response took 62 output tokens, 42 of them
  reasoning, and ended `incomplete` with the reason `max_output_tokens`. Streamed, the cut message
  has no `response.output_item.done`, the stream ends with `response.incomplete`, and the message is
  `incomplete` in that response, as OpenAI marks it; without streaming, the cut message is marked
  `completed`.
- `prompt_cache_retention` is accepted and ignored: the response does not echo it.
- Cache: each request reports about 1,152 cached tokens, the first one too; a one-line question
  counts 1,380 input tokens, so xAI adds a prefix of its own. Four conversations of about 7,000
  tokens, each growing over six requests, two with a `prompt_cache_key` and two without: of the 20
  requests after the first in each, 19 read 7,040 to 7,296 from the cache, and one (keyed) read only
  the 1,152. Another keyed conversation, with three seconds between requests, read 7,168 on one of
  its three later requests and 1,152 on the others. The same request sent twice in a row read only
  the 1,152 both times, keyed or not.
- Compaction: `/v1/responses/compact` took six items (a question, two reasoning items, a call, its
  output and the answer) and returned one `compaction` item with `dropped_message_count: 3`. A
  request starting with it and a new question counted 1,802 input tokens, against 3,049 for the
  items themselves, and answered from what was compacted. It takes `instructions` and `tools`, and
  answers as JSON when asked to stream. OpenAI's endpoint of the same name returns the user's
  messages and then a `compaction` item. Through the adapter (`openAiCompactions` with `xAiClient`), four
  messages became one `compaction` item, and a request that began with it as an `Unrecognised`
  part from `xai` answered three questions about what was compacted, at 1,551 input tokens.
- A compaction whose input ends with an answered question leaves Grok treating that question as
  unanswered. Compacting "13", "14", "15", "16" (user, assistant, user, assistant) and then sending
  "17" was answered "16\n18"; asked instead what it last replied, it said 16. In the FizzBuzz probe
  with `providerCompaction` after every FizzBuzz, grok-4.7 got 15 of 25 turns right: after each
  compaction it answered the number before as well, and it stopped calling the tool. OpenAI's
  compaction, in the same probe with gpt-5.5, got 25 of 25.
