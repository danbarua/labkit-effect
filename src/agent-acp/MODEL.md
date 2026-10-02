# agent-acp

The ACP host: it joins the protocol (`src/acp`) to a session of the core. It imports both; `src/acp`
imports nothing of the core.

## What is built

- `projection.ts`: the pure projection of a session to ACP's `session/update`, for the live view and
  for `session/load` (`src/agent-host/DESIGN.next.md`, "Projection"). `next(state, input, context)`
  takes one input and gives the updates it makes and the state to take the next from; `project`
  folds it over many, from `start` or a state given. An input is a fact, a part a streaming response
  completed (`ModelPartArrived`), or a `Delta`: the text of a part as it arrives, by turn, response
  (the step, from 1) and part index (from 0, as `ModelResponded` holds the parts). The core does not
  produce deltas yet; the host adapts what the provider's stream gives. The context is the mode
  (`live` or `replay`) and the host's presentation of tool calls (`present(call, outcome?)`);
  `presentFrom(catalog)` is the default, over the session's catalog (`immutableToolCatalogOf`).

| Input | ACP update |
|---|---|
| `InputArrived` | `user_message_chunk`, in `replay` only: live, the client has what it sent |
| `Delta` of `text` | `agent_message_chunk` with the delta's text |
| `Delta` of `thinking` | `agent_thought_chunk` with the delta's text |
| `ModelPartArrived`, `ModelResponded`: a `Text` or `Commentary` part | `agent_message_chunk` with what of the part no delta sent |
| the same: a `Thinking` part | `agent_thought_chunk` with what of the part no delta sent |
| `ToolCallArrived`; a `ToolCall` part of `ModelPartArrived` or `ModelResponded` | `tool_call`, `pending`, with the presentation's title, kind, locations and content; once a call |
| `PermissionAsked` | `tool_call_update`, `pending` |
| `ToolCallDispatched` | `tool_call_update`, `in_progress` |
| `ToolEnded` | `tool_call_update`, `completed` (`Succeeded`) or `failed`, with the presentation's content and locations, and its title and kind where they differ from the announcement |
| anything else | nothing |

- `config-options.ts`: a configuration (`optionsFor`, `optionsOf`) as ACP's config options, and a
  `session/set_config_option` as the change it asks. `configOptions(options, models, limit)` gives
  the selects; `models` are the catalog's (`askable`), `limit` the model's output limit (none known:
  every preset). `changeOf(configId, value, options, models, limit)` gives a `Change` (what
  `ModelChangeArrived` carries, which a draft takes too) or an `InvalidChange` saying why, which the
  host answers with -32602.

| id | category | values |
|---|---|---|
| `model` | `model` | `provider/model` of each model offered, and of the one asked now |
| `effort` | `thought_level` | the efforts the model takes |
| `thinking` | `model_config` | the thinking modes the model takes |
| `observe` | `model_config` | how much thinking the model returns, of those it takes |
| `cache` | `model_config` | the cache lifetimes the model takes |
| `max_output_tokens` | `model_config` | 4096, 8192, 16384, 32768, 65536, 128000 up to the model's limit; the limit; the value in force |

Each setting's option offers `not_sent` while nothing is sent for it (it is unsaid, or the adapter
sends nothing for what was said).

- `permission.ts`: `requestOf(sessionId, call, question, presented)` is the
  `session/request_permission` for a `PermissionAsked`; `answerOf(response, question)` is the
  answer `PermissionAnswered` records (`answerPicking`), or an `InvalidAnswer`.
- `stop-reason.ts`: `stopOf(facts, turn)`, the answer to the `session/prompt` that began `turn`: a
  `stopReason`, or a JSON-RPC error; none before the turn ends.
- `usage.ts`: `usageUpdate(facts)`, the `usage_update` of the session (`contextGauge`), with what
  `KnownModels` knows of the model it asks now.

## What is not built

- The handlers, the launcher and the stdio and HTTP hosts.
- The host's own updates but for `usage_update` and the config options: `session_info_update`,
  `available_commands_update`, `current_mode_update`, `plan`.
- An input's attachments on load, and `messageId` on chunks.
- What a reopened session shows as a tool call's content (the default shows its output as text).

## Rules

- PJ1. Live and replay are one projection with a mode. On replay each input is a
  `user_message_chunk`; live, inputs give nothing.
- PJ2. A response's answer text (`Text`, `Commentary`) is sent as `agent_message_chunk`, its
  thinking as `agent_thought_chunk`: each delta as it comes, then, when the part is whole
  (`ModelPartArrived`, or the response's `ModelResponded`), what of the part no delta sent. The text
  sent for a part, joined, is the part's text; live with deltas, with parts and with neither sends
  the text a replay of the facts does.
- PJ3. A part's text is never sent twice. A part whose deltas stopped part way gets the rest when it
  is whole; a delta for a part already whole, or for a response already recorded, gives nothing.
- PJ4. A tool call is announced once, as `tool_call` `pending`, by the first of `ToolCallArrived`,
  its part in `ModelPartArrived` and its part in `ModelResponded`; a response recorded after the
  call ended does not announce it again.
- PJ5. A call's status follows its facts: `PermissionAsked` is `pending`, `ToolCallDispatched`
  `in_progress`, and `ToolEnded` `completed` when it succeeded and `failed` otherwise. A call a policy
  vetoed fails and is never `in_progress`.
- PJ6. What a call shows is the host's presentation: announced, its title, kind, locations and
  content; ended, the presentation with the outcome gives the content and locations, and the title
  and kind where they changed. The default presentation is the tool's name, its kind from the
  session's catalog, and, once ended, its output as text, or why it failed in words.
- PJ7. An interrupted response keeps what was sent of it: the parts its `ModelResponded` holds are
  made whole, and the text of a part it does not hold, sent while it streamed, is not taken back.
- PJ8. Projecting the stored facts gives the state to go on from live: what was shown on load is not
  shown again.
- AA1. The config options are `model`, then one select for each setting the options offer, with
  the ids and categories of the table; a setting not offered has none. Every option's current value
  is among its values: the model asked now is offered even when the catalog does not list it.
- AA2. A setting's current value is what the model will get (the option's `now`): an effort beyond
  the model's highest shows the nearest it takes, which is offered; the effort said is not. Where
  nothing is sent for a setting, its value is `not_sent`, offered only then.
- AA3. The output limit offers the presets up to the model's limit, the limit, and the value in
  force even beyond the limit, least first.
- AA4. `changeOf` is the inverse of `configOptions`: each value offered, taken as a change, gives a
  configuration whose option has that value now. A change names only what was chosen, the model or
  the one setting (a change keeps the settings it does not name); `not_sent` while current changes
  nothing. A model value is `provider/model` split at its first slash, so a model's name keeps its
  own slashes.
- AA5. A value the option does not offer, or an id no option has, is an `InvalidChange` saying why.
- AA6. A permission request is the call as the host presents it, `pending`, with its input as
  `rawInput` and, where the presentation has none, the question's kind; its options are exactly the
  question's, by id, name and kind.
- AA7. A selected option is the answer that picks it. A `cancelled` response is the question's
  reject-once option: the call is refused, nothing is remembered for the session, and the turn goes
  on. An option the question did not offer, or a cancel where no option rejects once, is an
  `InvalidAnswer`.
- AA8. A turn's stop: `Completed` and `Incomplete` are `end_turn`, `CutShort` `max_tokens`,
  `Interrupted` `cancelled`; `Vetoed` is `max_turn_requests` when the reason's JSON has
  `stop: "max_turn_requests"`, and otherwise an error (-32603) carrying the reason as text; `Failed`
  is an error carrying the failure. Whatever the ending, a turn whose last response was `Refused` is
  `refusal`. A turn not ended has no stop.
- AA9. `usage_update` is the gauge of the model the session asks now: the visible tokens of the
  last exchange, the model's window as `KnownModels` knows it, and the cost so far; none for a model
  whose window is not known.
