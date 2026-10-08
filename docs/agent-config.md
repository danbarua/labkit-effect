# agent-config

`src/agent-config` reads a session's configuration: the plug-ins that a session's logic is built
from, the lists ("seams") that each plug-in is placed on, and the MCP servers that a session starts.
The configuration comes from layers, merged in order; the last write wins.

Direction that is not built yet (the model's settings, and the adapters that apply them) is in
[agent-config-direction.md](agent-config-direction.md). Example configuration folders, which a test
loads, are in `src/agent-config/fixtures/`.

```yaml
# yaml-language-server: $schema=../schemas/config.schema.json
extensions:            # the user's own file only
  - ./my-plugin.ts
plugins:
  loopBreaker: { nudgeAt: 3, stopAt: 5 }
  strict: { use: loopBreaker, stopAt: 3 }   # a second loop breaker, with its own settings
  permissions:
    mode: default
    allow: ["command(bun test:*)", "command(make build)"]   # docs/agent-policy.md, Rules
    deny: ["command(git push:*)", git_push]
toolCalls: [loopBreaker, permissions]
modelRequests: [loopBreaker, maxTurnRequests]   # maxTurnRequests: its defaults
turnEnd: [retryIncomplete]
maxHolds: 1
mcpServers:
  github: { command: gh-mcp, args: [--read-only], required: true, connectTimeout: 10 seconds }
```

## Files

| File | Responsibility |
| --- | --- |
| `plugin.ts` | What a plug-in is, the seams, and `FromHost` (what the host provides that a file cannot). |
| `builtins.ts` | The built-in plug-ins: `loopBreaker`, `permissions`, `maxTurnRequests`, `retryIncomplete`, `maxBudget`, `credentials`. |
| `folders.ts` | The configuration folders (`configFolders`) and the error that refuses a configuration (`ConfigInvalid`). It imports nothing else from the agent but the brand, so a program that imports the brand's folders (`agent-host/brand-folders.ts`) does not load the configuration. |
| `file.ts` | The configuration files' layers (`fileLayers`, `fileLayer`), decoding (`loadConfiguration`), and the MCP servers. |
| `merge.ts` | Merging layers of parsed values. |
| `seams.ts` | `seamListsOf`: the lists that a configuration gives a session, and the layer that provides them. |
| `effective.ts` | `effective-settings.json`: what a configuration resolved to, and which layer wrote each value. |
| `schema.ts` | The JSON Schema of a configuration file, kept at `schemas/config.schema.json`. |

## Layers

A host builds the layers (`agent-host/launch.ts`): its own defaults, then the files, then what its
command line gives (`--settings`, `--mcp-config`, flags). Both hosts, the CLI and the ACP host,
read layers.

| Files | Trusted | Read |
| --- | --- | --- |
| the user's configuration folder: `~/.config/<name>/`, or `--config-dir` (an absolute path) | yes | always |
| the project's folder, `<project>/.<name>/`: its files other than `*.local.yml` | yes | with `--setting-sources project`, in a trusted folder |
| the project's folder: the user's own files for the project, `*.local.yml` | yes | with `--setting-sources local`, in a trusted folder |

- Each file is a layer. A folder's files are its `.yml` and `.yaml` files, read in the order of their
  names (code-unit order), so a name can start with a sorting prefix: `10_policies.yml`,
  `20_mcp.yml`. A sorting prefix needs the same number of digits in every name, because `100_` sorts
  before `20_`.
- A file whose name starts with `.` is not read, and nor is a file with another extension or a
  folder's subfolders.
- A folder that does not exist adds no layer. A folder that cannot be read refuses the configuration,
  naming the folder.
- `<name>` is `configName` (`labkit`) unless the caller gives another.
- The project's files are read only when named, and only in a trusted folder, because a file that
  comes with a cloned project could turn off permission or give the model's commands credentials.
  - A folder is trusted when it, or a folder that contains it, is listed in `trusted-folders.json`
    in the user's configuration folder (`agent-host/trust.ts`). The list is JSON, so it is not one of
    the folder's layers.
  - The CLI's command, `labkit` (`bin/labkit.ts`), asks at a terminal whether to trust a folder that
    has its own files, and lists the folder when the user says yes.
  - For the ACP host, the session's working folder counts as trusted, because the editor trusts its
    workspace.
  - Naming the project's files, or the local ones, in a folder that is not trusted refuses the
    configuration.

Only a trusted layer may name `extensions` or `mcpServers`, because both run code. An untrusted layer
that names either is refused. Every layer a host builds is trusted; the check guards layers that a
caller builds itself (`fileLayer(file, false)`).

## What a layer holds

| Key | Value |
| --- | --- |
| `plugins` | Plug-ins by name, each with its settings. The plug-in is the one the name names, unless `use` names another. A setting that is not given takes its default. |
| `toolCalls`, `modelRequests`, `turnEnd`, `knownModels`, `settling`, `toolSources`, `commandEnvironment` | Each seam's list of names, in order. Each name is in `plugins`, or is a plug-in's own name (that plug-in with its defaults). |
| `maxHolds` | How many times the turn-end hooks may hold one turn open. Required when `turnEnd` lists hooks. |
| `mcpServers` | MCP servers by name. |
| `extensions` | Module paths, absolute or relative to the file's folder. |
| `model` | The model that a new session asks unless the command line names another, as `provider/model`. |
| `models` | What is known of models, by `provider/model`, over models.dev's catalog (see Models). |
| `cli` | The CLI's own settings: `view.thinking` (`on`, `off`), whether it shows the model's thinking; `on` when no layer sets it. It changes nothing in a request. |

- A seam's entries become the session's list for that seam, in the same order. Each entry is made by
  its plug-in from its settings, which are the same on every list the entry is on.
- Two of one plug-in with different settings are two names in `plugins`, each with `use`.
- A seam that no layer lists is not provided: the host's own list, or the seam's default, stands.
- No built-in plug-in is on `knownModels`, `settling` or `toolSources` yet.

### What the host provides

`FromHost` holds what a file cannot say:

- `canAsk`: whether anyone can answer a question before a call runs. `permissions` reads it.
- `permissionMode`: where the user changes the permission mode during a session (the ACP host), the
  mode now. Every `permissions` entry follows it in place of its configured `mode`; the first entry's
  `mode` is the mode that the session starts in.
- `toolPaths`: the names of each tool's path inputs, from the tools the session runs with now.

The session's id, its working folder and its folders are not in `FromHost`. An entry reads them
when it runs, from the context of the session it runs in (`SessionContext`,
`docs/agent-environment.md`).

### Merging

- Two mappings merge key by key, deeply, so an empty mapping changes nothing.
- Any other value, a list or `null` included, replaces what was there, including everything under it.
- A plug-in that a later layer writes as `null` takes its defaults.
- The merge is a fold in order: a value that is not a mapping removes what earlier layers had under
  it, and a later mapping starts again from there.

### Refusals

A configuration that cannot be used is refused. The error names the layer that last wrote the value
at fault, the path in it, and the problem. Refused values:

- a key that is not a configuration key;
- a seam that is not a list of names;
- a name that is neither in `plugins` nor a plug-in;
- a plug-in listed on a seam it is not on;
- a `use` that is not a plug-in, or `use` under a plug-in's own name;
- a setting that the plug-in does not have, or a value that its Schema refuses;
- turn-end hooks without `maxHolds`;
- `extensions` or `mcpServers` in an untrusted layer;
- two plug-ins with one name.

### Extensions

`extensions` names modules, each exporting by default a plug-in or a list of plug-ins. They are
loaded before the layers are decoded, each module once, and their plug-ins are registered as the
built-ins are, for every layer to use.

## MCP servers

| Field | Meaning |
| --- | --- |
| `command`, `args`, `env`, `cwd` | A server that the session runs as a process. `type: stdio` may be given, as Claude Code's `.mcp.json` does. |
| `type: http` or `sse`, `url`, `headers` | A server at a URL. |
| `required` | Whether a session needs the server. False unless given. |
| `connectTimeout` | How long the server has to connect, as a duration such as `10 seconds`. |

- Servers merge key by key, so a later layer can add a server or change one. A layer that writes
  `mcpServers: null` removes the servers of the layers before it.
- `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers` are replaced by the
  environment's values. A variable set to the empty string counts as not set. A variable that is
  not set and has no default is refused, naming the layer and the path.

## Models

What a host knows of a well-known model (its context window, output limit, kinds of input,
efforts, thinking budget, price) is generated from models.dev's catalog
(`agent-session/configuration/well-known-models.ts`). A local server's models are known by what the
server lists. `models` overrides either, for one model at a time:

```yaml
model: anthropic/claude-sonnet-5-5
models:
  xai/grok-4.7:
    efforts: [minimal, low, medium, high, xhigh]
  localhost/qwen3.5-9b-8bit:
    context: 32768
    output: 8192
```

- An override's fields are `context`, `output`, `input`, `reasoning`, `efforts`, `thinking` and
  `budget` (`min`, `max`). `efforts` takes the efforts the core names (`none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`), and `thinking` the measured modes (`between_tools`). Any other
  field or value is refused, and so is a name that is not `provider/model`.
- A field given replaces what is known of it whole; a field not given stays as known. Across
  layers, a model's overrides merge field by field, as any mapping does. `null` under a model removes
  its override, and `models: null` removes every earlier override.
- A model that nothing knows takes the override's fields alone. It accepts no files and costs nothing,
  as a model of which nothing is known does.
- The hosts apply the overrides to what each session knows (`ModelOverrides`): the model a request is
  shaped to, the ACP host's config options, and its `usage_update`.
- `model` is the model a new session asks when `--model` (or its variable) names none. In the CLI a
  continued or resumed session keeps the model it asked. In the ACP host, with neither, a session
  starts with the catalog's first model.

## Writing into the user's folder

A host writes the user's settings into the user's folder (`write.ts`): the CLI's `/model` writes
`model`, and its `/settings` writes `cli.view.thinking`. A setting is written where it decides the
folder's value:

- into the last of the folder's files, in name order, that sets it;
- when no file sets it, into a file that the host names (`models.yml` for `model`, `settings.yml`
  for `cli.view.thinking`), which is created, with the folder, when it does not exist.

The file keeps its comments and its layout: a long value stays on one line, and a flow list is
written without padding (`[low, high]`).
A file of the folder that does not parse is not written, and the error (`SettingNotWritten`) names
it. A layer read after the user's folder (a project's file, `--settings`) that sets the same key
still decides it for a session that reads that layer.

## Command environment

`commandEnvironment` lists transforms of the environment that the model's commands receive; the
first transform receives this process's environment. The `credentials` plug-in removes the
variables whose names are credential names (`isCredentialName` in `agent-process`), except those in
`pass` (for example `SSH_AUTH_SOCK`, for `git push` over SSH).

## Budget

`maxBudget` vetoes a model request once the session has cost its `usd` or more (`costIn`; a model
with no known price costs nothing). It has no default, so a list that names it needs it in
`plugins`.

## What a configuration resolved to

`effectiveSettings` (written as `effective-settings.json`) records:

- the layers, in order, and whether each is trusted;
- each seam's entries by name, with their plug-in and every setting as resolved, defaults included;
- `maxHolds`;
- the MCP servers. A server's command, arguments and URL are shown as the layers wrote them
  (`${VAR}`, not the variable's value), with credential flag values redacted (`redactedArgs`). Its
  environment and headers are shown by name only;
- for every value the layers wrote, the layer that wrote it last (`from`);
- what the host provides beside the layers (`host`).

## The JSON Schema

`schema.ts` makes the JSON Schema of a file from the plug-ins' Schemas. `scripts/config-schema.ts`
writes it to `schemas/config.schema.json`, and `bun run check` checks that it is current. A file
names it at its top (`# yaml-language-server: $schema=<path or URL>`). The schema accepts what the
loader accepts, for the mistakes a schema can detect:

- in `plugins`, under a plug-in's own name, that plug-in's settings without `use`, or `null` (its
  defaults); under any other name, `use` with the settings of the plug-in it names; no other
  property;
- in each seam, a list of names;
- in `mcpServers`, servers, or `null`.

## Tests

`config.test.ts` covers the layers, merging, refusals, extensions, MCP servers, the command
environment, the budget, the resolved configuration and the JSON Schema.
