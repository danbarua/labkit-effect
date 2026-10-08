# The hosts: direction

Dan's rulings about the two hosts (the CLI and the ACP host), the place of labkit beside them, and
the order of work. What is built is described in [agent-host.md](agent-host.md) and
[agent-acp.md](agent-acp.md); what is to be built is listed in `TODO.md`.

## Rulings

Dan, 2026-10-02. Text in quotation marks is verbatim.

- Both hosts are built here, and labkit imports from here. "The core stays out of the workspace, the
  working folder, the tool catalog, the configuration UI and session naming."
- "What you call a Session and what we call a Session don't need 1:1 mappings. Once you've got your
  configuration, user input and model selection in place, the core session can begin. Until then,
  core's got no reason to be journalling facts."
- Configuring: "I think that state is 'the state machine does not yet exist.' You could easily build
  that logic in a separate machine for UI purposes." The CLI is the place to try it.
- "Changes can be delivered to core any time, but they won't be applied until the next turn."
  Whether to offer them while a turn runs is the host's decision.
- A setting stands as the user gave it. The adapter maps it to the nearest value that the provider
  takes (reasoning effort is the example), and records `SettingAdjusted`. A hand-written
  `models.yml` can say anything; a UI is meant to offer only what a model takes.
- The output limit is a hard-coded select of presets, as in the labkit monorepo's host.
- `Session` gets `prompt`, `cancel` and the turn under way.
- "Agent gets given context and tool options, core tells host what options the Agent Exercised. Host
  runs the tools, tells core what happened, core tells the Agent." A workspace is whatever the host
  tells the agent it is; the core records none.
- In ACP the system prompt and the tool catalog are fixed when the session is created, so the host
  provides `ImmutableSystemPrompt` and `ImmutableToolCatalog`.
- `Incomplete` ends an ACP turn as `end_turn`. Whether to retry an incomplete response is the host's
  decision.
- A client's cancelled answer to a permission request is a refusal: the turn goes on, and the model
  asks what to do next. The permission model is machinery, and is not fixed.
- Chat Completions is to be feature-complete (streaming, `max_tokens` as `length`) "because we can
  e2e test for free". labkit-effect builds it.
- labkit's `app-acp` stays in labkit and becomes a consumer of these libraries; what it does on the
  world side is kept.
- "The thinner the host/runtime, the better!"

## labkit beside the hosts

`docs/agent-acp.md` lists the layers that are built here. One more layer is planned:

| Layer | Where | Is |
| --- | --- | --- |
| labkit | `packages/app-acp` in labkit-agent | The world side of the ACP host: workspace files, the editor's files and terminal as tools, MCP, elicitation, plans, commands. It plugs into `agent-acp`. |

## Order of work

Built: the ACP host over stdio for protocol v1, with drafts, config options, permission, stop
reasons, `usage_update`, `/export`, `/mcp`, the editor's tools, MCP servers, attachments, and
`session/load`, `resume` and `list` over the session directory. It has run against the local Qwen
with the SDK's client.

1. The ACP host in VS Code, then JetBrains.
2. The CLI opens its session at its first input, from a draft: the place to try turn zero.
3. Streamable HTTP with a token and one holder for a session; elicitation; `session/delete`;
   `session/fork` once the core has an identity for a fork.
4. labkit's `app-acp` as a consumer.

## Open

- The shape of the seam between `agent-acp` and labkit's `app-acp`, to be drawn from the first
  slice.
- A `models.yml` as one more source for the catalog. The catalog is a service, so a file source can
  be added; it is not in the first slice.
- What a reopened session shows as a tool call's content (parked by Dan). The default presentation
  shows the diffs of the files a call changed, from what it recorded, and its output as text.

## What the ACP host still needs of the core

| Need | Where |
| --- | --- |
| An end item for each attempt of a model request on `streamed`: a fallback's failed attempt leaves its text on screen, and the next attempt's text is sent after it. | `TODO.md`, Providers |
