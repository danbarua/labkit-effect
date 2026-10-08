# agent-environment

`src/agent-environment` is the harness's model of the environment the agent acts in: what a shell
command does, read from its words, and where its paths lead. The harness is the environment: the
permission policy (`agent-policy`), the tools (`agent-tools`), the hosts' recording of what a call
changed (`agent-host/recorded-changes.ts`), and the previews of a write (`agent-host/command-writes.ts`)
all read it, so each of them sees a command the same way.

It is not an abstract layer: the environment is live (the session's processes, its environment
variables, git), so the module may use Effect's services and run effects. It is held to the rules of
functional code (`oxlint.config.ts`, `functionalModules`). The policy, an abstract layer, imports
its pure parts.

## Files

| File | Responsibility |
| --- | --- |
| `command-segments.ts` | A shell command's segments, as the host's parser (`agent-host/command-parser.ts`, the Rust crate `native/bash-segments`) returns them. |
| `command-units.ts` | The programs a command runs, past wrappers; what a session grant names; the paths each reads, writes, deletes, moves or changes (`Unit.paths`), and which a program puts whole (`whole`: `cp`'s destination, `curl -o`'s file); what an `mv` moves (`Unit.moves`); which are opaque. Where each unit's relative paths may lead from (`placesOf`). The files whose text a command writes (`filesWritten`, `textsWritten`). |
| `path-resolver.ts` | A path as a command writes it, resolved against the working folder, the home folder and the additional folders, from the folder a `cd` may have moved to (`resolvePath`). |
| `sed-script.ts` | What a `sed` script does besides transforming text (runs commands, writes files, reads files), and what it does, in plain English. |
| `code-span.ts` | A name as a Markdown code span (`codeSpan`), for the text that names programs, paths and hosts. |
| `session-context.ts` | `SessionContext`: the session that code runs in, with its id, its working folder and its folders. |

## The session's context

`SessionContext` is the session that code runs in. It is an Effect service with no default value,
so code that reads it compiles only where a host provides it.

| Field | Value |
| --- | --- |
| `session` | The session's id (`SessionId`). |
| `working` | The working folder, as an absolute path. |
| `folders` | An effect that returns the folders that paths are judged against (`Folders`): the working folder, the home folder, and the additional folders, all absolute. |

Each host makes the context once, where the session's resources start, with the builder in
`agent-host/session-context.ts` (`docs/agent-host.md`), and runs the session's work in it:

- The CLI and zork make it in `withSession`, before the session's store opens.
- The ACP host makes it when `session/new`, `session/load` or `session/resume` creates the session's
  entry, before it opens the world and starts the MCP servers. The context lasts as long as the
  entry.

What runs inside the session reads the context:

- the permission policy, through the plug-in's entry (`permissionsFor`);
- the tools, when a call runs (`ToolSource.run`; `sourceOf` leaves the context to the call);
- the recording of what a call changes (`agent-host/recorded-changes.ts`);
- the previews of a write, in the ACP world and the REPL (`agent-host/command-writes.ts`);
- the explanation of a permission question, in the ACP feed and the REPL.

The loop runs each request in a fiber that inherits the context from the fiber that recorded the
observation, so a tool or a policy that a plug-in adds reads the id of the session it runs in.

`folders` is read at each use. The additional folders are those the host gives (the launcher's, the
client's and the configuration's) followed by the folders that the user added to the session
(`FolderAdded`), which are read from the session's facts at each use. Nothing keeps a copy of the
facts. Before the session's store is open, the session has no facts, so `folders` returns the
folders the host gives: an ACP session has no store until its first prompt.

## Where a command's paths lead

`placesOf` follows a command's `cd`, `pushd` and `popd` in order. For each unit it gives the folders a
relative path may lead from, and whether that is not known:

- a `cd` or `pushd` to a folder written out adds that folder, since the command may or may not have
  moved by then (`cd x || true`);
- after a `popd`, a `cd -`, or a `cd` to a folder not written out, where a relative path leads is not
  known.

Each command runs in a fresh shell in the working folder, so no folder carries over between calls.
The policy judges a relative path in every folder it may lead from; the recording reads it in each,
and records only the file that changed; the preview shows a diff only when the path names one file.

## Tests

`command-units.test.ts`, `sed-script.test.ts`, `code-span.test.ts`; `native/bash-segments/tests`
for how a command splits into segments (`bun run native:test`).
