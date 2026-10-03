# agent-acp

The ACP host: it joins the protocol (`src/acp`) to a session of the core. It imports both; `src/acp`
imports nothing of the core.

## What is built

- `projection.ts`: the pure projection of a session to ACP's `session/update`, for the live view and
  for `session/load` (`src/agent-host/DESIGN.next.md`, "Projection"). `next(state, input, context)`
  takes one input and gives the updates it makes and the state to take the next from; `project`
  folds it over many, from `start` or a state given. An input is a fact (`session.subscribe`) or what
  a model request passes on while it runs (`session.streamed`, `CapturedObservation`): `ModelDelta`
  (a part's text as it arrives, by kind), `ModelPartArrived`, and `ModelResponseEnded`, the last item
  of every request. A host merges the two feeds as they come; there is no order between them. The
  context is the mode (`live` or `replay`) and the host's presentation of tool calls
  (`present(call, outcome?)`); `presentFrom(catalog)` is the default, over the session's catalog
  (`immutableToolCatalogOf`).

| Input | ACP update |
|---|---|
| `InputArrived` from the user | `user_message_chunk`, in `replay` only: live, the client has what it sent. An input from the system (a turn-end hook's feedback) or another agent gives nothing |
| `ModelDelta` of `Text` or `Commentary`, live | `agent_message_chunk` with the delta's text |
| `ModelDelta` of `Thinking`, live | `agent_thought_chunk` with the delta's text |
| `ModelResponded`: a `Text` or `Commentary` part | `agent_message_chunk` with what of the part no delta of its request sent |
| the same: a `Thinking` part | `agent_thought_chunk` with what of the part no delta of its request sent |
| `ToolCallArrived`; a `ToolCall` part of `ModelPartArrived` or `ModelResponded` | `tool_call`, `pending`, with the presentation's title, kind, locations and content; once a call |
| `PermissionAsked` | `tool_call_update`, `pending` |
| `ToolCallDispatched` | `tool_call_update`, `in_progress` |
| `ToolEnded` | `tool_call_update`, `completed` (`Succeeded`) or `failed`, with the presentation's content and locations, and its title and kind where they differ from the announcement |
| anything else (`ModelStreamed`, `ModelPartArrived` of text, `ModelResponseEnded`) | nothing |

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
- `session-record.ts`: what the host keeps of a session in its record (`agent-host/record.ts`,
  `host.json`): `recordFor(cwd, firstPrompt)` is the working folder and the title (`titleOf`) the
  first prompt's text gives; `readSessionRecord` reads one back, or nothing when it is not one.
  `pageOf(stored, request, size)` is one page of `session/list`, or an `InvalidCursor`.

## The host

`host.ts`: `makeHost(options)` is an agent of protocol v1 (`Agent.implement`) whose sessions run on
the core; a launcher runs it with `Agent.run` or `Agent.runStdio`, giving it the model catalog
(`ModelCatalog`) and the file system. `HostOptions`: `directory`, the session directory's root;
`world`, `"editor"` (the default), `"local"` or a world of the host's own; `model`, `provider/model`
to start sessions with (else the catalog's first, `defaultModel`); `services`, what a session runs
with given its world's runner (`HostSessionServices`: `SessionServices` with `RetryIncomplete(1)`,
agent-host H15); `pageSize`, the most sessions a page of `session/list` gives (50).
`hostOptionsFrom(env)` reads `LABKIT_ACP_MODEL` and `LABKIT_ACP_LOCAL_TOOLS=1`. It advertises
`loadSession`, the session methods `close`, `list` and `resume`, and no prompt content but text and
resource links; no fork and no auth methods.

A session is started, at turn zero or from its facts file by `session/load` or `session/resume`,
the same way: in a scope of its own forked from the connection's, over `FileBackedSessionStore` of
its facts file, with the services its world's runner gives and `PermissionsFor("default", true)`,
and with a feed. Turn zero starts the feed before the opening is observed. Load and resume start
it from the state the stored facts leave in the projection, after the replay, so nothing is sent
twice.

- `world.ts`: the `World` is what the host does not know of a session. `open({ sessionId, cwd,
  mcpServers, connection })` gives its system prompt, its tools (`ToolSpec`), the `ToolRunner` that
  runs them and their presentation (`Present`). `editorWorld` (the default) goes through the
  editor: `read_file { path, line?, limit? }` (kind `read`) with `fs/read_text_file`, offered only
  when the client advertised `fs.readTextFile`, and `write_file { path, content }` (kind `edit`) with
  `fs/write_text_file`, offered only with `fs.writeTextFile`; 256 KiB at most each way;
  `edit_file { path, old_text, new_text }` (kind `edit`) with both, and `run_command { command,
  timeout_seconds? }` (kind `execute`) in the editor's terminal, offered only with `terminal`. The
  editor has no method to list or search a folder: `run_command` does both. `workspaceWorld` is a stopgap: the
  workspace tools (`agent-tools/workspace.ts`) on the local disk, bypassing the editor's unsaved
  buffers.
- `feed.ts`: an open session's live view. It subscribes to the facts and `streamed` before
  anything is given to the session, merges them into the projection (`live`), from `start` or the
  state given (`initial`: a loaded session's), sends each update in order, asks each
  `PermissionAsked` of the client, and says when it has taken a turn's end (`turnEnded`): the
  barrier a prompt waits on before it sends `usage_update` and answers.
- `log-keys.ts`: the events the host logs. Each carries the `connection` (minted per connection),
  `request` (set by the peer), `session`, `turn` and `call` it is about as log annotations, the
  names the loop uses.
- `main.ts`: the launcher, `bun src/agent-acp/main.ts`: `launch(env)` runs `makeHost` on this
  process's stdin and stdout (`Agent.runStdio`) with the model catalog of the providers whose key is
  set and the local server (`KeyedAndLocalCatalog`) and the log file of `agent-host/launcher-logs.ts`.
  From the environment: `LABKIT_ACP_MODEL`, `LABKIT_ACP_LOCAL_TOOLS`, `LABKIT_ACP_SESSIONS_DIR`
  (`sessionsDirectoryFrom`; default `~/.labkit/sessions`), the `LABKIT_ACP_LOG_*` variables, and the
  providers' keys.

## What is not built

- The HTTP host.
- The host's own updates but for `usage_update`, the config options, `available_commands_update`
  and `session_info_update`: `current_mode_update`, `plan`.
- `session/fork`: the core has no identity for a fork yet. `session/delete`; additional
  directories; MCP servers (a world is given them and ignores them); attachments (image, audio,
  embedded context).
- An input's attachments on load, and `messageId` on chunks.
- What a reopened session shows as a tool call's content (the default shows its output as text).

## Rules

- PJ1. Live and replay are one projection with a mode. On replay each input from the user is a
  `user_message_chunk`; an input from the system (a turn-end hook's feedback) or from another agent
  gives nothing. Live, inputs give nothing.
- PJ2. A response's answer text (`Text`, `Commentary`) is sent as `agent_message_chunk`, its
  thinking as `agent_thought_chunk`. Live, each `ModelDelta` is sent as it comes, and
  `ModelResponded` sends what of each of its parts the deltas of its request did not; with no
  deltas (a client that does not stream, a whole answer), the whole parts. On replay there are no
  deltas and `ModelResponded` sends its parts whole. The text sent for a response, joined, is the
  text of its parts: live with deltas, live without, and replay send the same.
- PJ3. A response's text is never sent twice. The deltas of a request cover its parts of their kind
  in order, across several parts of one kind; `ModelResponded` sends of each part only what they
  did not cover. A delta of a request whose `ModelResponded` was taken first, and anything captured
  of a turn after its `TurnEnded`, gives nothing: the facts sent that text.
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
- PJ7. A response that stopped or failed keeps what was sent of it. A stopped response's
  `ModelResponded` holds its whole parts only: what the deltas sent of a part the stream cut is not
  taken back, and nothing is sent again. A failed request has no `ModelResponded`: its deltas stay,
  and what they sent is forgotten when its turn ends.
- PJ8. Projecting the stored facts gives the state to go on from live, with no reset: what was shown
  on load is not shown again, and a later request's deltas are sent once.
- PJ9. The relative order of the facts and the captured items does not change what is sent: each
  feed keeps a turn's requests in order, and the projection pairs a request's `ModelResponseEnded`
  with its `ModelResponded` by position in the turn, whichever comes first, with either feed any
  number of requests or turns ahead. Every merge of the two sends each response's text once.
- PJ10. Text of only whitespace is sent with the next text of its kind; when a call or the
  response's end comes first it is not sent, live or on replay, so a client shows no blank message.
  It counts as sent.
- PJ11. On replay a request's response is projected before its calls. Stored, a request's tool
  calls are recorded as they arrive and may have ended before its `ModelResponded`, which holds the
  whole response; live, its thinking and text were sent as they streamed, before the calls. A replay
  therefore takes each `ModelResponded` before the first `ToolCallArrived` of its request, so it
  sends the response's parts in order, each call announced at its place among them, then what
  became of the calls: the order live had. Nothing is added or dropped, and the state it leaves is
  the same (PJ8). Live with no deltas (a whole answer) sends the same updates, but a call's
  announcement comes before the text of its response, which is known only when the response ends.
- AA1. The config options are `model`, then one select for each setting the options offer but
  `observe` and `cache`, with the ids and categories of the table; a setting not offered has none.
  The host adds `permission_mode` after them (AG18). Every option's current value is among its
  values: the model asked now is offered even when the catalog does not list it.
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
- AR1. A title is the first prompt's text trimmed, each run of whitespace one space, cut after 120
  characters (never inside one); none when no text is left.
- AR2. A record is the working folder and, when the first prompt gives one, the title; it reads
  back from JSON. What is not a record, or has no working folder, reads as none.
- AR3. A page of `session/list` lists the stored sessions whose record reads, the one written to
  last first and by id among those written at the same time, only those made for `cwd` when it is
  given, each as its `SessionInfo`: its id, working folder, title and when it was last written.
- AR4. A page has at most `size` sessions (one at least), and `nextCursor` when more follow; a
  cursor goes on after the session its page ended with, so each session comes once and one written
  to meanwhile is not repeated. A cursor `pageOf` did not give is an `InvalidCursor` naming it.
- AG1. `session/new` with an absolute `cwd` mints the session's id (ACP's `sessionId` and the core's
  `SessionId`), opens its world and answers a draft: the model to start with, its output limit
  defaulted (`withDefaults`), and its config options (`configOptions`). Nothing is written. Once the
  response is written, `available_commands_update` offers `/export`.
- AG2. The first `session/prompt` opens the draft (turn zero): the session's folder in the session
  directory with its `facts.jsonl`, opened with the draft's model, settings, system prompt and tools
  (`SessionOpened`) by the user through ACP, and the prompt is the turn's input from the same
  origin. Its updates are sent in the order the projection gives them, the facts and the streamed
  items merged; each `PermissionAsked` is a `session/request_permission`, and the option the client
  selects is recorded as the answer. Once the turn has ended and the feed has sent its updates, the
  host sends `usage_update` and answers the prompt with the turn's stop (`stopOf`).
- AG3. A permission request the client answers `cancelled`, fails, or answers with an option the
  question does not offer refuses the call once: it does not run, and the turn goes on. Each but
  the first is logged as a warning with its cause.
- AG4. `session/cancel` is `Session.cancel`: the turn under way ends `Interrupted` and its prompt
  `cancelled`. A prompt request the client cancels (`$/cancel_request`) cancels its turn the same
  way. The session takes the next prompt.
- AG5. `session/set_config_option` changes a draft (`chooseModel`, `saySettings`). On an open session
  it is `ModelChangeArrived` from the user through ACP, taken at once between turns and otherwise
  at the turn's next step (agent-machine M1); the answer is every option as the configuration will
  be, the changes not yet taken included, and the same options are sent as `config_option_update`
  (a client may draw its controls from updates alone). A value the option does not offer, or an
  option no session has, is -32602, and sends nothing.
- AG6. `/export`, alone in a prompt, writes the session's transcript (`markdownOf`) to
  `<cwd>/.labkit/exports/<sessionId>.md`, says where in an `agent_message_chunk` and answers
  `end_turn` without asking the model; on a draft it says there is nothing to export.
- AG7. A prompt to a session with a prompt running is -32000 "already has an active prompt"; a
  request naming a session the connection does not hold is -32002; a `cwd` that is not absolute is
  -32602; with no model to ask, `session/new` fails saying which variables to set or which server
  to start.
- AG8. A turn that fails (a model request failed) answers its prompt with a JSON-RPC error carrying
  the failure, and the session takes the next prompt.
- AG9. When the connection ends, each session's scope closes: a turn under way is left running in
  the facts (no `TurnInterrupted`, no `TurnEnded`), and `Agent.run` returns.
- AG10. `editorWorld` offers `read_file` only to a client that advertised `fs.readTextFile` and
  `write_file` only to one that advertised `fs.writeTextFile`; a client that advertised neither
  gets no file tools. They read and write through `fs/read_text_file` and `fs/write_text_file` with the
  session's id and the path resolved against the working folder; a path outside it is refused with
  a failure the model reads, and the editor is not asked.
- AG11. Session created, config changed, session opened, prompt received, admitted and settled
  (its stop reason or error, and its duration), cancel requested, permission asked, answered and
  failed, export written and usage sent are logged under `log-keys.ts`, annotated with the
  connection, request, session, turn and call they are about. A routine turn logs no warning or
  error; a failure is logged with what failed, what the host was doing and the cause.
- AG12. A world of the host's own gives the session its system prompt, its tools, the runner that
  runs them and how their calls are shown.
- AG13. `session/close` cancels the turn under way, waits for its prompt (which ends
  `cancelled`), and closes the session's scope; a later request naming it is -32002.
- AG14. The launcher serves the host on stdin and stdout, and puts nothing but protocol on stdout.
  Its log is a file, named once on stderr, that holds no secret of the environment, and it exits 0
  when stdin closes.
- AG15. Sessions are kept in `LABKIT_ACP_SESSIONS_DIR` when it is set, else in `~/.labkit/sessions`.
- AG16. By default a turn whose response had thinking but no answer (`Incomplete`) is asked once
  more for its answer (agent-host H15): an answer then reaches the client as `agent_message_chunk`
  and the prompt ends `end_turn`, with no warning logged; with none again the turn ends
  `Incomplete` after that one retry, `end_turn` with no answer message. The feedback is not sent to
  the client (PJ1). `LABKIT_ACP_RETRIES` sets how many times it is asked (0: never); a value that is
  not a whole number of 0 or more is logged, and 1 is used.
- AG18. Each session has a permission mode, which the host keeps: it starts as the launcher says
  (`LABKIT_ACP_PERMISSION_MODE`, else `default`) and is the option `permission_mode` (category
  `mode`); a change applies from the next tool call. A value that is not a mode is -32602.
- AG19. The host takes images and embedded resources in a prompt (`promptCapabilities.image`,
  `embeddedContext`): each is put in the session's blob store, kept in its folder (`blobs/`), and
  attached to the input by reference, with its media type and the name its URI ends in; a
  resource link is a Markdown link in the text.
- AG20. `editorWorld` offers `update_plan { entries }` to every client: each call sends the whole
  plan as a `plan` update (an entry's priority `medium` unless given), and succeeds with the count
  of steps by status. It is of kind `think`: it runs in every permission mode without asking.
- AG17. `editorWorld` offers `edit_file` to a client that advertised both `fs` methods, and
  `run_command` to one that advertised `terminal`. `edit_file` reads the file through the editor
  and writes it back with one occurrence of `old_text` replaced; `old_text` that occurs never or
  more than once is refused, and nothing is written. `run_command` runs `sh -c <command>` in a
  terminal of the editor's, in the working folder, waits for its exit until its time runs out,
  reads its output, and releases the terminal however the call ends, which stops a command still
  running. Exit code 0 succeeds; any other end fails, its output and how it ended for the model to
  read. Both ask permission in the default mode. A call's title names its command or its path
  (`run_command: ls`, `edit_file: a.txt`), so a permission question says what it asks about. An
  edit's call shows its change as a `diff`, from
  when permission is asked; a command's call shows its `terminal` from when it has one, and when
  it has ended.
- AL1. `initialize` advertises `loadSession` and the session methods `close`, `list` and
  `resume`; not `fork`, which waits for the core to have an identity for a fork.
- AL2. Turn zero writes the session's record (`host.json`, `recordFor`) before its facts: the
  working folder and the first prompt's text as its title (AR1). Once the opening is recorded the
  host sends `session_info_update` with the title (`null` when there is none) and the time as
  `updatedAt`. `/export` on a draft opens nothing and writes nothing. A record that cannot be
  written fails the prompt as a session that could not be opened (-32603).
- AL3. `session/load` with an absolute `cwd` starts the stored session on the connection: its
  facts, with the model, system prompt and tool catalog they hold, and the world opened for `cwd`
  and the MCP servers asked, which gives the runner and the presentation; the record keeps the
  working folder it had. Before its answer the host sends the stored facts as the projection
  replays them (`replay`), each update once and in order; the answer is the session's config
  options. After the answer it sends `available_commands_update` (`/export`),
  `session_info_update` (the record's title, `null` when it has none or it does not read, and when
  the facts file was last written) and `usage_update`. The feed goes on from the state the replay
  leaves (PJ8): a later prompt's updates are sent live and repeat nothing replayed, and its model
  request carries the earlier turns.
- AL4. A turn the stored facts left running (their process ended mid-turn) is ended at load or
  resume (`endTurnLeftRunning`): it ends `Interrupted`, each call it left running fails, no tool
  runs and no model request is made. A replay shows the requests that were answered as usual, with
  each call left running `failed`. A request that was in flight adds only the calls that had
  arrived in it, each as it ended (`failed` when it was left running), since the text and thinking
  it streamed were never recorded. ACP has no update for how a turn ended (its stop reason is in the
  answer to its prompt alone), so a turn whose only request was in flight, with no call arrived,
  shows its input alone. With no turn left running, the session goes on (`goOn`) once its feed has
  started, so input left waiting starts its turn live. The next prompt runs a new turn.
- AL5. `session/resume` is `session/load` with nothing replayed: the client has the history.
- AL6. `session/list` is a page (`pageOf`, of `pageSize`) of the sessions in the session directory
  with a record, the one written to last first, filtered by `cwd` when it is given. A session with
  no record (the CLI made it) is not listed, and loads by its id. A cursor `session/list` did not
  give is -32602 naming it; a session directory that cannot be read is -32603 with the cause.
- AL7. For `session/load` and `session/resume`, a `cwd` that is not absolute is -32602; a session
  the connection holds already is -32602 saying it is already loaded; one the session directory
  does not hold is -32002 with its `sessionId`; one whose store cannot be opened (its facts file
  open in another process, a file that does not read) is -32000 carrying the store's message, and
  leaves nothing open: once the cause is gone, it loads.
- AL8. Record written, session loaded and resumed (the updates replayed, the turns left running),
  turn left running ended (with its turn), session not stored, not loaded, listed (the `cwd`
  filter, the sessions given, whether more follow) and not listed are logged under `log-keys.ts`,
  annotated with the connection and the session. A routine load logs no warning or error; a
  session not stored, a load refused and a bad cursor are warnings, a store that cannot be opened
  and a directory that cannot be read are errors, each with its cause.
- AL9. A session started by `session/load` or `session/resume` offers `permission_mode` (AG18) at
  the launcher's mode, as a new session does: the mode it had when it was closed is not kept. A
  mode set after the load applies from the session's next tool call.
