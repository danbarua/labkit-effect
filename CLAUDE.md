# labkit-effect

`src/agent-machine`: pure machines (agent, conversation turn, turn step, call).
Facts are Observations (each with an Origin) or Decisions. Effects are requested.

`src/agent-session`: `loop.ts` is the agentic loop.
Everything else is composable, extensible logic plugged in at sensible seams.

What is built is in each module's `MODEL.md`; what is not, in `TODO.md`.

## Commands

- `bun run check`: typecheck, lint and tests. Run it before committing.
- Don't pipe `bun test`: redirect its output to a file under `logs/` and read the file.
- `bun cli` is a REPL and waits for input. From an agent's shell, use
  `bun --silent cli -p "<prompt>" --model <model>`.

## Bun

Use Bun, not Node.js: `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <package>`.
`bun pm pkg get scripts` lists the scripts. Bun loads `.env` itself.

## Effect source

When you need to find information about Effect, start at `repos/effect/LLMS.md`
and the Effect source code available in your environment.

`repos/effect` is the Effect repository at the tag of the version installed
(`effect@4.0.0-rc.118`), vendored with `git subtree --squash`. It is reference
material: read it for APIs, examples and implementation details; do not edit it
or import from it. `~/Code/lib/effect` is an older beta and does not match what
is installed.

To move to another version, install it, then:
`git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git "effect@<version>" --squash`

## Output written to files

Run commands whose output goes to a file with `FORCE_COLOR=0 NO_COLOR=1`. Claude Code's shell sets
`FORCE_COLOR`, which overrides `NO_COLOR`, so without both the files under `logs/` fill with
terminal colour codes.
