# Zork spectator

A phone page that begins a Zork game (`../zork`) and shows it as it is played:

```sh
# Set the key of each provider whose models you want to choose, then:
bun run zork:spectator
# Open http://localhost:3001 on a phone-sized screen.
```

The server listens on `localhost` only, so only this machine can open the page and begin a game.

To see the page without a provider's key, run the scripted spectator instead:

```sh
bun run zork:spectator:scripted
# Open http://localhost:3002.
```

Whichever models are chosen, it plays the same short game with scripted players
(`zork/scripted.ts`), one answer every 1.5 seconds, and is eaten in game turn 7. Its sessions and
transcripts are kept in `logs/zork-spectator/scripted/`.

## Setup

The page shows two pickers, Engine and Adventurer, each with the same models:

| Label | Model | Key |
| --- | --- | --- |
| Sonnet | `claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| Haiku | `claude-haiku-5-5` | `ANTHROPIC_API_KEY` |
| Grok | `grok-4.7` | `XAI_API_KEY` |
| Grok Build | `grok-build-0.1` | `XAI_API_KEY` |
| GPT Sol | `gpt-6.1-sol` | `OPENAI_API_KEY` |
| GPT Luna | `gpt-6-luna` | `OPENAI_API_KEY` |

The Engine and the Adventurer may be the same model. **Begin game** is disabled until both are
chosen. A model whose key is not set is refused when the game begins, with an `ERROR` and a `HINT`
under the button. Once a game starts, the pickers are locked and show who is playing.

## The game

The process owns one game at a time (`match.ts`). Every page that is open, or opens while the game
runs, shows that game from its start; a page that reloads or reconnects shows it again. A Begin
while a game runs shows the running game.

The page has two terminal panels, Engine and Adventurer. Swipe between them, or tap their names.

- The Engine panel shows the opening scene, then the narration of each game turn.
- The Adventurer panel shows the tools offered in each game turn, then the tool call that played it.
- The status line on both panels shows the game turn of 30, the room, and `ALIVE` or `EATEN`, from
  the world after each action.

Each action and each narration is sent as soon as it is played. The world itself is not sent.

When the world says the Adventurer was eaten, both panels stop on that game turn. A game that cannot
go on (a provider's failure, or an Adventurer that does not act) stops too, with the status line on
both panels showing `ERROR:` and what failed. A tap on a stopped game, away from the panel names,
returns to setup with nothing chosen.

Each game is played as `bun run zork` plays one (`zork/scenario.ts`, with the players of
`zork/players.ts`): its two sessions, logs and transcript are saved in the same places, its spans go
to OTLP as the service `labkit-zork`, and it has the same ten-minute limit.

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | The entrypoint: the live players and the server on port 3001. |
| `scripted.ts` | The scripted entrypoint: scripted players and the server on port 3002. |
| `match.ts` | The one game: its state, what a page is sent of it, and Begin. |
| `server.ts` | The HTTP routes: the page, the state as server-sent events, and Begin. |
| `page.html` | The phone page. |

```sh
bun test tests/examples/zork-spectator.test.ts
```
