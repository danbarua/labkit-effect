# agent-host

`src/agent-host` holds what both hosts share, the CLI and the ACP host: the model catalog, the
provider clients, the services that a session runs with, the permission policy for a mode, the
folder where sessions are kept, log files and redaction, the draft that a session is before its
first turn, the Markdown export, the host's record of a session, the brand, and the launch options.
It imports the core and no protocol, and nothing of either host.

The ACP host is described in [agent-acp.md](agent-acp.md). The hosts' direction and Dan's rulings
about them are in [agent-host-direction.md](agent-host-direction.md).

## Files

| File | Responsibility |
| --- | --- |
| `catalog.ts` | The model catalog (`ModelCatalog`), `askable`, and `targetOf`. |
| `local-server.ts` | The local server's models and what is known of them; `KnownWithLocalServer`, `SettlingWithLocalServer`. |
| `clients.ts` | `Clients`: one model client per provider whose key is set, and the local server. Every provider's requests go through one HTTP client that captures their bodies (`capturingHttp`), and each attempt is observed on its span (`observedAttempts`); both are in `src/instrumentation`. |
| `services.ts` | `SessionServices`, `permissionsFor`, `loopBreaker`, `turnRequestLimit`, `budgetLimit`. |
| `with-session.ts` | `withSession`: a session as a host runs it, with the host's bolt-ons. |
| `session-context.ts` | The builder of a session's context (`makeSessionContext`), the one place a session's folders are assembled, and the combinator that runs a session's work in it (`inSession`). |
| `directory.ts` | The folder of sessions. |
| `record.ts` | `host.json`: a host's own record of a session. |
| `draft.ts` | A draft: a session before its first turn. |
| `export.ts` | `markdownOf`: a session's transcript as Markdown. |
| `incomplete.ts` | `retryIncomplete`: the turn-end hook for a response with thinking and no answer. |
| `logs.ts` | `LogsToFile`, `LogsToStderr`. |
| `log-level.ts` | The level a program logs at, from `<PREFIX>LOG_LEVEL`, and the warning for a value that names no level. |
| `launcher-logs.ts`, `log-file.ts` | The ACP launcher's log files. `log-file.ts` is listed in `imperativeBoundaries` in `oxlint.config.ts`. |
| `redaction.ts` | Removing the environment's secrets from log records. |
| `brand.ts` | The name the agent goes by, and what is named after it. |
| `brand-folders.ts` | `BrandFolders`: every folder named after the brand (configuration, data, sessions, blobs, logs, the project's folder), resolved once at an entry point from the brand, the home folder and `--config-dir`, `--data-dir` and `--sessions-dir`. |
| `launch.ts` | The launch options both hosts share, and the configuration layers they make. |
| `command-parser.ts` | The command parser: the WebAssembly module of `native/bash-segments`, which splits a shell command into its segments (`docs/bash-segments.md`). |
| `command-writes.ts` | The files a command writes text to (`cat > f <<'EOF'`, `echo x >> f`), their full paths, and their text before the command runs, read from the disk (`currentOnDisk`, `agent-tools/file-change.ts`) or by a host's own means: what a host shows as each file's diff before the command runs. Also the files a command tool records (`writtenFiles`): every file the command writes at a path it writes out, `sed -i`'s and `printf … > f`'s included, whose text is read before and after it runs. |
| `recorded-changes.ts` | `recordingChanges`: the wrapper around a host's own tool sources that records what each call changes in files (`FileChanged`), the files found as the permission policy finds them, each read just before and after the call, under the size limits; and each move a command's `mv` makes (`FileMoved`, `plannedMoves`), as the disk shows it before and after. A file git ignores is recorded by its size (`FileWritten`, `ignoredByGit`), unless the repository ignores the working folder itself. |
| `command-detail.ts` | A permission question's detail, shown as Markdown for ACP (code in a fence that names its language, an explanation as a nested list) and as plain lines for the REPL. |
| `trust.ts` | Trusted folders: the folders whose own `.env` files and project settings the agent reads (`trusted-folders.json`). |
| `log-keys.ts` | The names of the log events that this module writes. |

## The model catalog

`ModelCatalog` is a service whose `sources` are read anew each time. Each source is a provider and
the models it lists. `KeyedAndLocalCatalog` has two kinds of source:

1. the well-known models of each provider whose key the environment holds (`keyVariables`), in the
   order `known` lists them. A key that is empty counts as not set. Keys are read when the layer is
   built;
2. the local server (`local-server.ts`), with the models it lists, or no models known when it does
   not answer within one second.

`askable` is every model that the catalog lists, source by source: what a host offers to pick.

`targetOf(name)` returns the provider and model that a name refers to:

| Name | Result |
| --- | --- |
| `<well-known provider>/<model>` | that provider's model, whether `known` lists it or not |
| `<other source>/<model>` | a model that the source lists |
| `<model>` | the well-known model of that name, or else another source's model of that name |

| Failure | When |
| --- | --- |
| `ModelNotFound`, with the close names (equal apart from case, or one containing the other) | no source has the name |
| `SourceNotAnswering` | the model's source did not answer |
| `KeyNotSet`, with the variable to set | the model is a well-known provider's and the provider is not in the catalog |

A host reports these in its own words.

## The local server

What is known of a `localhost` model is what the local server's list says (`GET /v1/models`, its
`models` entries): its context window, the kinds of input it accepts (text when none is given), and
its reasoning efforts. An entry, or a value in it, that is written in another form is dropped on its
own (`localCapabilities`).

- `KnownWithLocalServer` puts the server before the well-known models in `KnownModels`. It asks the
  server once, when first needed, logs a warning when the server does not answer, and knows only
  `localhost` models.
- `SettlingWithLocalServer` puts the Chat Completions adapter's settings function first in
  `Settling`, for `localhost`.

## A session as a host runs it

`withSession(options, use)` opens a new session, or continues one from its facts, and runs `use`
with it. It is the session's machinery; what a host's own machinery adds is a list of bolt-ons.

- The facts are in a store: `facts.jsonl` in the session's folder under `root` when the session is
  saved, else in memory, starting from the facts it continues.
- A new saved session's record (`host.json`) names the host that made it, with what else the host
  keeps of it, such as its working folder.
- The services are the host's (`SessionServices` and its own), built with a memo map of their own,
  so that a session opened inside another's does not reuse the other's tool runner or turn
  numbering. The store and the tool sources are `withSession`'s.
- A bolt-on (`BoltOn`) adds tool sources, a part of the opening system text, notice providers, and
  work that starts once the session is open. The CLI's bolt-ons are its working folder's tools (the
  workspace's and the git tools) and its MCP servers. Zork's adventurer's bolt-on is the game's
  world tools.
- The host (`Host`) follows the session from its opening, and chooses whether a turn that a
  previous run left unfinished is gone on with or ended. `Headless` follows nothing and goes on.
- When the run is interrupted during a turn, the interruption is recorded and the turn is waited
  for; a second Ctrl+C exits at once.
- The session's context (`SessionContext`) is made first, from the session's id, its working folder
  (`working`) and the folders the host adds (`additional`), and everything `withSession` runs runs
  in it (`inSession`). Its folders read the session's facts from the store once the store is open.
- The session that `use` is given carries its own services and its own context, so a host can hold
  two sessions at once: zork's game asks its engine and its adventurer in turn, and each call runs
  in the context of the session it calls.

## A session's context

`session-context.ts` makes a session's context (`SessionContext`, `docs/agent-environment.md`) for
every host. It is the one place where a session's folders are assembled.

- `makeSessionContext(place)` makes the context of the session at `place`: the session's id, its
  working folder, and the folders that count as inside it as the host gives them, in order: the
  launcher's (`--add-dir`), the client's (ACP's `additionalDirectories`), then the configuration's
  (`additionalDirectories` of the permissions plug-in, `additionalDirectoriesOf`). A folder from `~`
  is resolved from this process's home folder, and a relative one from the working folder.
- The context's folders are read at each use. They are the folders `place` gives, then the folders
  the user added to the session (`FolderAdded`), read from the session's facts.
- The host gives the context the session's facts once the session's store is open
  (`storeOpened`). Before then the session has no facts. Giving a second store is a defect.
- `openingFolders(place)` returns the folders of `place` before the user adds any: the folders
  that the opening system text names (`workingFolderLine`).
- `inSession(context)` runs an effect in the session: it provides `SessionContext`, annotates each
  log line with `session`, and annotates each span with `session` and `cwd` (the working folder).
  The fibers that the effect starts inherit all three, the loop's requests among them.

| Host | Where it makes the context |
| --- | --- |
| CLI, zork | `withSession`, before the session's store opens. |
| ACP | When `session/new`, `session/load` or `session/resume` creates the session's entry, before the world is opened and the MCP servers are started (`docs/agent-acp.md`). |

A log line written inside a session carries `session`. A line that the CLI writes outside
`withSession` does not carry it: the line that says where `effective-settings.json` was written, and
what the MCP servers log, since the CLI starts them before `withSession` opens the session.

## Session services

`SessionServices(runner)` is what the loop needs for a session apart from its store, its policies
and its turn-end hooks: the model that the facts name, what is known of it and how its settings are
applied, the whole conversation as its context, the clients, turn identities that continue from
those the store holds, and `runner` for its tools.

- `permissionsFor(mode, canAsk)` is the permission policy (`docs/agent-policy.md`) for `mode`. A
  call is judged by its tool's kind in the catalog that the session opened with; a tool not in it is
  treated as changing things. Questions are asked only when `canAsk` is true. `mode` can be an
  effect, read at each call, when the host lets the user change the mode during a session. The
  paths a call names are judged against the session's folders (`SessionContext.folders`), read at
  each call.
- `loopBreaker(settings)` returns the loop breaker's two policies, one per list. The CLI puts the
  loop breaker before the permission policy among the tool call policies, so no one is asked to
  permit a call that the loop breaker vetoes. The ACP host lists the permission policy alone,
  because ACP has no stop reason for a turn that the loop breaker stops.
- `budgetLimit(usd)` vetoes a model request once the session has cost `usd` or more.

## Sessions on disk

A folder of sessions (`directory.ts`) keeps each session in `<root>/<session>/`, with its facts in
`facts.jsonl` and the host's record in `host.json`.

| Function | Returns |
| --- | --- |
| `storedSessions` | the sessions that have a facts file, the one written to last first |
| `readSession` | one session's facts; `SessionNotFound` when the root does not hold it |
| `latestSession` | the session written to last; `NoSessionStored` when there is none |
| `summaryOf` | how many turns a session started, and the model it asks now |

A root that cannot be read fails with `DirectoryUnreadable`.

`host.json` (`record.ts`) is the host's own record of a session: whatever the host keeps that is not
a fact (its working folder, its title). This module stores and returns it as JSON, and does not read
its contents.

- `writeRecord` creates the session's folder when it does not exist, writes the record to another
  file, flushes it to the disk, and renames it over the record, so a reader finds the old record or
  the new one, never part of one. A failed write leaves the existing record as it was.
- `readRecord` returns the JSON written, `undefined` for a session with no record, and fails with
  `RecordFailed`, naming the file, when the record is not JSON or cannot be read.
- `recordedSessions` returns `storedSessions`, each with its record, or `undefined` when it has none
  or its record does not read. An unreadable record is logged as a warning
  (`host_record.unreadable`, with the session, the file and the cause). A folder with a record and
  no facts file is not a session.

## The draft

A draft (`draft.ts`) is a session before its first turn: no session exists and nothing is recorded.
It holds the model to ask, the settings as given, the system prompt and the tools.

- `chooseModel` sets another model and keeps the settings as given, including one that the new
  model does not accept.
- `withSettings` replaces the settings that it names, and keeps the others.
- `optionsOfDraft` returns what a host shows (`optionsFor`): each setting with the value that the
  model will get, so an effort that the model does not accept shows as the nearest one it does.
- `opening(draft, session)` returns the `SessionOpened` observation that opens `session` with the
  draft's model, settings, system prompt and tools. A host opens the session at the first input and
  then drops the draft.
- `withDefaults(draft, capabilities)` gives a draft with no output limit the model's own limit
  (from models.dev, or the user's `models:` override), or 32768 tokens when that is not known. A
  limit that was given stays.
- `defaultModel` is the first model that the catalog lists (`askable`), or none when it lists none.

## Turn-end hook: incomplete responses

`retryIncomplete(retries = 1)` (`incomplete.ts`) is a turn-end hook for models that put their whole
answer in their reasoning. The CLI and the ACP host run it alone, with `MaxHolds` set to `retries`.

- When the latest decision about the turn is `TurnIncomplete` (a whole response with no tool calls
  and no answer text) and the hooks have not held the turn open `retries` times since it started,
  the hook returns `answerNow` ("Your last response had thinking but no answer. Give your answer
  now."), which holds the turn open for one more request.
- An answered turn (`TurnCompleted`) and a response cut short get nothing.
- With no answer after its retries, the turn ends `Incomplete`, and no further request is made.
- The hook counts every input that the turn-end hooks gave the turn, because the facts do not record
  which hook gave it. Because it is the only hook, those inputs are its retries, and the loop's bound
  on holds is the same number. At the bound the loop asks the hooks again, the hook returns nothing,
  and the turn ends with no `TurnHoldsExhausted` and no `holds_exhausted` warning.

## Export

`markdownOf(facts)` (`export.ts`) returns a session's transcript as Markdown, read from its facts
alone: no model and no blob store is asked. A host's `/export` writes it; where is the host's choice.

- The transcript opens with the session's id and the models it asked: the opening model, then each
  change taken, which is also shown where it was taken.
- Each turn follows in order:
  - each input, with its sender and its text as recorded, and each attachment by media type, size
    and blob id;
  - each response's answer text, and its thinking in a collapsed `<details>` block;
  - each tool call: the tool's name, its input fenced, the permission question and answer on one
    line, and how it ended (its output, or why it failed: vetoed with the reason, not run, not
    observed, input rejected, reported by the tool);
  - input dropped when the turn ended;
  - when the turn did not end with an answer, how it ended (cut short, failed with the failure,
    vetoed, interrupted, no answer).
- A call whose response was not recorded is shown where it arrived. A turn with no `TurnEnded` is
  marked as left running, and a call with no `ToolEnded` as having no recorded outcome.
- A tool's text output is fenced with more backticks than any run of backticks it contains, and is
  cut after 8 KiB of UTF-8, never inside a character, with a line giving the number of bytes
  omitted. Bytes are named by media type and size, stored bytes by blob id; they are not read.
- The transcript ends with totals: turns started, model requests made (`requestsIn`), the tokens the
  responses reported, the cost (`costIn`), and the context gauge of the current model when it is a
  well-known one (`contextGauge`).

## Logs

- `LogsToFile(path)` writes log lines to `path`, creating its folder when missing. `LogsToStderr`
  writes them to stderr, for a host whose stdout carries something else.
- `LauncherLogs(options)` (`launcher-logs.ts`) is the ACP launcher's log, because the launcher's
  stdout carries the protocol. `launcherLogOptionsFrom(env)` reads the options from the environment.
  `bun run acp:logs` prints the newest launch's file; `--errors` prints only its warning, error and
  fatal records.
- Each of these layers also names the folder where the bodies of the session's model requests are
  captured (`HttpCaptures`, `src/instrumentation/http-captures.ts`): `http-captures/` beside the log
  file (`LogsToFile`), in the brand's logs folder (`LogsToStderr`), or in the launcher's folder.
  Captures are written only when debug lines are logged.

### Log level

Every entry point (the CLI, the ACP launcher, `runTest`, zork, the spectator, the probes) logs at the
level `<PREFIX>LOG_LEVEL` names (`log-level.ts`; `LABKIT_LOG_LEVEL` for labkit), info by default.
The names are those the CLI's `--log-level` takes: all, trace, debug, info, warn or warning, error,
fatal, none, in any case. The CLI's `--log-level` wins over the variable. The ACP launcher reads
`<PREFIX>ACP_LOG_LEVEL` first, then `<PREFIX>LOG_LEVEL`, then debug. A value that names no level is
passed over, to the next variable or the default, and reported once as a warning
(`host_logs.level_invalid`) with the variable, the value and the level used, in the run's log.

### Launcher log files

Each record at or above the level is one JSON line appended to `<dir>/acp-<pid>-<launch id>.jsonl`;
the folder is created when missing. A record holds its time (ISO), its level (trace, debug, info,
warning, error, fatal), its log annotations (connection, request, session, turn and call ids), its
message and, when there is one, its cause as text with its stack and nested causes. The layer also
sets the minimum log level. The file's path is written to stderr once, at start.

| Variable (after the brand's prefix, `LABKIT_` for labkit) | Default |
| --- | --- |
| `ACP_LOG_DIR` | `~/.local/share/<brand>/logs` |
| `ACP_LOG_LEVEL` | `LOG_LEVEL`, else debug |
| `ACP_LOG_MAX_BYTES` | 10 MiB |
| `ACP_LOG_BACKUPS` | 4 |

A size or backup count that does not parse takes the default; a level that does not parse is
reported (above). Each launch has its own id.

- **Rotation.** A record that would take the file past `maxBytes` first rotates it: `.jsonl` becomes
  `.jsonl.1`, each backup moves up one, and backups past `backups` are deleted.
- **Size limit.** A record whose line is longer than 256 KiB is written cut to fit: its time, its
  level, the start of its line as text (`record`) and the number of bytes omitted (`omittedBytes`).
- **Old launches.** At start, the files of stopped launches beyond the newest 20, by when their
  files were last written, are removed with their backups. A launch whose process is running keeps
  its files and does not count.
- **Failures.** A folder or file that cannot be written is reported once on stderr, and that record
  and every later one go to stderr: the launcher does not stop because of its log.

### Redaction

Every log that a host writes (the launcher's, the CLI's to a file or stderr, a test's) is redacted
(`redaction.ts`):

- The values of the environment variables whose names are credential names (`isCredentialName` in
  `agent-process`: `OPENAI_API_KEY`, `GITHUB_PAT`) are replaced by `<redacted>` wherever they occur
  in a record, its annotations and its cause included. The longest value is replaced first, so a
  secret that contains another is replaced whole.
- The value of a credential field (`authorization`, `apiKey`, `password`, an access token, a cookie)
  is replaced by `<redacted>`, whatever it is. The rest of an error's text stays.
- A value shorter than 8 characters is not searched for, because replacing it would cut ordinary
  text. Each such variable is reported once, when the log is created, as a warning
  (`host_logs.secrets_not_looked_for`) with the variable's name and the value's length, never the
  value.
- A provider's key is held as `Redacted` from the environment to its client (`keyOf`): a log line or
  a string of it shows `<redacted>`.

## Brand

`Brand` (`brand.ts`) is the name the agent goes by. A package that ships the agent passes its own
brand at its entry point; the CLI's `main(brand)` and the ACP launcher's `launch(env, brand)` take it.

- A brand's environment variable prefix is its name in capitals, with every character that is not a
  letter or a digit replaced by `_`, then `_` (`labkit`: `LABKIT_`; `whitelabel-agent`:
  `WHITELABEL_AGENT_`). Its folder, in a home or a project, is `.<name>`.
- The brand is the one the program passes; otherwise the one that `LABKIT_BRAND` names (blank names
  none); otherwise labkit.
- Named after the brand: the configuration folders (`~/.config/<name>/`, `<project>/.<name>/`), the
  folder where the hosts keep what they write (`~/.local/share/<name>/`: every host's sessions in
  `sessions/<version>/`, their blobs in `blobs/`, the log files in `logs/`), the launcher's variables
  (`<PREFIX>ACP_*`), where `/export` writes (`.<name>/exports`), the name the ACP host gives a client
  (`agentInfo`) and the MCP client a server (`clientInfo`), and the CLI's command.

## The brand's folders

`BrandFolders` (`brand-folders.ts`) holds every folder named after the brand, resolved once at each
entry point (the CLI, the ACP launcher, zork) and provided to what runs there; whatever reads or
writes one of them reads it from the service, which has no default. Tests provide one pointed at
their own folder.

| Folder | Default | Moved by |
| --- | --- | --- |
| `config` | `~/.config/<brand>` | `--config-dir` |
| `data` | `~/.local/share/<brand>` | `--data-dir` (an absolute path; a relative one is refused) |
| `sessions` | `<data>/sessions/<version>` | `--data-dir`; the ACP launcher's `--sessions-dir` moves it alone |
| `blobs` | `<data>/blobs` | `--data-dir` |
| `logs` | `<data>/logs` | `--data-dir`; the ACP launcher's own log files: `<BRAND>_ACP_LOG_DIR` |
| `project` | `.<brand>`, in a project's folder | |

The ACP launcher opens its log file once its flags are read, so that `--data-dir` moves it.

## Launch options

`launch.ts` holds what both hosts are launched with: the shared options (`launchFlags`), where an
option that is not given is read from (`launchVariables`), and the configuration layers that the
options make (`launchConfiguration`, over the host's own defaults).

- The options are `--model`, `--permission-mode` (`manual` means `default`), `--strict-tool-input`,
  `--max-turns`, `--max-budget-usd`, `--mcp-config` (repeatable), `--strict-mcp-config`,
  `--add-dir` (repeatable: a folder that counts as inside the working folder), `--settings`,
  `--setting-sources`, `--config-dir` (the user's configuration folder) and `--data-dir` (where the
  hosts keep what they write, in place of `~/.local/share/<brand>/`: an absolute path).
- An option that is not given is read from a variable named: the brand's prefix, the host's part
  (`ACP_` for the ACP launcher, none for the CLI), then the option's name in capitals with `_` for
  `-` (`LABKIT_MAX_TURNS`, `LABKIT_ACP_MAX_TURNS`). `--mcp-config` takes one value from its
  variable. An option given on the command line wins; an empty variable counts as not set; a
  variable value that the option would not accept is that option's error.
- A variable that is not an option's twin (`OTEL_EXPORTER_OTLP_ENDPOINT`) is read under its own
  name, after the name with the brand's prefix and the host's part.
- The layers, merged in order, the last write winning (`docs/agent-config.md`):
  1. the host's defaults;
  2. the files of the user's configuration folder (`--config-dir`, else `~/.config/<brand>/`), then
     the project's files and the local ones when `--setting-sources` names them (they still may not
     name extensions or MCP servers);
  3. `--settings` (JSON, or a file of JSON or YAML);
  4. with `--strict-mcp-config`, a layer that removes the MCP servers of the layers before it;
  5. each `--mcp-config` (JSON, or a file of it, as Claude Code's `.mcp.json`);
  6. the options: `--permission-mode` sets the permission plug-in's mode, `--max-turns` the turn
     request limit, and `--max-budget-usd` the session's budget. A plug-in that an option sets is
     added to the end of the model requests' list when the list does not have it.

## Tests

Each file has a test file beside it: `catalog.test.ts`, `local-server.test.ts`, `clients.test.ts`,
`services.test.ts`, `directory.test.ts`, `record.test.ts`, `draft.test.ts`, `incomplete.test.ts`,
`export.test.ts`, `logs.test.ts`, `launcher-logs.test.ts`, `redaction.test.ts`, `brand.test.ts`,
`launch.test.ts`.
