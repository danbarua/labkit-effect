# agent-environment

`src/agent-environment` is the harness's model of the environment the agent acts in: what a shell
command does, read from its words, and where its paths lead. The harness is the environment: the
permission policy (`agent-policy`), the tools (`agent-tools`), the hosts' recording of what a call
changed (`agent-host/recorded-changes.ts`), and the previews of a write (`agent-host/command-writes.ts`)
all read it, so each of them sees a command the same way.

It is an abstract layer: data and pure functions. It imports only `Schema` from `effect` and its own
files, and its strings are branded (`scripts/abstract-layers.ts`; `bun run check:brands`).

## Files

| File | Responsibility |
| --- | --- |
| `command-segments.ts` | A shell command's segments, as the host's parser (`agent-host/command-parser.ts`, the Rust crate `native/bash-segments`) returns them. |
| `command-units.ts` | The programs a command runs, past wrappers; what a session grant names; the paths each reads, writes, deletes, moves or changes (`Unit.paths`), and which a program puts whole (`whole`: `cp`'s destination, `curl -o`'s file); what an `mv` moves (`Unit.moves`); which are opaque. Where each unit's relative paths may lead from (`placesOf`). The files whose text a command writes (`filesWritten`, `textsWritten`). |
| `path-resolver.ts` | A path as a command writes it, resolved against the working folder, the home folder and the additional folders, from the folder a `cd` may have moved to (`resolvePath`). |
| `sed-script.ts` | What a `sed` script does besides transforming text (runs commands, writes files, reads files), and what it does, in plain English. |
| `code-span.ts` | A name as a Markdown code span (`codeSpan`), for the text that names programs, paths and hosts. |

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
