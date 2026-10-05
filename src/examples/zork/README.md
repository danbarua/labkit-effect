# Zork

Run one improvised text adventure with two AI models using the agent harness:

```sh
# Set LABKIT_ANTHROPIC_API_KEY in your environment, then:
bun run zork
```

The Game Engine uses `claude-sonnet-4-5`; the Adventurer uses `claude-haiku-4-5`.
Override either model with positional arguments:

```sh
bun run zork claude-sonnet-4-5 claude-sonnet-4-5
```

Each role has a separate session, system prompt, fact store and conversation history.
Both prompts include the commands from [GAME.md](./GAME.md). The engine improvises
the world and tracks its state; the Adventurer sees its descriptions and chooses
commands. Only the engine is told about the inevitable Grue ending.

The opening scene is followed by at most 15 turns. One turn is one Adventurer
command and the Game Engine's response. A terminal response ends the round
immediately. The engine marks death with the exact final line `You have been eaten
by a Grue.` If it misses that instruction by turn 15, the runner adds a separately
labelled Grue epilogue. Model responses remain intact in the transcript and facts.
Provider failures, incomplete responses and timeouts fail the run instead of being
reported as completed games. The CLI has a ten-minute timeout.

A completed round writes `logs/zork/<UTC-date-and-time>-<unique-id>.md`. The
transcript includes the models, opening, numbered exchanges, and ending. The
unique suffix prevents runs from overwriting each other. The CLI prints its path.

Run the deterministic harness tests without an API key:

```sh
bun test tests/examples/zork.test.ts
```

`scenario.ts` exports `play(setup)` for experiments with other model clients;
`anthropic.ts` supplies the live setup. As with other harness callers, set an
observation origin using `reportedBy` (the CLI and `runTest` already do this).
`play` returns each session's facts and the saved transcript path. Tests can set
`setup.directory` to keep their transcripts in their own log folders.
