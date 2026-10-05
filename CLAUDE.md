# labkit-effect

`src/agent-machine`: pure machines (agent, conversation turn, turn step, call).
Facts are Observations (each with an Origin) or Decisions. Effects are requested.

`src/agent-session`: `loop.ts` is the agentic loop.
Everything else is composable, extensible logic plugged in at sensible seams.

`src/agent-session/configuration`: the model a session asks and its settings, read from its facts;
what is known of each model; what a host offers to change (`options.ts`).

What is built is described in `docs/<module>.md`; what is not built is in `TODO.md`.

## Commands

- `bun run check`: typecheck, lint and tests. Run it before committing.
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
(`effect@4.0.0`), vendored with `git subtree --squash`. It is reference
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
- `logs/cli/<session>/`: a CLI session's facts (its session store), its log, and what its
  configuration resolved to (`effective-settings.json`).
- `logs/commands/`: the output of commands run by hand, such as `bun run check`.

Run commands whose output goes to a file with `FORCE_COLOR=0 NO_COLOR=1`. Claude Code's shell sets
`FORCE_COLOR`, which overrides `NO_COLOR`, so without both the files under `logs/` fill with
terminal colour codes.
