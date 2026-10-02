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

## What is not built

- The handlers, the launcher and the stdio and HTTP hosts.
- The host's own updates: `usage_update`, `session_info_update`, `available_commands_update`,
  `config_option_update`, `current_mode_update`, `plan`; and `session/request_permission`.
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
