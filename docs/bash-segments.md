# bash-segments

`native/bash-segments` is a Rust crate that splits a shell command into its segments: every
program the command would run, wherever it is written. The permission policy judges a command by
these segments (`docs/agent-policy.md`, Command tools). It is built to WebAssembly and loaded by
the host in the same process (`src/agent-host/command-parser.ts`).

It reports structure only. What a program may do is the policy's to decide
(`src/agent-policy/command-units.ts`). The crate depends on nothing of labkit's, so it could become
a package of its own, as `effective-acp` did.

The walk is adapted from exo-project's structural profiler (spike 01_2,
`~/Code/ai/exo-project/spikes`), which parsed 43,491 commands that Claude Code ran in August 2026.
It parses with brush-parser, at the revision the spikes used.

## Files

| File | What it holds |
| --- | --- |
| `Cargo.toml`, `Cargo.lock` | The crate: brush-parser at a fixed git revision, serde. A library built as `cdylib` (WebAssembly) and `rlib` (its tests). |
| `src/lib.rs` | `segments_of(command)`, the walk, and the C ABI the host calls. |
| `tests/segments.rs` | How commands split, and which are `Unparsed`. |

## What a command splits into

`segments_of` returns `Parsed { segments }` or `Unparsed { reason }`. A segment is a simple
command, a function's definition, a `[[ ]]` test or a `(( ))` expression:

| Field | What it holds |
| --- | --- |
| `kind` | `simple`, `function_definition`, `test` or `arithmetic`. |
| `words` | The program and its arguments, each as written (`text`) and, when it is a literal string, its value with quotes and escapes removed (`literal`). |
| `assignments` | The variables set before the command's name (`X=1 make`). An assignment after the name is an argument (`env X=1 …`, `make A=b`). |
| `redirects` | Its redirects (`op`, `fd`, `target`), then those of each compound command it is inside, innermost first. |
| `fed_text` | Whether its input is a here-document or a here-string. |
| `context` | Where it runs: `command`, `subshell`, `function_body`, `command_substitution` or `process_substitution`. |

A segment is reported wherever it is written:

- in `;`, `&&`, `||` and `&` lists and in pipelines;
- in subshells, brace groups, `if`, `while`, `until`, `for`, `case` and coprocesses;
- in a function's body;
- in command substitutions (`$(…)` and backquotes) and process substitutions (`<(…)`, `>(…)`), in
  words, assignments, redirect targets, `[[ ]]` tests and `(( ))` expressions;
- in a here-document's body, when its delimiter is not quoted, since the body is then expanded.

A word is literal when it has no parameter, command or arithmetic expansion, no tilde expansion,
no unquoted `*`, `?` or `[`, and no brace expansion (`{a,b}`, `{1..3}`). A lone `{`, `}` or `{}` is
literal.

## Failing closed

A command is `Unparsed`, with the reason, when any part of it cannot be followed. A command is never
split without that part:

- the tokenizer or the parser fails;
- a word does not parse;
- a command substitution does not parse;
- a command substitution is inside a parameter expansion (`${x:-$(…)}`), which the walk does not
  follow;
- a word before the command's name that is not an assignment or a redirect.

The policy asks about an `Unparsed` command; when deny rules name programs, it does so in every
mode.

## How the host calls it

`bun run native:build` compiles the crate to `wasm32-unknown-unknown`
(`native/bash-segments/target/wasm32-unknown-unknown/release/bash_segments.wasm`, not committed).
`bun run check` builds and tests it first; without `cargo` or the `wasm32` target it stops with an
ERROR and a HINT (`scripts/native.ts`).

The module exports three functions with a C ABI, and the host (`command-parser.ts`) calls them
synchronously:

| Export | What it does |
| --- | --- |
| `segments_alloc(len)` | Allocates `len` bytes in the module's memory, for the host to write a command into. |
| `segments_json(ptr, len)` | Splits the UTF-8 command at `ptr` and returns its segments as JSON, in a buffer of the module's memory: its address in the high 32 bits, its length in the low 32. |
| `segments_free(ptr, len)` | Frees a buffer that the module allocated or returned. |

Some of brush-parser's dependencies (getrandom, web-time) link wasm-bindgen's hooks on `wasm32`.
The host gives each import the module declares a function that throws when called; splitting a
command calls none of them. When the module is not built, does not load, traps, or answers in a
form that is not known, the command is `Unparsed` with the reason.

## Measuring the policy

`scripts/session-imports/` keeps a corpus of the shell commands that coding agents ran, and
measures the policy over it:

```sh
bun run commands:import [--exo <bash-calls.jsonl>]   # append new commands from saved sessions
bun run commands:ask-rate [--source codex]           # how often the policy asks, and why
```

The corpus is `~/.local/share/<brand>/session-imports/commands.jsonl`: each Claude Code, Codex and
omp session's shell commands, with the session's working folder and model where the transcript
says, and exo-project's August corpus. It only grows, so a command stays after its transcript is
deleted (Claude Code deletes transcripts older than its `cleanupPeriodDays`). `ask-rate` judges each
command with the default settings, as though it were the first in its session and in its session's
order, and writes each judgement to `judgements.jsonl` beside the corpus.

Over 85,042 commands from 542 sessions (2026-10-07), in `default` mode:

| | Runs without a question | Asks, with a grant to offer | Asks about the call only | Does not parse |
| --- | ---: | ---: | ---: | ---: |
| First in its session | 15.4% | 37.1% | 47.2% | 0.3% |

With every grant offered allowed for the rest of its session, 47.6% run without a question. The
questions that offer only the call are mostly reads outside the working folder (paths not written
out, sibling projects, `/tmp`), files written, and code read from input or written in the command.

## Tests

```sh
bun run native:test
```

`tests/segments.rs` checks how lists, pipelines, substitutions (in words, heredocs, `[[ ]]` and
`(( ))`), functions, quoting, assignments and compound redirects split, and which commands are
`Unparsed`. `src/agent-host/command-parser.test.ts` checks the module as the host loads it.
