# Zork

Run a text adventure with two AI models using the agent harness:

```sh
# Set ANTHROPIC_API_KEY in your environment, then:
bun run zork
```

The Game Engine uses `claude-sonnet-5-5`; the Adventurer uses `claude-haiku-4-5`.
Override them with positional arguments: any Claude, GPT or Grok model that `bun cli models` lists.
Each model is asked as the CLI asks it, with its provider's key: a GPT model reads `OPENAI_API_KEY`
and a Grok model `XAI_API_KEY`, and the two may be of different providers:

```sh
bun run zork claude-sonnet-5-5 claude-sonnet-5-5
bun run zork gpt-6.1-sol gpt-6-luna
bun run zork grok-4.7 grok-build-0.1
```

Each game is two sessions, each run as any host runs a session (`agent-host/with-session.ts`):
`zork-engine-<game>` and `zork-adventurer-<game>`, saved in `~/.local/share/labkit/sessions/`
with a record that names zork, the game and the role, and logging to
`~/.local/share/labkit/logs/zork-<role>-<game>.log`. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, a
game is one trace (`zork.game`, with both sessions under it), and its log lines carry the game's
id and the session's.

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

An Adventurer's requests can be changed for its model (`customisations.ts`). A
customisation is given the game's state and each request as the game makes it,
and returns the request to send; the Adventurer's session records each request
as it was sent. `index.ts` gives the Adventurer the customisation listed for its
model, and the game itself is the same for every model. Claude Haiku 4.5 has one:
while the Engine offers tools, each request requires a tool call, each offered
tool is constrained (Anthropic's strict tool use), and `move` takes only the open
exits. The reply after an action is sent unchanged. The Anthropic API refuses a
required tool call while thinking is on, so the customisation depends on Haiku
playing with its thinking disabled, as `index.ts` sets it. Other models play
without a customisation.

Completed games write `logs/zork/<UTC-date-and-time>-<unique-id>.md`, including
the models, opening, offered tools, successful tool calls, world results and
Engine narration. The CLI prints the path. Session facts retain rejected calls
and provider details; the readable transcript shows the successful actions.

```sh
bun test tests/examples/zork.test.ts
```

`scenario.ts` exports `play(setup)` for other model clients; `index.ts` supplies
the live setup. Set an observation origin using `reportedBy` when calling `play`
directly (the CLI and `runTest` already do). The result includes both sessions'
facts, the final world and the transcript path. Tests can set `setup.directory`
to keep transcripts in their own log folders.
