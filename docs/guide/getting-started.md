# Getting started

## Install

labkit runs from a checkout of this repository, with [Bun](https://bun.sh). Its command parser
is written in Rust and committed as WebAssembly, so running labkit needs no Rust; changing the parser
does (`docs/bash-segments.md`).

```sh
bun install
bun link                 # puts the labkit command on your PATH
```

## Models

labkit asks a model from one of these:

| Provider | What it needs |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| xAI | `XAI_API_KEY` |
| A local OpenAI-compatible server | a server at `http://localhost:8000/v1` |

`labkit models` lists the models you can use, one per line. A model is named `provider/model`, such
as `anthropic/claude-sonnet-5-5`.

## The labkit command

Run `labkit` in the folder you want to work in:

```sh
labkit                                         # a conversation at the terminal
labkit -p "Summarise TODO.md" --model anthropic/claude-haiku-4-5   # one answer, then exit
labkit --continue                              # carry on with the last session in this folder
labkit --resume                                # pick a session to carry on with
labkit --help                                  # every option
```

In a conversation, `/help` lists the commands: `/model` chooses the model, `/effort` the reasoning
effort, `/settings` shows and changes settings, `/export` writes the session as Markdown, `/tools`
lists the tools, `/add-dir` lets the agent work in another folder for the session, `/mcp` shows the
MCP servers, and `/exit` ends the conversation.

The first time you run `labkit` in a folder that has its own `.env` file or `.labkit/` settings, it
asks whether to trust the folder ([Trusted folders](trusted-folders.md)).

## What labkit keeps

| What | Where |
| --- | --- |
| Your settings | `~/.config/labkit/*.yml` |
| The folders you trust | `~/.config/labkit/trusted-folders.json` |
| Each session, so that you can carry on with it | `~/.local/share/labkit/sessions/` |
| Each session's log | `~/.local/share/labkit/logs/` |

## Asking before it acts

labkit reads files in your folder without asking. Before it changes a file or runs a command that
could, it asks, and you can allow that one call or allow it for the rest of the session. A command
is judged by each program it runs, so `git log | head` runs without a question and `git push` asks.
[Permissions](permissions.md) describes what is asked about and how to change it.
