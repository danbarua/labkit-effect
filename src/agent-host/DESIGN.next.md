# The hosts: direction

The layers of the two hosts, Dan's rulings and the order of work. `TODO.md` lists what is to be
built; the `MODEL.md` of `agent-host` and `agent-acp` says what is.

## Rulings

Dan, 2026-10-02, where they decide something. In quotation marks, verbatim.

- Both hosts are built here and labkit imports from here. "The core stays out of the workspace, the
  working folder, the tool catalog, the configuration UI and session naming." (`TODO.md`)
- "What you call a Session and what we call a Session don't need 1:1 mappings. Once you've got your
  configuration, user input and model selection in place, the core session can begin. Until then,
  core's got no reason to be journalling facts."
- Configuring: "I think that state is 'the state machine does not yet exist.' You could easily build
  that logic in a separate machine for UI purposes." The CLI is the place to try it.
- "Changes can be delivered to core any time, but they won't be applied until the next turn."
  Whether to offer them while a turn runs is the host's.
- A setting stands as said. The adapter maps it to what the provider takes, as near as it can
  (reasoning effort is the example), and records `SettingAdjusted`. A hand-written `models.yml` can
  say anything; a UI is meant to offer only what a model takes.
- The output limit is a hard-coded select of presets, as in the labkit monorepo's host.
- `Session` gets `prompt`, `cancel` and the turn under way.
- "Agent gets given context and tool options, core tells host what options the Agent Exercised. Host
  runs the tools, tells core what happened, core tells the Agent." A workspace is whatever the host
  tells the agent it is; the core records none.
- In ACP the system prompt and the tool catalog are fixed when the session is created, so the host
  provides `ImmutableSystemPrompt` and `ImmutableToolCatalog`.
- `Incomplete` ends an ACP turn as `end_turn`. Retrying an incomplete response is the host's to
  decide.
- A client's cancelled answer to a permission request is a refusal: the turn goes on, and the model
  asks what to do next. The permission model is machinery and not fixed.
- Chat Completions is to be feature-complete (streaming, `max_tokens` as `length`) "because we can
  e2e test for free". labkit-effect builds it.
- labkit's `app-acp` stays in labkit and becomes a consumer of these libraries; what it does on the
  world side is kept.
- "The thinner the host/runtime, the better!"

## Layers

| Layer | Where | Is |
|---|---|---|
| Core | `agent-machine`, `agent-policy`, `agent-session`, `agent-context` | Machines, facts, the loop, the journal. Knows no workspace, working folder, tool catalog, configuration UI or session name. |
| Host services | `agent-host` | What both hosts share, lifted from the CLI: the model catalog, the provider clients, the services a session runs with, the permission policy for a mode, the session directory, the logs, and the draft a session is before turn zero. Imports the core. Imports no protocol. |
| ACP | `acp` | The protocol and nothing else. Imports nothing of the core, so it can be offered to Effect. |
| ACP host | `agent-acp` | Joins `acp` to a session: the handlers (`makeHost`), the projection of facts to `session/update`, the launcher. Imports `acp`, `agent-host` and the core. |
| CLI | `examples/cli-repl` | The first host, and the place to try ideas. Imports `agent-host`, never `agent-acp`. |
| labkit | `packages/app-acp` in labkit-agent | The world side of the ACP host: workspace files, the editor's files and terminal as tools, MCP, elicitation, plans, commands. Plugs into `agent-acp`. |

## Turn zero

1. `session/new` makes a draft with an id the host mints. The draft holds the model, its settings,
   the system prompt, the tools, and what the host needs of the working folder. No session is open,
   and nothing is written.
2. The options shown to the client (`configOptions`) come from the model and its settings alone
   (`optionsFor`): each setting's values the model takes (`choicesFor`), and, where the adapter
   adjusts what was said, the value the model will get. A setting is kept as said; the options show
   what it comes to. The draft is ready when the model, the thinking level and the output limit have
   values; the defaults come from the catalog.
3. `session/set_config_option` changes the draft.
4. The first `session/prompt` opens the session (`openedWith`: the draft's model, system prompt and
   tools, over the store the host chose) and gives it the input. That is turn zero, and the draft
   ends.
5. From then on `session/set_config_option` is `ModelChangeArrived` from `User { via: acp }`, taken
   at the next turn (agent-machine M1–M3). The ACP host takes it while a turn runs, as the labkit
   monorepo's host does; the CLI disables the controls instead.

The output limit is a select of 4096, 8192, 16384, 32768, 65536 and 128000 tokens up to what the
model takes, the model's own limit, and the value in force; the default is 32768 or the model's limit
if lower (`vscode-workspace.ts` in labkit-agent).

## Identity and persistence

- The id is minted with the draft and is both ACP's `sessionId` and the core's `SessionId`: one id,
  two lifetimes. A draft that never gets input leaves nothing on disk, so `session/list` lists
  sessions that had a turn.
- A session is a folder in the session directory. `facts.jsonl` is the core's journal
  (`FileBackedSessionStore`). `host.json` is the host's own record of it (the working folder and a
  title from the first prompt, whatever else the host keeps): `agent-host` stores and returns it as
  JSON and does not read it. Listing reads the folders and orders them by when the facts were last
  written; the ACP host filters on its record, so a session the CLI made, with no record, is not
  listed and loads by its id.
- Reopening (`session/load`, `resume`). The world is opened for the request's `cwd`; the model,
  system prompt and tool catalog come from the facts. A turn the facts left running is ended, not
  gone on with: the editor that closed mid-turn is not watching, and what the turn had begun (a
  model request, tools that change things) should not run unseen. The order matters because the
  feed subscribes to facts when it starts: end the turn left running, replay the facts through the
  projection (load only), start the feed from the state the replay leaves, and only then `goOn`.
- A fork copied as it is would keep `SessionOpened { session }` naming its source, which the loop's
  log annotations, the `/export` header and compaction's summaries read. The core has no identity
  for a fork yet (`TODO.md`, Sessions), so the ACP host does not advertise `fork`.

## Projection

One pure projection from the core's output to `session/update`, for the live view and for
`session/load`. It takes the facts (`session.subscribe`, or the stored ones) and the core's captured
items (`session.streamed`: `ModelDelta`, `ModelPartArrived`, `ModelResponseEnded`), merged in any
order, and says the updates each gives. The two feeds have no order between them, and each
response's text is sent once whichever merge a host makes (`agent-acp` PJ9). A load has no request
under way (a turn left running is ended before the facts are read), so there are no deltas to miss
between the replay and the feed that goes on from it.

| Core | ACP update |
|---|---|
| `InputArrived` | `user_message_chunk`, on load only: the client has the prompt it sent |
| answer text | `agent_message_chunk`: each delta as it arrives, then what no delta sent when `ModelResponded` is taken; on load, the parts of `ModelResponded` |
| thinking | `agent_thought_chunk`, likewise |
| `ToolCallArrived`, or a tool call part of `ModelResponded` | `tool_call`, `pending`; title, kind and locations from the host's presentation of the call |
| `PermissionAsked` | `tool_call_update`, `pending` (the host also asks `session/request_permission`) |
| `ToolCallDispatched` | `tool_call_update`, `in_progress` |
| `ToolEnded` | `tool_call_update`, `completed` or `failed`, with content from the host's presentation |

Not in it, the host's own: `usage_update` (`contextGauge` needs the model's capabilities),
`session_info_update`, `available_commands_update`, `config_option_update`, `current_mode_update`,
`plan`. A tool's presentation comes from the host's world: `(call, outcome?) → title, kind,
locations, content`. The default is the tool's name, its kind from the catalog and its output as
text. What a reopened session shows as tool content is parked.

## Cancel, stop reasons, permission

- `session/cancel` is `Session.cancel`: `TurnInterrupted` for the turn under way (X1–X3). Requests
  under way report how far they got, a turn-end hook in flight is stopped, and none starts. The turn
  ends `Interrupted`: `cancelled`. A permission being asked is stopped with the turn (`NotRun`), and
  the client's late `cancelled` answer is dropped.
- A turn's ending as ACP's `stopReason`:

| Ending | stopReason |
|---|---|
| `Completed`, `Incomplete` | `end_turn` |
| `CutShort` | `max_tokens` |
| `Interrupted` | `cancelled` |
| `Vetoed` | `max_turn_requests` when the turn-request limit vetoed it; otherwise a JSON-RPC error carrying the reason |
| `Failed` | a JSON-RPC error carrying the failure |
| any, when the last response's ending is `Refused` | `refusal` |

- `PermissionAsked` is `session/request_permission` with the options the policy offered
  (`questionIn`). The option selected is `PermissionAnswered` (`answerPicking`). The client's
  `cancelled` outcome is the reject option, once.

## Tools

In ACP, tools go through the editor. The catalog and the system prompt are known at `session/new`
and do not change after. The host's world supplies, for each session: the catalog (`ToolSpec`), a
`ToolRunner` that reaches the editor (`fs/*`, `terminal/*`) and the MCP servers the client named,
and the presentation of each tool's calls. The core is told what happened. `ToolRunner.run` is
given no call, so a tool that needs the call's id (a terminal shown on its `tool_call`) cannot have
it. To decide when the editor's tools are built: a `CurrentCall` the loop provides around `run`, as
it provides `CurrentOrigin`, or the id in the tool's output.

## Logs

A launched ACP agent keeps stdout for the protocol. Its logs are JSONL, one file per launch,
`~/.labkit/logs/acp-<pid>-<launch id>.jsonl` (the name and place the labkit monorepo's host uses,
with its `LABKIT_ACP_LOG_DIR`, `_LEVEL`, `_MAX_BYTES` and `_BACKUPS`): bounded, rotated, secrets
redacted by field and no error dropped. Each record carries the connection, request, session, turn
and call ids that apply. The file logger is in `agent-host`, and the ACP launcher sets it up.

## What the ACP host still needs of the core

| Need | Built by | Where |
|---|---|---|
| An end for each attempt of a model request on `streamed` (a fallback's failed attempt leaves text on screen) | labkit-effect | `TODO.md`, Providers |
| The call, given to `ToolRunner.run` | open | when the editor's tools are built |

## Order

Built: `optionsFor`; `Session.prompt`, `cancel` and `turn`; the host services lifted out of the CLI;
the projection; the draft; ACP's config options, permission request, stop reason and
`usage_update`; the Markdown export; the launcher's log file. Chat Completions streams and sends
`max_tokens`. The ACP host over stdio for protocol v1 (`makeHost` and the launcher: `session/new`,
`session/set_config_option`, `session/prompt`, `session/cancel`, `session/close`,
`session/request_permission`, `usage_update`, `/export`, tools through the editor's `fs/*`), run
against the local Qwen with the SDK's client. The session directory with the host's record, and
`session/load`, `resume` and `list` over it.

1. The ACP host in VS Code, then JetBrains.
2. The CLI opens its session at its first input, from a draft, and has `/export`: the place to try
   turn zero.
3. `terminal/*`; MCP; attachments; Streamable HTTP with a token and one holder for a session;
   elicitation; `session/delete`; `session/fork` once the core has an identity for a fork.
4. labkit's `app-acp` as a consumer.

## Open

- The shape of the seam between `agent-acp` and labkit's `app-acp`: drawn from the first slice.
- A `models.yml` as one more source for the catalog. The catalog is a service, so a file can be
  added; not in the first slice.
- The call, given to a tool.
- What `session/load` sends for tool content (parked by Dan).
