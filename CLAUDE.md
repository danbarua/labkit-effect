# labkit-effect

`src/agent-machine`: pure machines (agent, conversation turn, turn step, call).
Facts are Observations (each with an Origin) or Decisions. Effects are requested.

`src/agent-environment`: the harness's model of the environment the agent acts in: what a shell
command does and where its paths lead. The policy, the tools and the hosts read it.

`src/agent-session`: `loop.ts` is the agentic loop.
Everything else is composable, extensible logic plugged in at sensible seams.

`src/agent-session/configuration`: the model a session asks and its settings, read from its facts;
what is known of each model; what a host offers to change (`options.ts`).

What is built is described in `docs/<module>.md`; what is not built is in `TODO.md`.

## User-facing text

User-facing text is CLI output, errors and hints, `/help`, flag descriptions, ACP option names and
values, and the reasons a setting is not sent. It uses the user's words, not the code's. The code's
own terms ("facts", "session store", "asked", "taken", "said", "offered", "ImmutableSystemPrompt")
do not appear in it.

- An error is `ERROR: <what is wrong>.` and, when there is something to do, `HINT: <one action>.`
- A list of choices shows at most three, then says where to see the rest. It is never a
  comma-separated wall of names.
- Outside the REPL, a hint names no slash command.

| Not this | This |
| --- | --- |
| `No model is named localhost/.` followed by every known model | `Unknown model: localhost/.` / `HINT: Did you mean localhost/qwen3.5-9b-8bit? …` |
| `XAI_API_KEY is not set, so xai models cannot be asked.` | `xai models are unavailable: XAI_API_KEY is not set.` |
| `Not settings the session takes: Expected "minimal" \| … at ["effort"]` | `Invalid value for effort: loud.` / `HINT: Use one of: default, minimal, …` |
| `openai/gpt-5 does not take thinking=disabled.` / `HINT: openai/gpt-5 takes no thinking setting.` | `openai/gpt-5 has no thinking setting.` |
| `Asking openai/gpt-5.5 effort=low` / `this model takes effort: …` | `openai/gpt-5.5 · effort=low` / `Efforts: low, medium, high, xhigh` |
| `No command /nope.` / `HINT: /help lists them.` | `Unknown command: /nope.` / `HINT: Type /help to list the commands.` |

## Commands

- `bun run check`: typecheck, lint and tests. Run it before committing.
- `bun run native:build`: after a change to `native/bash-segments`, builds the command parser and
  copies it to `native/bash-segments/bash_segments.wasm`, which is committed; `check` fails until the
  committed module is the one the crate builds.
- Don't pipe `bun test`: redirect its output to a file under `logs/commands/` and read the file.
- `bun cli` is a REPL and waits for input. From an agent's shell, use
  `bun --silent cli -p "<prompt>" --model <model>`.

## Bun

Use Bun, not Node.js: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`.
`bun pm pkg get scripts` lists the scripts. Bun loads `.env` itself.

## Effect source

When you need to find information about Effect, start at `repos/effect/LLMS.md`
and the Effect source code available in your environment.

`repos/effect` is the Effect repository at the tag of the version installed
(`effect@4.0.2`), vendored with `git subtree --squash`. It is reference
material: read it for APIs, examples and implementation details; do not edit it
or import from it. `~/Code/lib/effect` is an older beta and does not match what
is installed.

To move to another version, install it, then:
`git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git "effect@<version>" --squash`

## Output written to files

`logs/` (not committed) holds what runs write, a folder for each thing that wrote it:

- `logs/tests/<test file>/<test name>/`: a test's log lines (`log.jsonl`) and the files it makes
  (`testFolder()`), emptied when the test starts.
- `logs/probes/<probe>/<run>/`: a live probe's transcript, facts and telemetry.
- `logs/e2e/<script>/<run>/`: a live end-to-end run of `scripts/e2e/<script>.ts`: what it printed,
  and the facts and log of the sessions it ran, each script checking them and exiting 1 on a failure.
- `logs/commands/`: the output of commands run by hand, such as `bun run check`.

The hosts keep what they write outside the repository, in `~/.local/share/<brand>/`, or the folder
`--data-dir` names (`src/agent-host/brand-folders.ts`, `BrandFolders`):

- `sessions/<version>/<session>/`: a session's facts (`facts.jsonl`, its session store), its record
  (`host.json`: the host that made it and its working folder) and, for the CLI, what its
  configuration resolved to (`effective-settings.json`). The CLI and the ACP host share the folder.
- `blobs/`: the bytes that sessions' facts refer to (inputs' images and files, stored outputs), each
  a file named `<sha256>.<extension>`, for every session of both hosts.
- `logs/`: the CLI's log of each session (`cli-<session>.log`) and the ACP launcher's logs.

Run commands whose output goes to a file with `FORCE_COLOR=0 NO_COLOR=1`. Claude Code's shell sets
`FORCE_COLOR`, which overrides `NO_COLOR`, so without both the files under `logs/` fill with
terminal colour codes.
