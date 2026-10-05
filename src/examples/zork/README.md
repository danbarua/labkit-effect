# Zork

Run a text adventure with two AI models using the agent harness:

```sh
# Set LABKIT_ANTHROPIC_API_KEY in your environment, then:
bun run zork
```

The Game Engine uses `claude-sonnet-4-5`; the Adventurer uses `claude-haiku-4-5`.
Override them with positional arguments:

```sh
bun run zork claude-sonnet-4-5 claude-sonnet-4-5
```

The runner owns a small world: six connected locations, a mailbox, a trapdoor,
a leaflet, a lantern, a sword and treasure. Inventory, item locations, open exits,
lantern fuel and death are facts in `world.ts`. Neither model can change them by
narrating an event. Both receive authoritative snapshots, and successful tool
results are recorded in the Adventurer's session facts.

The Engine narrates each snapshot and selects the next turn's tools by returning
`{"narration":"...","tools":["look","move",...]}`. This must be a nonempty
subset of the world's available actions while alive, and empty after death.
A plain JSON object or one wrapped in a JSON code fence is accepted. The
Adventurer receives the selected tool schemas and calls one to act. The runner
validates inputs, checks availability and ownership, and applies one action
atomically. Unoffered tools and extra calls cannot mutate the world. After a
successful call, the next model request has no tools and asks for a brief reply.

The supported actions are `look`, `inventory`, `examine`, `move`, `take`, `drop`,
`open`, and `light`. Directions accept full names or `n`, `s`, `e`, `w`, `u`, `d`.
Target arguments use IDs from the world snapshot. Dropped items stay in their
room. A lit lantern protects its room or carrier and burns fuel on each action.

One successful tool call consumes one game turn, including look and inventory.
Invalid calls do not consume turns. The opening and Engine narration consume
none. There are at most **30 turns**. Entering an underground room without light,
or exhausting your fuel there, ends the game with a Grue attack. At turn 30,
unnatural night extinguishes all light and the Grue attacks wherever you are.
The world determines death, independent of narration. If the Engine omits the
terminal line, a separately labelled runner epilogue supplies it.

Each model has its own harness session, prompt, fact store and history. The
Adventurer's session records the full supported tool catalog at opening; its
context assembler filters that catalog to the Engine's current selection on each
request. The tool runner independently enforces that selection. A policy caps
each harness turn at four model requests, so invalid calls cannot loop forever.
If the Adventurer replies without acting, turn-end feedback asks it to call a
tool, at most twice within that request limit. Provider failures, invalid Engine
selections and persistent failure to act fail the run. The CLI has a ten-minute
timeout.

Completed games write `logs/zork/<UTC-date-and-time>-<unique-id>.md`, including
the models, opening, offered tools, successful tool calls, world results and
Engine narration. The CLI prints the path. Session facts retain rejected calls
and provider details; the readable transcript shows the successful actions.

```sh
bun test tests/examples/zork.test.ts
```

`scenario.ts` exports `play(setup)` for other model clients; `anthropic.ts` supplies
the live setup. Set an observation origin using `reportedBy` when calling `play`
directly (the CLI and `runTest` already do). The result includes both sessions'
facts, the final world and the transcript path. Tests can set `setup.directory`
to keep transcripts in their own log folders.
