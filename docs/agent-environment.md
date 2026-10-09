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

| File                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                            |
|--------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `command-segments.ts`    | A shell command's segments, as the host's parser (`agent-host/command-parser.ts`, the Rust crate `native/bash-segments`) returns them.                                                                                                                                                                                                                                                                                    |
| `command-units.ts`       | The programs a command runs, past wrappers; what a session grant names; the paths each reads, writes, deletes, moves or changes (`Unit.paths`), and which a program puts whole (`whole`: `cp`'s destination, `curl -o`'s file); what an `mv` moves (`Unit.moves`); which are opaque. Where each unit's relative paths may lead from (`placesOf`). The files whose text a command writes (`filesWritten`, `textsWritten`). |
| `path-resolver.ts`       | A path as a command writes it, resolved against the working folder, the home folder and the additional folders, from the folder a `cd` may have moved to (`resolvePath`).                                                                                                                                                                                                                                                 |
| `sed-script.ts`          | What a `sed` script does besides transforming text (runs commands, writes files, reads files), and what it does, in plain English.                                                                                                                                                                                                                                                                                        |
| `code-span.ts`           | A name as a Markdown code span (`codeSpan`), for the text that names programs, paths and hosts.                                                                                                                                                                                                                                                                                                                           |
| `command-environment.ts` | The environment variables that a command runs with, as the harness knows them (`CommandEnvironment`): known, or unknown with the reason.                                                                                                                                                                                                                                                                                  |
| `session-context.ts`     | `SessionContext`: the session that code runs in, with its id, its working folder, its folders and its environment.                                                                                                                                                                                                                                                                                                        |

## The session's context

`SessionContext` is the session that code runs in. It is an Effect service with no default value,
so code that reads it compiles only where a host provides it.

| Field         | Value                                                                                                                                                      |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `session`     | The session's id (`SessionId`).                                                                                                                            |
| `working`     | The working folder, as an absolute path.                                                                                                                   |
| `folders`     | An effect that returns the session's folders (`Folders`): the working folder, the home folder, and the additional folders from every source, all absolute. |
| `foldersFrom` | Returns an effect that returns the working folder, the home folder, and the additional folders whose source the given function accepts.                    |
| `environment` | The environment variables of each process that the harness starts for the session (`KnownEnvironment`, below).                                             |

Each host makes the context once, where the session's resources start, with the builder in
`agent-host/session-context.ts` (`docs/agent-host.md`), and runs the session's work in it:

- The CLI makes it in `withCliSession`, before it writes the session's settings and starts its MCP
  servers. Zork makes one for each of its two sessions. Each passes the context to `withSession`,
  which opens the session's store in it.
- The ACP host makes it when `session/new`, `session/load` or `session/resume` creates the session's
  entry, before it opens the world and starts the MCP servers. The context lasts as long as the
  entry.

What runs inside the session reads the context:

- the permission policy, through the plug-in's entry (`permissionsFor`);
- the tools, when a call runs (`ToolSource.run`; `sourceOf` leaves the context to the call);
- the recording of what a call changes (`agent-host/recorded-changes.ts`);
- the previews of a write, in the ACP world and the REPL (`agent-host/command-writes.ts`);
- the explanation of a permission question, in the ACP feed and the REPL;
- `run_command` and the MCP servers' processes, for their environment variables;
- the ACP worlds, for the session's id, its working folder, its folders and its environment.

The loop runs each request in a fiber that inherits the context from the fiber that recorded the
observation, so a tool or a policy that a plug-in adds reads the id of the session it runs in.

`folders` and `foldersFrom` are read at each use. The additional folders are projected from the
session's facts (`agent-session/configuration/session-home.ts`): each `FolderAdded` adds a folder
from its source, and each `FolderRemoved` takes the folder away from that source. Nothing keeps a
copy of the facts. A source (`FolderSource`) is one of these:

| Source        | Gives                                                                                                |
|---------------|------------------------------------------------------------------------------------------------------|
| `User`        | the folders the user adds during the session (the CLI's `/add-dir`)                                  |
| `Launcher`    | the launcher's `--add-dir`                                                                           |
| `Client`      | the ACP client's `additionalDirectories`                                                             |
| `Permissions` | a permissions entry's `additionalDirectories`, by the name that the configuration lists the entry by |

Each open records the folders that the host gives from each source other than `User`
(`docs/agent-host.md`). Until it has recorded them, `folders` includes them: an ACP session has no
store until its first prompt, and its folders are then the ones its open will record.

Who reads which folders:

| Reader                                                                                                  | Folders                                                                                                                                                                          |
|---------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| the recording of what a call changes, the previews of a write, the explanation of a permission question | `folders`: every source                                                                                                                                                          |
| a permissions entry (`permissionsFor`)                                                                  | `foldersFrom`: `User`, `Launcher`, `Client`, and the entry's own `Permissions` folders. A folder that only another permissions entry names is outside the working folder for it. |

## The session's environment

`CommandEnvironment` (`command-environment.ts`) is what the harness knows of the environment
variables that a command runs with:

| Tag       | When                                      | Holds                                                                                                                                        |
|-----------|-------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `Known`   | The harness starts the command's process. | `variables`: the variables the process receives. `leftOut`: the names of this process's variables that the process does not receive, sorted. |
| `Unknown` | Another program starts the process.       | `reason`: why the harness does not know the variables.                                                                                       |

`SessionContext.environment` is `Known`. The host's builder (`agent-host/session-context.ts`) makes
it once, when it makes the context: it applies the configuration's `commandEnvironment` transforms
in order to this process's environment. When the configuration lists no transforms, the builder
applies the default: this process's environment without its credential variables (`credentials`
with no `pass`). A change to this process's environment after the context is made does not reach
the session.

The harness gives the session's environment to each process that it starts for the session:

| Process                                                                         | Environment                                                                                                         |
|---------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `run_command` (the CLI, and ACP's `workspaceWorld`)                             | the session's environment, read when the call runs                                                                  |
| an MCP server over stdio (`agent-mcp`, through `agent-process`'s process group) | the session's environment as it is when the server's process group is made, with the server's own `env` set over it |
| `connectStdio` (tests and probes)                                               | the session's environment, with the server's own `env` set over it                                                  |

A world in ACP (`agent-acp/world.ts`) says which environment its commands run with (`WorldSession.environment`):

- `workspaceWorld`: the session's environment.
- `editorWorld`: `Unknown`. The editor runs `terminal_command` in its own terminal, with the
  editor's environment, which the harness does not see. The harness sets no variable of that
  command's process.

No code reads `WorldSession.environment` yet.

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
for how a command splits into segments (`bun run native:test`). The session's environment is tested
where its processes start: `agent-tools/workspace.test.ts` (`run_command`),
`agent-process/environment.test.ts` (a process group's run), `agent-mcp/client.test.ts`
(`connectStdio`), `examples/cli-repl/session.test.ts` (a CLI session's MCP server, under the default
and under a configured command environment) and `agent-acp/host.test.ts` (the world's).
