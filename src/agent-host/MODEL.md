# agent-host

What both hosts share (the CLI, and the ACP host to come): the model catalog, the provider
clients, the services a session runs with, the permission policy for a mode, the folder sessions
are kept in, where log lines go, and the draft a session is before turn zero. It imports the core
and no protocol, and nothing of a host.
What is described here is built; where the hosts are going is in `DESIGN.next.md`.

## What is built

- H1. The model catalog is a service, `ModelCatalog`: its sources, each a provider and the models
  it lists, asked for anew each time (`sources`). `KeyedAndLocalCatalog` has two: the well-known
  models (`known`) of each provider whose key the environment holds (`keyVariables`; an empty key is
  none), in the order `known` has them, the keys read when the layer is built; then the local server
  (`local-server.ts`), with the models it lists, or none known when it does not answer within a
  second. `askable` is the models the catalog lists, each source's in turn: what a host offers to
  pick.
- H2. `targetOf(name)` is the provider and model a name gives. `<well-known provider>/<model>` is
  that provider's model, whether `known` lists it or not; `<other source>/<model>` is a model that
  source lists; a name alone is the well-known model of that name, or else another source's. A
  name no source has fails with `ModelNotFound` and the names it is close to (the same apart from
  case, or one containing the other). A model of a source that did not answer fails with
  `SourceNotAnswering`; one of a well-known provider not in the catalog, with `KeyNotSet` and the
  variable to set. A host says these in its own words.
- H3. What is known of a `localhost` model is what the local server's list says of it (`GET
  /v1/models`, its `models` entries): its context window, the kinds of input it takes (text when
  none is said) and its reasoning efforts. An entry or a value written some other way drops only
  itself (`localCapabilities`). `KnownWithLocalServer` puts the server in front of the well-known
  models in `KnownModels`: it asks the server once, when first needed, logs that it did not answer,
  and knows only `localhost` models. `SettlingWithLocalServer` puts the Chat Completions adapter's
  settings function in front in `Settling`, for `localhost`.
- H4. `permissionsFor(mode, canAsk)` is the permission policy (`agent-policy/permissions.ts`) for
  `mode`, a tool call policy: a call is judged by the kind its tool has in the catalog the session
  opened with (a tool not in it is taken to change things), and asked about only when `canAsk`.
  `loopBreaker(settings)` is the loop breaker's two policies, one for each list. The CLI puts the
  loop breaker first among the tool call policies, then permission, so no one is asked to permit a
  call the loop breaker vetoes. The ACP host has permission alone: ACP has no stop reason for a turn
  the loop breaker stops.
- H5. A folder of sessions (`directory.ts`, its root given) keeps each in `<root>/<session>/`, its
  facts in `facts.jsonl`. `storedSessions` lists the ones with a facts file, the one written to last
  first; `readSession` reads one (`SessionNotFound` when the root does not hold it); `latestSession`
  reads the one written to last (`NoSessionStored` when there is none); `summaryOf` says how many
  turns a session started and the model it asks now. A root that cannot be read fails with
  `DirectoryUnreadable`.
- H6. `LogsToFile(path)` writes log lines to `path`, making its folder when missing; `LogsToStderr`
  writes them to stderr, for a host whose stdout is for something else.
- H7. A draft (`draft.ts`) is a session before turn zero: no session exists and nothing is
  recorded. It holds the model to ask, the settings as said, the system prompt and the tools.
  `chooseModel` gives it another model and keeps the settings as said, even one the new model
  does not take; `saySettings` says the settings it names anew and leaves the others as said.
  `optionsOfDraft` is what a host shows of it (`optionsFor`): each setting with the value the
  model will get, so an effort the model does not take is shown as the nearest it does.
- H8. `opening(draft, session)` is the `SessionOpened` that opens `session` with the draft: a
  session opened with it asks the draft's model with its settings, has its system prompt and its
  tools, and its options (`optionsOf`) are the draft's. A host opens it at the first input and
  then drops the draft.
- H9. `withDefaults(draft, capabilities)` gives a draft that says no output limit 32768 tokens, or
  the model's own (`Capabilities.output`) when that is known and lower; a limit said stays. A host
  applies it or leaves the limit to the provider. `defaultModel` is the first model the catalog
  lists (`askable`), or none when it lists none, and a host has nothing to ask.

`Clients` is one model client reaching each provider whose key is set, and the local server, the
keys read when the layer is built. `SessionServices(runner)` is what the loop needs for a session
but its store, its policies and its turn-end hooks: the model its facts name, what is known of it
and how its settings are applied (H3), the whole conversation as its context, the clients, turns
that count on from those its store holds, and `runner` for its tools (`SourcedToolRunner`, over the
host's tool sources).

## Export

`markdownOf(facts)` (`export.ts`) is a session's transcript as Markdown, read from its facts alone,
with nothing asked of a model or of the blob store: the body of a host's `/export`. Where it is
written is the host's business.

- H10. The transcript opens with the session's id and the models it asked: the one it opened
  with, then each change taken, which is also said where it was taken. Each turn follows in order:
  each input given to it, where it was given, with its sender and its text as recorded, and each
  attachment by its media type, size and blob id; each response's answer text, its thinking in a
  collapsed `<details>` block, and each tool call with the tool's name, its input fenced, what was
  asked before it ran and the answer on one line, and how it ended (its output, or why it failed:
  vetoed with the reason, not run, not observed, input rejected, reported by the tool); input
  dropped when the turn ended; and, when the turn did not end in an answer, how it ended (cut
  short, failed with the failure, vetoed, interrupted, with no answer). A call whose response was
  not recorded shows where it arrived. A turn with no `TurnEnded` says it was left running, and a
  call with no `ToolEnded` that no outcome is recorded.
- H11. A tool's text output is fenced with more backticks than it holds in a row, and cut after
  8 KiB of UTF-8, never inside a character, with a line saying how many bytes were left out;
  bytes are named by their media type and size, and stored bytes by their blob id,
  and not read. The transcript ends with its totals: the turns started, the model requests made
  (`requestsIn`), the tokens the responses reported, the cost (`costIn`), and the context gauge of
  the model asked now when it is a well-known one (`contextGauge`).

## Launcher logs

`LauncherLogs(options)` (`launcher-logs.ts`) is the log a launched ACP agent keeps: its stdout is
for the protocol, so its log lines go to a file of its own. `launcherLogOptionsFrom(env)` gives the
options from the environment; `bun run acp:logs` prints the newest launch's file, `--errors` its
warning, error and fatal records alone.

- H12. Each record at the level or above is a line of JSON appended to
  `<dir>/acp-<pid>-<launch id>.jsonl`, the folder made when missing: its time (ISO), its level
  (trace, debug, info, warning, error, fatal), its log annotations (where the connection, request,
  session, turn and call ids ride), its message and, when there is one, its cause as text with its
  stack and nested causes. The layer also makes the level the lowest logged. The file's path is said
  on stderr once, at start. The environment gives, each after the brand's prefix (H18; `LABKIT_`
  for labkit's), the folder (`ACP_LOG_DIR`, `~/.<brand>/logs`), the level (`ACP_LOG_LEVEL`, debug),
  the size a file is rotated at (`ACP_LOG_MAX_BYTES`, 10 MiB) and the backups kept
  (`ACP_LOG_BACKUPS`, 4); a value that does not read is the default. Each launch has an id of its own, and the 20 newest stopped
  launches are kept.
- H13. A record that would take the file past `maxBytes` first rotates it: `.jsonl` becomes
  `.jsonl.1`, each backup moves one on, and none past `backups` is kept. A record whose line is past
  256 KiB is written cut to fit: its time, its level, the start of its line as text (`record`) and
  the bytes left out (`omittedBytes`). At start, the files of the stopped launches past the newest
  `keep`, by the time their files were last written, are removed with their backups; a launch whose
  pid runs keeps its files and does not count.
- H14. Every log a host writes (the launcher's; the CLI's, to a file or stderr; a test's) leaves out
  the environment's secrets (`redaction.ts`): the values of the variables whose names are
  credentials' (`isCredentialName` in agent-process: `OPENAI_API_KEY`, `GITHUB_PAT`) are `<redacted>` wherever they
  occur in a record, its annotations and cause included, and so is the value of a credential field
  (`authorization`, `apiKey`, `password`, an access token, a cookie); the rest of an error's text
  stays. A value under 8 characters is not looked for, as replacing it would cut ordinary text;
  those are said once when the log is made, a warning (`host_logs.secrets_not_looked_for`) naming
  each variable and its length, never its value. A provider's key is held as `Redacted` from the
  environment to its client (`keyOf`): a log or a string of it says `<redacted>`. A folder or file that cannot be written is said once
  on stderr, and that record and every one after go to stderr: the launcher does not die for its log.

## Turn ends

A host composes the turn-end hooks a session runs with (`TurnEndHooks`, in order) and how many
times they may hold a turn (`MaxHolds`). `retryIncomplete(retries = 1)` (`incomplete.ts`) is one
hook, for models that put their whole answer in their reasoning; the CLI and the ACP host run it
alone, with `MaxHolds` its `retries`.

- H15. When the latest decision about a turn is `TurnIncomplete` (a whole response with no tool
  calls and no answer text, agent-machine I4) and the hooks have not held the turn open `retries`
  times since it started, the hook gives the model `answerNow`: "Your last response had thinking
  but no answer. Give your answer now.", which holds the turn open for one more request. A turn
  answered (`TurnCompleted`) or a response cut short gets nothing. With no answer after its
  retries the turn ends `Incomplete` and no further request is made. The hook counts the inputs
  the turn-end hooks have given the turn, whichever hook gave them (the facts do not say which);
  it is the only hook a session runs with, so they are its retries, and the loop's bound on holds
  is the same number: at the bound the loop asks the hooks again, the hook gives nothing, and the
  turn ends with no `TurnHoldsExhausted` and no `holds_exhausted` warning, which the loop makes
  only when a hook would hold the turn again.

## The host's record

`host.json` (`record.ts`) is a host's own record of a session, in the session's folder beside its
facts: whatever the host keeps of it that is not a fact (its working folder, its title). This
module stores it as JSON and returns it as JSON and does not read it.

- H16. `writeRecord` makes the session's folder when it is not there and writes the record whole:
  under another name, flushed to the disk, then renamed over the record, so a reader finds the old
  record or the new. `readRecord` gives the JSON written, `undefined` for a session with no record,
  and fails with `RecordFailed` naming the file when it is not JSON or cannot be read; a write that
  fails leaves the record already there as it was.
- H17. `recordedSessions` is `storedSessions` (H5: the sessions with a facts file, the one written to
  last first), each with its record, or `undefined` when it has none or its record does not read.
  A record that does not read is logged as `host_record.unreadable` (session, file, cause), a
  warning, and its session is listed without it. A folder with a record and no facts file is no
  session.

`Brand` (`brand.ts`) is the name the agent goes by, and what is named after it. A package that
ships the agent gives its own at its entry point; the CLI's `main(brand)` and the ACP launcher's
`launch(env, brand)` take it.

- H18. A brand's environment variables' prefix is its name in capitals, every character but a
  letter or a digit `_`, then `_` (`labkit`: `LABKIT_`; `whitelabel-agent`: `WHITELABEL_AGENT_`); its
  folder, in a home or a project, is `.<name>`. The brand is the one a program gives; else the one
  `LABKIT_BRAND` names (the default brand's prefix, then `BRAND`; blank names none); else labkit.
  Named after it: the configuration's folders (`~/.config/<name>/`, `<project>/.<name>/`), the
  launcher's sessions and logs (`~/.<name>/sessions`, `~/.<name>/logs`) and variables
  (`<PREFIX>ACP_*`), where `/export` writes (`.<name>/exports`), what the ACP host calls itself to a
  client (`agentInfo`) and the MCP client to a server (`clientInfo`), and the CLI's command.

`launch.ts` is what both hosts are launched with: the options they share (`launchFlags`), where a
flag not given is read from (`launchVariables`), and the configuration's layers the options make
(`launchConfiguration`, over the host's own defaults; agent-config).

- H19. The options are `--model`, `--permission-mode` (`manual` is `default`), `--strict-tool-input`,
  `--max-turns`, `--max-budget-usd`, `--mcp-config` (given again for more), `--strict-mcp-config`,
  `--settings` and `--setting-sources`. A flag not given is read from its variable: the brand's
  prefix (H18), the host's part (`ACP_` for the ACP launcher's, none for the CLI's), then the
  flag's name in capitals, `_` for `-` (`LABKIT_MAX_TURNS`, `LABKIT_ACP_MAX_TURNS`); `--mcp-config`
  takes one value from it. A flag given wins; an empty variable is none; a variable the flag would
  not take is the flag's error. A variable that is no flag's twin is read as it is named
  (`OTEL_EXPORTER_OTLP_ENDPOINT`), after the one with the brand's prefix and the host's part.
- H20. The layers, merged in order, the last write winning: the host's defaults; the user's file,
  and the project's and the local one when `--setting-sources` names them (agent-config CF12:
  named, they still may not name extensions or MCP servers); `--settings` (JSON, or a file of JSON
  or YAML); with `--strict-mcp-config`, no MCP servers but those `--mcp-config` names; each
  `--mcp-config` (JSON or a file of it, as Claude Code's `.mcp.json`); then the flags:
  `--permission-mode` sets the permission plug-in's mode, `--max-turns` the turn's most model
  requests and `--max-budget-usd` the session's budget, a plug-in a flag sets being added last to
  the model requests' list when it is not on it.

## What is not built

- A source of the catalog read from a hand-written `models.yml`.
- Forks: the facts a new session begins with, which the core has not got (`TODO.md`, Sessions).
