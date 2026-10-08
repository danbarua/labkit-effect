# agent-acp

`src/agent-acp` is the ACP host: an agent of ACP protocol v1 whose sessions run on the core. It joins
the protocol package (`effective-acp`) to sessions of `agent-session`, with the services that
`agent-host` provides. It imports both; `effective-acp` imports nothing of the core.

Dan's rulings about the hosts, their layers, and what is planned are in
[agent-host-direction.md](agent-host-direction.md). What is not built is in `TODO.md`.

## Files

| File | Responsibility |
| --- | --- |
| `host.ts` | `makeHost(options)`: the protocol's handlers, and each session the connection holds. `acpDefaults`: the host's configuration layer. |
| `feed.ts` | An open session's live view: the facts and the streamed items, projected and sent; permission questions asked of the client. |
| `projection.ts` | The pure projection of a session's facts and streamed items to `session/update`. |
| `world.ts` | A session's world: its system prompt, its tools, and how their calls are shown. `editorWorld`, `workspaceWorld`. |
| `config-options.ts` | A configuration as ACP's config options, and `session/set_config_option` as the change it asks. |
| `permission.ts` | `session/request_permission` for a `PermissionAsked`, and the answer that the client's response gives. |
| `stop-reason.ts` | `stopOf`: a turn's ending as the answer to the prompt that began it. |
| `usage.ts` | `usageUpdate`: the session's `usage_update`. |
| `session-record.ts` | What the host keeps in a session's record (`host.json`), and the pages of `session/list`. |
| `log-keys.ts` | The names of the events the host logs. |
| `main.ts` | The launcher: the host on this process's stdin and stdout. |

## Layers

| Layer | Where | Imports |
| --- | --- | --- |
| Core | `agent-machine`, `agent-policy`, `agent-session`, `agent-context` | no host and no protocol |
| Host services | `agent-host` | the core; no protocol |
| ACP | `effective-acp` (a package of its own) | nothing of the core |
| ACP host | `agent-acp` | `effective-acp`, `agent-host` and the core |
| CLI | `examples/cli-repl` | `agent-host`; never `agent-acp` |

## What the host advertises

`initialize` answers with:

- `loadSession`, and the session methods `close`, `list` and `resume`;
- prompt content: text, resource links, images and embedded resources (`image`, `embeddedContext`);
  not audio;
- MCP over HTTP and SSE (`mcpCapabilities`); not MCP over ACP;
- no `fork`, because the core has no identity for a fork yet; no auth methods.

## A session's lifetime

The connection holds each session it made or started. A session is a draft until its first prompt,
then open.

| Request | What the host does |
| --- | --- |
| `session/new` | Mints the id, reads the configuration, opens the world, starts the MCP servers, and makes a draft. Writes nothing. |
| `session/set_config_option` | Changes the draft, or, on an open session, submits the change to the configuration gate. |
| `session/prompt` | Opens a draft (turn zero), then runs the turn. `/export` and `/mcp` are answered without the model. |
| `session/cancel` | Interrupts the turn under way. |
| `session/load`, `session/resume` | Starts a stored session from its facts file. |
| `session/list` | Lists the stored sessions that have the host's record. |
| `session/close` | Interrupts the turn under way, waits for its prompt, and closes the session's scope. |

The same id is ACP's `sessionId` and the core's `SessionId`: one id with two lifetimes. A draft that
never gets a prompt leaves nothing on disk, so `session/list` lists only sessions that had a turn.

The host advertises `sessionCapabilities.additionalDirectories`. The `additionalDirectories` of
`session/new`, `session/load` and `session/resume` are folders that count as inside the working
folder, after those of the launcher's `--add-dir` and before the settings' `additionalDirectories`:
for the permission policy (`docs/agent-policy.md`), for the file tools, which take a path inside
any of them (`inWorkspace`), and in the system text, which names them. Each must be an absolute path, as `cwd` must,
or the request is refused (-32602, naming it). A new session's are kept in its record.

### `session/new`

- A `cwd` that is not absolute is refused (-32602).
- With no model to ask, the request fails (-32603) and names the variables to set or the local server
  to start. The model comes from `HostOptions.model` (`provider/model`), else the configuration's
  `model`, else the catalog's first.
- The session's configuration is read (see Configuration), the world is opened for `cwd`, and the
  MCP servers are started at once.
- The draft holds the model, its settings, the system prompt and the tools. Its output limit is
  defaulted to the model's own (`withDefaults`).
- The answer carries the session's id and its config options. After the answer is written, the
  host sends `available_commands_update` with `/export` and `/mcp`.

### Turn zero: the first prompt

The first `session/prompt` opens the draft:

1. The host writes the session's record (`host.json`): the working folder, and a title from the
   first prompt's text. A record that cannot be written fails the prompt (-32603), and the session
   stays a draft.
2. The host writes `effective-settings.json`: what the configuration resolved to, with the model,
   the permission mode and the world.
3. The session starts over `FileBackedSessionStore` of its folder's `facts.jsonl`, in a scope of
   its own. The feed starts before anything is recorded, so it sends everything from the opening.
4. The host records `SessionOpened` with the draft's model, settings, system prompt and tools, from
   the user through ACP.
5. The host sends `session_info_update` with the title (`null` when there is none) and the time as
   `updatedAt`.

The prompt is then the turn's input, from the same origin. A prompt's input is:

- the text of its text blocks;
- each resource link as a Markdown link in the text;
- each image and embedded resource stored in the blob store (the brand's `blobs/` folder, which
  every session and host shares) and attached by reference, with its media type and the name its URI
  ends in. A session made before blobs were kept there also reads the `blobs/` in its own folder.

### A prompt

- One prompt runs at a time. A prompt to a session that has one running is refused (-32000, "already
  has an active prompt").
- A request that names a session the connection does not hold is refused (-32002).
- The feed sends the turn's updates, `usage_update` among them (The feed). Once the feed has taken
  the turn's facts, the host answers the prompt with the turn's stop (`stopOf`).
- `/export`, alone in a prompt, writes the session's transcript (`markdownOf`) to
  `<cwd>/.<brand>/exports/<sessionId>.md`, says where in an `agent_message_chunk`, and answers
  `end_turn` without asking the model. On a draft it says that there is nothing to export, and
  opens nothing.
- `/mcp`, alone in a prompt, says how each MCP server is. `/mcp reconnect <server>` starts one again
  and says how it went and whether its tools are offered. Both are answered without the model.

### A turn's stop

| Ending | Answer to the prompt |
| --- | --- |
| `Completed`, `Incomplete` | `end_turn` |
| `CutShort` | `max_tokens` |
| `Interrupted` | `cancelled` |
| `Vetoed`, with a reason whose JSON has `stop: "max_turn_requests"` | `max_turn_requests` |
| `Vetoed`, otherwise | a JSON-RPC error (-32603) carrying the reason as text |
| `Failed` | a JSON-RPC error (-32603) carrying the failure |
| any ending, when the turn's last response was `Refused` | `refusal` |

A turn that has not ended has no stop. After a failed turn the session takes the next prompt.

A stop of `max_tokens` or `refusal` is explained by a `notice` (`noticeOf`, `stop-reason.ts`), sent
after every other update of the turn, its `usage_update` included, and before the answer. It is
built from the turn's last response and the session's settings, and says only what they record:

| Stop | `title` | `description` |
| --- | --- | --- |
| `max_tokens` | The reply was cut short | The model; `stopped at a length limit` when the response's ending was `CutShort`, otherwise (not classified, not observed) `stopped before finishing its reply`; the output tokens the response used, when reported; the output limit the request was sent with, when the session's settings for that model give one (an adapter's own default is not recorded, and is not stated); the provider's stop reason. |
| `refusal` | The model declined to continue | The model; the provider's stop reason; each refusal text the response carries (a field named `refusal`, as OpenAI's APIs send it), quoted. |

For example: `openai/gpt-6-sol stopped at a length limit after 4,096 output tokens. The request set
the output limit to 4,096 tokens. The provider's stop reason: max_tokens.`

Its `severity` is `warning`. ACP lets an agent send a notice only to a client that advertised
`clientCapabilities.session.notices` (`effective-acp` refuses one otherwise): a client that did not
is sent none, logged at DEBUG, and gets the same answer. A notice is a live event, not history:
`session/load` replays none. No other stop, and no turn that ends with an error, has a notice.

### Cancel and close

- `session/cancel` records `TurnInterrupted` for the turn under way (`Session.cancel`). The turn ends
  `Interrupted` and its prompt `cancelled`. A prompt request that the client cancels
  (`$/cancel_request`) cancels its turn the same way. The session then takes the next prompt.
- `session/close` cancels the turn under way, waits for its prompt (which ends `cancelled`), and
  closes the session's scope, which ends its MCP servers. A later request that names it is -32002.
- When the connection ends, every session's scope closes. A turn under way is left running in the
  facts: nothing records `TurnInterrupted` or `TurnEnded`. The host does not end it, because the
  core allows a turn to be left running and the next load ends it.

## Load, resume and list

### `session/load` and `session/resume`

1. The request is refused when:
   - `cwd` is not absolute (-32602);
   - the connection holds the session already (-32602, "already loaded");
   - the session directory holds no facts file for it (-32002, with its `sessionId`);
   - its store cannot be opened, such as a facts file open in another process or one that does
     not read (-32000, carrying the store's message). Nothing is left open, so the session loads
     once the cause is gone.
2. The configuration is read for `cwd` and the client's MCP servers, the world is opened, and the
   servers are started.
3. The session starts over its facts, with the model, system prompt and tool catalog that they hold.
   The record keeps the working folder it had.
4. A turn that the facts left running is ended (`endTurnLeftRunning`): it ends `Interrupted`, each
   request under way receives what is known of it, no tool runs, and no model request is made. The
   editor that closed mid-turn is not watching, and what the turn had begun should not run unseen.
5. `session/load` sends the facts as the projection replays them, before its answer. `session/resume`
   sends nothing: the client has the history.
6. The feed starts from the state the replay leaves, so nothing replayed is sent again.
7. With no turn left running, the session goes on (`goOn`), so input left waiting starts its turn
   live.
8. The host writes `effective-settings.json`, then answers with the session's config options.
   effective-acp (0.4.0) adds `_meta["effective-acp/replayed"]` to a `session/load` answer: the
   number of updates sent before the answer, which an effective-acp client waits for before its
   load completes. The key works around a gap in ACP v1's HTTP transport, and is dropped when
   labkit moves to ACP v2.
9. After the answer, the host sends `available_commands_update`, `session_info_update` (the record's
   title, `null` when it has none or it does not read, and when the facts file was last written)
   and, through the feed, `usage_update`, unless the feed has sent the same numbers since it started.

A loaded session's permission mode starts at the configuration's mode, as a new session's does. The
mode a session had when it was closed is not kept.

The replay shows the requests that were answered as live showed them, with the message ids and the
calls' names, inputs and outputs that live sent, and each call left running `failed`. A request that
was in flight adds only the calls that had arrived in it, because the text and thinking it streamed
were never recorded. ACP has no update for how a turn ended, so a turn whose only request was in
flight, with no call arrived, shows its input alone.

### `session/list`

- A page lists the stored sessions whose record reads, the one written to last first, and by id among
  those written at the same time. Given `cwd`, only those made for it are listed.
- Each session is listed as its `SessionInfo`: its id, working folder, additional folders (when it
  was made with any), title and when its facts were last written.
- A page holds at most `pageSize` sessions (50 unless the host is given another; at least one), and
  `nextCursor` when more follow. A cursor continues after the session its page ended with, so each
  session comes once and one written to meanwhile is not repeated.
- A session with no record (the CLI made it) is not listed, and loads by its id.
- A cursor that `session/list` did not give is refused (-32602, naming it). A session directory that
  cannot be read is -32603 with the cause.

### The record

`host.json` holds what the host keeps of a session (`session-record.ts`): the working folder and,
when the first prompt gives one, a title. `agent-host` stores and returns the record as JSON and
does not read it. A record that is not one, or has no working folder, reads as none.

A title is the first prompt's text trimmed, with each run of whitespace made one space, cut after
120 characters, never inside a character. When no text is left, there is no title.

## Configuration

A session's configuration is read when `session/new`, `session/load` or `session/resume` makes it,
in layers (`docs/agent-host.md`, Launch options):

1. the host's defaults (`acpDefaults`);
2. the user's file;
3. the working folder's files, when `--setting-sources` names them. The working folder counts as
   trusted (`agent-host/trust.ts`): the editor opened the session in a workspace that it trusts, and
   that trust is the boundary. So these files are the user's own and may name extensions and MCP
   servers;
4. the launcher's `--settings`, `--mcp-config` and flags;
5. the MCP servers the client names. Each replaces the configuration's server of its name whole.

A configuration that cannot be used refuses the request (-32603), naming the layer at fault. The
configuration's seam lists are the session's, except its tool sources: the session's tools are the
world's and its MCP servers'. Its `commandEnvironment` is what a command run on the local disk is
given.

The host's defaults:

| Seam | Entry |
| --- | --- |
| `toolCalls` | `permissions` |
| `modelRequests` | `maxTurnRequests`, 1000 unless the launcher says otherwise (`--max-turns`) |
| `turnEnd` | `retryIncomplete`, asked `retries` times (1 unless `--retries` says otherwise); none when `retries` is 0 |
| `commandEnvironment` | `credentials`: the environment without its credentials |

A turn whose response had thinking and no answer (`Incomplete`) is asked again for its answer, by
default once. An answer then reaches the client as `agent_message_chunk`, and the prompt ends
`end_turn`. The hook's feedback is input from the system, so it is not sent to the client.

## Config options

`configOptions(options, models, limit)` gives the selects of a configuration; `models` are the
catalog's (`askable`), and `limit` is the model's output limit (none known: every preset).

| id | category | values |
| --- | --- | --- |
| `model` | `model` | `provider/model` of each model offered, and of the one asked now |
| `effort` | `thought_level` | `default`, and the efforts the model takes |
| `thinking` | `model_config` | `default`, and the thinking modes the model takes |
| `max_output_tokens` | `model_config` | `default`; 4096, 8192, 16384, 32768, 65536, 128000 up to the model's limit; the limit; the value in force |
| `permission_mode` | `mode` | `default`, `acceptEdits`, `bypassPermissions`, `dontAsk` |

- `model` comes first, then one select for each setting the options offer, then `permission_mode`.
  A setting that is not offered has no option.
- `observe` and `cache` have no option. The editor shows each option as a select above the prompt,
  and a session keeps what it was configured with for those two.
- Every option's current value is among its values: the model asked now is offered even when the
  catalog does not list it.
- A setting's current value is what the model will get (the option's `now`). For example, an effort
  above the model's highest shows the nearest effort the model takes, and the effort asked for is
  not offered.
- Where nothing is sent for a setting, its value is `default`, which every setting offers.
- The output limit offers the presets up to the model's limit, the limit itself, and the value in
  force even when it is above the limit, smallest first.

`changeOf(configId, value, options, models, limit)` is the inverse of `configOptions`:

- Each value offered, taken as a change, gives a configuration whose option has that value now.
- A change names only what was chosen: the model, or the one setting. A change keeps the settings it
  does not name.
- Choosing `default` returns the setting to the provider's default.
- A model value is found among the values offered, not split, because a local model's name can hold
  slashes.
- A value that the option does not offer, or an id that no option has, is an `InvalidChange`, which
  the host answers with -32602 and sends nothing.

### When a change applies

- On a draft, a change applies at once (`chooseModel`, `withSettings`).
- On an open session, a change goes through the session's configuration gate
  (`agent-session/configuration/gate.ts`). Between turns it is made at once: the model change is
  recorded as `ModelChangeArrived` from the user through ACP. While a turn runs it is held until the
  turn ends, so the model that started the turn completes it.
- The gate is settled when a prompt's turn ends and before a prompt starts one.
- The answer is every option as the configuration will be, held changes included. The same options
  are sent as `config_option_update`, because a client may draw its controls from updates alone.
- On an open session, `config_option_update` is sent once the feed has taken what the change
  recorded. A model changed between turns is taken at once (`ModelChangeTaken` is decided with
  `ModelChangeArrived`), so its `usage_update`, with the new model's window, comes just before
  `config_option_update`, and both before the answer. A model change held while a turn runs is taken
  when the gate is settled after that prompt's answer, and its `usage_update` is sent then.

### The permission mode

The host keeps each session's permission mode:

- It starts as the session's configuration says: the `mode` of the `permissions` entry that its tool
  calls list, which the launcher's `--permission-mode` sets; else `default`.
- A change goes through the gate as a change of model does.
- Every `permissions` entry that the configuration lists follows it (`FromHost.permissionMode`),
  including one with a `mode` of its own. Every other tool call policy still decides with it.
- A value that is not a mode is refused (-32602).

## The projection

`projection.ts` is one pure, incremental function from a session's facts and streamed items to
`session/update`, for the live view and for `session/load`. `next(state, input, context)` takes one
input and gives the updates and the state to take the next input from. `project` folds it over many
inputs, from `start` or a given state. The context is the mode (`live` or `replay`) and the host's
presentation of tool calls.

The inputs are facts (`session.subscribe`) and the items that a model request passes on while it
runs (`session.streamed`): `ModelDelta`, `ModelPartArrived` and `ModelResponseEnded`.

| Input | Update |
| --- | --- |
| `InputArrived` from the user | `user_message_chunk`, on replay only: live, the client has what it sent. Its text, then a `resource_link` for each file it carried (`blob://<id>.<extension>`, with the file's name, media type and size), in the same message |
| `InputArrived` from the system (a turn-end hook's feedback) or another agent | nothing |
| `ModelDelta` of `Text` or `Commentary`, live | `agent_message_chunk` with the delta's text |
| `ModelDelta` of `Thinking`, live | `agent_thought_chunk` with the delta's text |
| `ModelResponded`: a `Text` or `Commentary` part | `agent_message_chunk` with the part's text that no delta of its request sent |
| `ModelResponded`: a `Thinking` part | `agent_thought_chunk` with the part's text that no delta of its request sent |
| `ToolCallArrived`; a `ToolCall` part of `ModelPartArrived` or `ModelResponded` | `tool_call`, `pending`, with the presentation's title, kind, locations and content, the tool's name (`name`) and the call's input (`rawInput`); once for each call |
| `PermissionAsked` | `tool_call_update`, `pending` |
| `PermissionAnswered` | `tool_call_update` with `_meta["labkit.dev/permission"]`: the outcome as ACP's `RequestPermissionOutcome` gives it, live and on replay alike. A selected option is `{ outcome: "selected", optionId, name, kind }`, without `name` and `kind` when the question did not offer it; a cancelled request is `{ outcome: "cancelled" }`. ACP has no field for it, and a replay asks no question, so a client shows a replayed call's answer from it. The key follows labkit's own (`labkit.dev/baseline`, `labkit.dev/failure`). A call that was asked and ends with no answer recorded (its turn was cancelled or interrupted first) is sent `{ outcome: "cancelled" }` before its `ToolEnded` update. |
| `PermissionFailed` | nothing: ACP has no outcome for a request that failed. The call's `ToolEnded` update says why it did not run. |
| `ToolCallDispatched` | `tool_call_update`, `in_progress` |
| `ToolEnded` | `tool_call_update`, `completed` when it succeeded and `failed` otherwise, with the presentation's content and locations, its title and kind where they changed, and what it returned or why it failed (`rawOutput`) |
| anything else | nothing |

Each text chunk carries the id of its message (`messageId`, Message ids).

### Text is sent once

- Live, each delta is sent as it arrives, and `ModelResponded` sends the text of each part that the
  deltas of its request did not send. With no deltas (a client that does not stream, a response that
  arrives whole), `ModelResponded` sends the whole parts. On replay there are no deltas.
- The text sent for a response, joined, is the text of its parts: live with deltas, live without,
  and on replay.
- The deltas of a request cover its parts of their kind in order, across several parts of one kind.
- A delta of a request whose `ModelResponded` was taken first gives nothing, and so does anything
  streamed for a turn after its `TurnEnded`: the facts sent that text.
- A response that was stopped keeps what was sent of it. Its `ModelResponded` holds its complete
  parts only, so what the deltas sent of a part that the stream cut is not taken back, and nothing
  is sent again.
- A failed request has no `ModelResponded`. What its deltas sent stays sent, and the projection
  forgets it when the turn ends.
- Text of only whitespace is held until it is known whose it is, then sent in its own message. Text
  after it in the same message is sent with it. The end of its part (`ModelPartArrived`), a call, or
  another message beginning sends it as the end of the open message, under that message's id. Still
  held when its request ends or its response is taken, it is sent from the response's parts. A part
  of only whitespace is not sent, live or on replay, so a client shows no blank message. Each
  message's text is the same live and on replay.
- A streamed item taken before its request's `ModelRequestDispatched` (or its `ModelResponded`)
  waits in the state, and is taken once that fact is, because its message's id comes from it. The
  loop records the dispatch before the request goes out, so live, items seldom wait.

### The order of the two feeds

The facts and the streamed items have no order between them: a request's deltas can come before or
after its `ModelResponded`, and either feed can be any number of requests or turns ahead. Each feed
keeps a turn's requests in order, so the projection pairs a request's `ModelResponseEnded` with its
`ModelResponded` by position in the turn. Every merge of the two sends each response's text once.

### Message ids

Each text chunk carries `messageId`, the id of the message it belongs to. ACP: "All chunks belonging
to the same message share the same `messageId`. A change in `messageId` indicates a new message has
started." An id the provider does not give, labkit gives; for messages, the projection derives it from
the session's journal, so it is the same every time the journal is read: `session/load` sends the ids
that live sent, and a reloaded session's later turns take ids that no earlier message has, from the
journal's later seqs. An id generated in the projection (Effect's `IdGenerator` makes random ones)
would differ on each replay, and keeping one would need a fact of its own. The providers' ids are not
used: Effect's Anthropic adapter numbers a response's blocks from "0" in every response, and OpenAI's
item ids are global.

| Message | Id |
| --- | --- |
| A user's input (`InputArrived`), on replay | its seq: `"7"` |
| A run of text of one kind (`Text`, `Commentary` or `Thinking`) in one response, until a call or text of another kind | `"<seq of the request's first ModelRequestDispatched>:<the run's place among the response's runs>"`: `"12:0"` |

- A response's thinking and its text are two messages; so are its text before a call and its text
  after it, and two responses with nothing between them (a turn asked again after an unfinished
  response). Consecutive parts of one kind (a response's text in several blocks) are one message.
- A part with nothing to show (blank text, or a part the decoder did not recognise) neither begins
  nor ends a message.
- A request is dispatched before it streams, so its deltas, the rest of a part that its response
  sends, and the part on replay have the same id, in every merge of the feeds.
- A fallback (`model-fallback.ts`) records a dispatch for each attempt, and the request keeps its first
  dispatch's seq. When the attempt that failed streamed nothing (an HTTP 503 or 429 before the
  response began), live and replay give the same ids. When it had streamed text, the streamed items
  have no end for that attempt: live, its text and the fallback's are taken as one response, in the
  text sent and in the ids, and replay has the fallback's alone (TODO.md).
- A response with no `ModelRequestDispatched` before it, which the loop does not record, is named by
  its own seq, and a warning says so.
- What `/export` and `/mcp` say (`agent_message_chunk`) is not in the journal and carries no id.

### Replay order

Stored facts record a request's tool calls as they arrive, and the calls may have ended before the
request's `ModelResponded`, which holds the whole response. Live, the response's thinking and text
were sent as they streamed, before the calls. On replay, `project` takes each `ModelResponded`
before the first `ToolCallArrived` of its request (`inLiveOrder`), so the replay sends the response's
parts in order, each call announced at its place among them, then what became of the calls. Nothing
is added or dropped, and the state it leaves is the same.

Live with no deltas, the updates are the same, except that a call's announcement comes before its
response's text, which is known only when the response ends.

Projecting the stored facts gives the state that the live feed continues from, with no reset: what
the load showed is not shown again, and a later request's deltas are sent once.

### Tool calls

- A call is announced once, as `tool_call` `pending`, by the first of `ToolCallArrived`, its part in
  `ModelPartArrived` and its part in `ModelResponded`. A response recorded after the call ended does
  not announce it again.
- A call's status follows its facts. A call that a policy vetoed fails, and is never `in_progress`.
- What a call shows is the host's presentation (`Present`): announced, its title, kind, locations and
  content; ended, the presentation with the outcome gives the content and locations, and the title
  and kind where they changed.
- The default presentation (`presentFrom(catalog)`) is the tool's name as the title, its kind from
  the session's catalog, and, once it ends, its output as text, or why it failed in words.
- A call's `tool_call` carries the tool's name as the model called it (`name`) and the call's input
  (`rawInput`). A later source that holds another input sends it as `rawInput` on a
  `tool_call_update`, and the call keeps it.
- A call's end carries `rawOutput`: what the tool returned; for a failure, its recorded reason (the
  tool's error, the policy's veto, why its input was rejected). A call that named no tool, was not
  run, or whose end was not observed has none: nothing more is recorded than its content says.
- `rawInput` and `rawOutput` are the content as the facts hold it (`rawOf`): JSON, by its media type,
  as its value; other text as its text. Bytes (a tool's image in the blob store) have none: JSON
  cannot carry them. The content names them, and links to them with a `resource_link`
  (`blob://<id>.<extension>`) that a client can resolve to the bytes. Content that claims JSON and does not parse is
  carried as its text, and a warning says so.
- `rawOutput` repeats what the default presentation's content gives as text, so a large output is
  sent twice in its call's end: a `read_file` of 256 KiB makes an update of about 512 KiB. Neither is
  cut.

## The feed

`feed.ts` is an open session's live view:

- It subscribes to the facts and to `streamed` before anything is given to the session, so nothing of
  a turn is missed.
- It merges the two into the projection (`live`), from `start` or from the state a load gives, and
  sends each update in the order the projection gives.
- Each `PermissionAsked` is asked of the client as `session/request_permission`, in a fiber of its
  own so the updates go on. The answer is recorded as `PermissionAnswered`; a request that fails, as
  `PermissionFailed`.
- It is the one sender of the session's `usage_update` (`usage.ts`), sent when the numbers can
  change: as it takes a `ModelResponded` (used, cost), a `ModelChangeTaken` (size) and a `TurnEnded`
  (whatever ended the turn), after that fact's own updates. The update reflects the facts through
  the one taken, not later ones, so the client sees the numbers in the order they came. `usage`
  sends it when the host asks (after a load or a resume). An update with the numbers last sent to
  the client is not sent again; the first always is.
- `caughtUp` completes once the feed has taken every fact the session has when it is asked: by then
  each of their updates has been sent, so a prompt answers after its turn's updates, its usage among
  them. A fact that could not be projected counts as taken.
- A defect while projecting one input is logged, and the feed goes on with the next.

### Permission

- The request (`requestOf`) is the call as the host presents it, `pending`, with its input as
  `rawInput`, as the call's `tool_call` carried it (`rawOf`), and, where the presentation has no
  kind, the question's kind. Its options are exactly the question's, by id, name and kind.
- The answer is recorded as the client gives it (`answerOf`): the option selected, or `cancelled`.
  ACP has the client answer `cancelled` when the turn that asked was cancelled. A `cancelled` answer
  vetoes the call, the model is told that the question was cancelled before it was answered, and
  nothing is remembered for the session. When the client answers `cancelled` without cancelling the
  turn, the turn goes on, and the model decides what to do next.
- A request that the client fails, or a connection that closes, leaves the question without an
  answer. That is recorded as `PermissionFailed`, with what failed, and logged as a warning; no
  option is recorded. The policy vetoes the call, and the model is told that the question could not
  be asked, and why. The call is sent no permission outcome, because ACP has none for it.
- An answer that selects an option the question did not offer is recorded as the client gave it,
  and logged as a warning. The policy vetoes the call. The outcome sent with the call is
  `{ outcome: "selected", optionId }`, without a name or kind.
- A call that ends while its question is still out (its turn was cancelled) has its request
  cancelled.

## Worlds

A world (`world.ts`) is what the host does not know of a session. Given the session's id, its working
folder, the client's MCP servers, the connection, whether tool input is strict, and the command
environment, a world gives the session's system prompt, its tool sources (`ToolSource`) and their
presentation (`Present`). A host can give a world of its own (`HostOptions.world`).

Both worlds below send one line of system prompt, which names the working folder
(`workingFolderLine` in `agent-tools/workspace.ts`). Their tool descriptions refer to "the working
folder" without naming it. Each tool input has a description that states what it means, whether it
is optional, and its default. The descriptions and limits shared with the workspace tools come from
`agent-tools/workspace.ts`.

### `editorWorld`, the default

The tools go through the editor. Each is offered only when the client advertised the methods it
uses, so no call meets a capability the client does not have. Each tool is a value
(`editor-tools.ts`) that asks for the `Editor` service, which the world provides: the editor is the
environment the tools run in. Every tool takes an `intent` input (`agent-tools/described.ts`), and
the file tools' paths are resolved against the working folder (`agent-tools/in-workspace.ts`).

| Tool | Kind | Offered when the client advertised | What it does |
| --- | --- | --- | --- |
| `read_file { path, line?, limit? }` | `read` | `fs.readTextFile` | Reads with `fs/read_text_file`, so the model sees the editor's unsaved buffers. A result over 256 KiB is cut there, with a note. |
| `write_file { path, content }` | `edit` | `fs.writeTextFile` | Writes with `fs/write_text_file`; at most 256 KiB. |
| `edit_file { path, old_text, new_text }` | `edit` | both `fs` methods | Reads the file, replaces the one occurrence of `old_text`, and writes it back. |
| `terminal_command { command, timeout_seconds? }` | `execute` | `terminal` | Runs `sh -c <command>` in an editor terminal in the working folder. |
| `update_plan { entries }` | `think` | always | Sends the whole plan as a `plan` update. |

- A path is relative to the working folder, or absolute. A path outside the working folder is
  refused with a failure the model reads, and the editor is not asked.
- `edit_file` refuses `old_text` that occurs never or more than once, and writes nothing.
- `terminal_command` waits for the command's exit until its time runs out (120 seconds unless the call
  gives `timeout_seconds`, at most 600), reads its output (the last 256 KiB), and releases the
  terminal however the call ends, which stops a command still running. Exit code 0 succeeds; any
  other end fails, with the output and how it ended for the model to read.
- The editor has no method to list or search a folder, so `terminal_command` does both.
- When the working folder is the root of a git repository (it holds `.git`), the session is also
  offered the git tools of `agent-tools/git.ts` (`git_status`, `git_diff`, `git_add`, `git_commit`
  and the others), bound to that repository, and the system prompt says that the working folder is
  the repository's root. This holds in both worlds. The git tools work on the disk, not through the
  editor: `git_add` stages what is saved, not an unsaved buffer, and `git_restore`, `git_reset` and
  `git_checkout` change files without the editor being told. A working folder below a repository's
  root is offered no git tools. `git_push` and `git_pull` are given no credential, so a remote that
  needs one fails, and the call's result says why.
- `update_plan` gives an entry the priority `medium` unless it gives one, and succeeds with the count
  of steps by status. Its kind is `think`, so it runs in every permission mode without asking.
- `write_file` and `edit_file` ask permission in the default mode. `terminal_command` is a command
  tool: each program its command runs is judged, and a read-only one such as `ls` runs without a
  question (`docs/agent-policy.md`, Command tools).
  The permission request for a command adds to the call's content a text block naming each program
  that needs permission and why.
- A call whose input has properties its tool does not take runs without them, and its result names
  them; with `--strict-tool-input` it is refused.
- A call's title is its intent. A call without one, recorded before its tool took an intent, is
  titled with its command or its path (`terminal_command: ls`, `edit_file: a.txt`). A permission question
  also carries the call's whole input as `rawInput`, so the command or the path that will be used is
  in the question whatever the title says; whether the editor shows `rawInput` is the editor's
  choice. A path is the call's location. An edit's call shows its change as a `diff`, from when
  permission is asked; a command's call shows its `terminal` from when it has one, and when it has
  ended.
- A call that ended having recorded the files it changed (`FileChanged`: `write_file`, `edit_file`)
  shows them from what it recorded, live and on a replay alike (`changedFiles`), followed by its
  output: a created file as a `diff` from no text (`oldText: null`), an updated file as one `diff`
  for each hunk of its patch, whose texts are the hunk's lines with three lines of context, not the
  whole file. A patch that was cut at 32 KiB is followed by a note of how many bytes are not shown. A call recorded
  before calls kept what they changed shows the `edit_file` input's texts, as before it ended.
- A command that writes text to a file where its words show the text (`cat > f <<'EOF'`,
  `echo x >> f`, `tee f <<< x`; `agent-host/command-writes.ts`) shows each such file's `diff` in its
  call: from when it is announced, in its permission question, and after it succeeds. The file's text
  before is read once, before the command runs: by `terminal_command` itself, or when the call is
  first presented, whichever comes first. Whether the file exists is read from the disk; its text,
  through `fs/read_text_file`, so an unsaved change in the editor counts. A file that does not exist
  has no text before (`oldText: null`). When the text before cannot be read (the read fails, the
  file is over 256 KiB, a `cd` comes first in the command), the call says why no diff is shown, and
  the permission question shows the text the command writes. A note follows a diff whose text the
  shell expands (`$…`) before writing it. A command that succeeds records each such file it changed
  (`FileChanged`), from its text on the disk just before the command ran and once it has run, so the
  diff is of what the command wrote, `$…` expanded. The command writes the disk, not the editor's
  buffer, so when the editor has unsaved changes to the file, the diff in the question (from the
  editor's text) and the diff recorded (from the disk) differ. Once the call has ended,
  live and on a replay alike, it shows those diffs, and says what it wrote of each file it recorded
  nothing of (`Wrote config.yml.`, `Added to the end of notes.md.`): its text before was not known,
  a `cd` came first, or the call was recorded before commands kept their writes.

### `workspaceWorld`

A stopgap: the workspace tools of `agent-tools/workspace.ts` on the local disk under the working
folder (`--local-tools`). It bypasses the editor, so the model does not see unsaved buffers and the
editor is not told of writes.
Each of its tools takes an `intent` input (`agent-tools/described.ts`). A call's title is that
intent on one line. A call to a tool that `described` did not wrap, such as an MCP tool, is titled
with the tool's name, even when the tool has an input of its own named `intent`.

## MCP servers

- A session's MCP servers are its configuration's, the client's among them. They are started when
  `session/new`, `session/load` or `session/resume` makes the session, at once
  (`docs/agent-mcp.md`), in the session's scope, which `session/close` closes.
- A server has `mcpConnectTimeout` (30 seconds unless the host is given another) to connect.
- The tools of the servers that are ready are offered after the world's, under `mcp__<server>`. A
  call is shown with its result as the model is sent it (`agent-session/tool-output.ts`).
- Servers at a URL are connected over Streamable HTTP or HTTP+SSE, with the headers given. Closing
  the session ends its session at the server.
- The servers are told the brand's name and version (`clientInfo`).
- Once the session opens, it records each server's state and each change of it (`McpServerChanged`,
  from the harness part "mcp servers").
- A server that cannot be started, or does not connect, leaves the session running. The model is
  told it is not running, and its tools are not offered.
- A server the configuration says is required (`required: true`) that is not running once the
  servers have settled refuses the request (-32603), naming it and saying how it is. The servers are
  stopped, and nothing of the session is left open.
- Two servers whose tools would be offered under one name are refused (-32602) before anything is
  started.
- A server over ACP (`type: acp`) is refused (-32602) by `effective-acp`, because the host does not
  offer it.

## The host's own updates

The projection does not make these; the host sends them:

| Update | When |
| --- | --- |
| `available_commands_update` | After `session/new`, `session/load` and `session/resume` answer: `/export` and `/mcp`. |
| `session_info_update` | At turn zero, and after a load or a resume. |
| `usage_update` | Sent by the feed when its numbers can change: after each response, a change of model taken and a turn's end (before the prompt's answer), and after a load or a resume; never twice in a row with the same numbers. The gauge of the model the session asks now (`contextGauge`), with the model's window as `KnownModels` knows it, and the cost so far: the priced responses' total. While no response of the session was priced (a local model's are not), it has no `cost`, because a cost not known is not nothing spent. None for a model whose window is not known. |
| `config_option_update` | After each `session/set_config_option`. |
| `plan` | From `update_plan`. |
| `notice` | Before the answer to a prompt that stops with `max_tokens` or `refusal`, to a client that advertised notices (A turn's stop). |

## Logs

The host logs each event under `log-keys.ts`, with the ids it is about as log annotations:
`connection` (minted per connection), `request` (set by the peer), `session`, `turn` and `call`.

- Logged at INFO: a session created, opened, loaded, resumed, listed and closed; a record written; a
  turn left running ended; a prompt received, admitted and settled (its stop reason, and its
  duration); a notice sent (its stop reason and title); a cancel requested; a permission asked and
  answered; a change of configuration; an export written.
- A routine turn and a routine load log no warning or error.
- Logged as a warning, with the cause: a refused request; a session not stored; a bad cursor; a
  permission request that failed; a settled prompt that answers with an error; a call's input or
  output that claims JSON and does not parse; a response whose request has no dispatch.
- Logged as an error, with the cause: a store that cannot be opened; a session directory that cannot
  be read; a draft that cannot be opened; an export that cannot be written.

## The launcher

`main.ts` runs the host on this process's stdin and stdout (`Agent.runStdio`):
`bun src/agent-acp/main.ts [flags]`.

- It puts nothing but the protocol on stdout. What the command line prints goes to stderr.
- Its log is a file (`agent-host/launcher-logs.ts`), named once on stderr, which holds no secret of
  the environment. It exits 0 when stdin closes.
- It calls itself by its brand's name and version (`agentInfo`). The brand is the one `launch` is
  given, else the one the environment names, else labkit's.
- The model catalog is the keyed providers' and the local server's (`KeyedAndLocalCatalog`).
- Its options are those both hosts take (`docs/agent-host.md`, Launch options) and its own:

  | Flag | Default | Meaning |
  | --- | --- | --- |
  | `--sessions-dir` | `~/.local/share/<brand>/sessions/<version>` | Where sessions are kept: a folder shared with the CLI, of which `session/list` lists the sessions that the ACP host made. It moves the sessions alone: blobs and logs stay in the brand's folders, which `--data-dir` moves (`agent-host.md`, The brand's folders). |
  | `--local-tools` | off | The tools on the local disk instead of through the editor. |
  | `--retries` | 1 | How many times an incomplete turn is asked again for its answer; 0 never. |

- A flag not given is read from its variable: the brand's prefix, `ACP_`, then the flag's name in
  capitals (`LABKIT_ACP_MODEL`, `LABKIT_ACP_SESSIONS_DIR`). The launcher reads only its own brand's
  variables. The log's variables are `<PREFIX>ACP_LOG_*`.
- Before it serves, it loads what of a session's configuration no session's folder changes: the
  host's defaults, the user's file, `--settings`, `--mcp-config` and the flags. An option the launcher
  does not take (`LABKIT_ACP_PERMISSION_MODE=yolo`), or a configuration that cannot be used
  (`LABKIT_ACP_MAX_TURNS=0`), ends it with exit code 1, said on stderr, with nothing on stdout.

## Design decisions

- **No core session before turn zero.** The draft lives in the host until the first prompt, so a
  session that never had a turn leaves nothing on disk. Dan: "Until then, core's got no reason to be
  journalling facts."
- **A turn left running is ended at load, not continued.** The editor that closed mid-turn is not
  watching, and what the turn had begun should not run unseen.
- **One projection for live and replay.** The two differ only in the mode, so a loaded session and a
  live one show the same text, and the live feed continues from the replay's state. A file a call
  changed is shown from the patch the call recorded, never from the file as it is now. Before a call
  has ended, live shows what the call is about to do (an edit's input, a command's writes read from
  the files), which a replay has no call for.
- **Tool calls go through the editor.** The model then sees unsaved buffers, and the editor shows and
  controls what changes. `workspaceWorld` is a stopgap that bypasses it.
- **A cancelled permission request is recorded as cancelled.** ACP's `cancelled` says that the turn
  was cancelled, not that the user refused, so it is not recorded as an option selected. The call
  does not run.
- **The connection's end leaves a turn running.** The host does not end it; the next load does.

## Tests

| File | Covers |
| --- | --- |
| `host.test.ts` | The handlers, against the SDK's client: sessions, prompts, cancel, close, load, resume, list, config options, permission, MCP servers, the editor's tools, logs. |
| `projection.test.ts` | The projection, live and replay, every merge of the two feeds, message ids, and each call's name, input and raw output. |
| `config-options.test.ts` | Config options and changes. |
| `permission.test.ts` | Permission requests and answers. |
| `stop-reason.test.ts` | Stop reasons, and the notices that explain `max_tokens` and `refusal`. |
| `usage.test.ts` | `usage_update`. |
| `session-record.test.ts` | Titles, records, and the pages of `session/list`. |
| `main.test.ts` | The launcher: stdout, the log file, flags and variables, refused configurations. |
