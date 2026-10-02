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
  itself (`localCapabilities`). `KnownWithLocalServer` asks the server once, when first needed,
  and logs that it did not answer; the other providers' models are the well-known ones.
  `SettlingWithLocalServer` applies a `localhost` model's settings as the Chat Completions adapter
  does.
- H4. `PermissionsFor(mode, canAsk)` is the permission policy (`agent-policy/permissions.ts`) for
  `mode`: a call is judged by the kind its tool has in the catalog the session opened with (a tool
  not in it is taken to change things), and asked about only when `canAsk`.
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
but its store and its permission policy: the model its facts name, what is known of it and how its
settings are applied (H3), the whole conversation as its context, the clients, turns that count on
from those its store holds, no turn-end hooks, and `runner` for the host's tools.

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

## What is not built

- A source of the catalog read from a hand-written `models.yml`.
- A host's own record of a session in its folder (its title, its working folder).
- The ACP launcher's log file: JSONL, rotated, secrets redacted (`DESIGN.next.md`, Logs).
