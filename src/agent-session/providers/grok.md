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
