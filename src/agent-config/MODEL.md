# agent-config

A session's configuration, in layers merged in order: the user's file, the project's, then what a
host adds (its command line). Plug-ins are configured once, by name, in `plugins`, and each seam a
session's logic plugs into (`agent-session`'s lists) lists names, in order.

```yaml
# yaml-language-server: $schema=./policies.schema.json
extensions:            # the user's own file only
  - ./my-plugin.ts
plugins:
  loopBreaker: { nudgeAt: 3, stopAt: 5 }
  strict: { use: loopBreaker, stopAt: 3 }   # a second loop breaker, with its own settings
  permissions: { mode: default }
toolCalls: [loopBreaker, permissions]
modelRequests: [loopBreaker, maxTurnRequests]   # maxTurnRequests: its defaults
turnEnd: [retryIncomplete]
maxHolds: 1
mcpServers:
  github: { command: gh-mcp, args: [--read-only], required: true, connectTimeout: 10 seconds }
```

## What is built

- `plugin.ts`: what a plug-in is (`use`, a settings Schema with a default for every setting, the
  seams it is on, its entries), the seams, and what the host says (`HostSays`: whether anyone can be
  asked).
- `builtins.ts`: `loopBreaker`, `permissions`, `maxTurnRequests`, `retryIncomplete`, over the logic
  in `agent-policy` and `agent-host`.
- `file.ts`: the layers (`policyLayers`: the user's file, `~/.config/<name>/policies.yml`, trusted,
  then the project's, `<project>/.<name>/policies.yml`, not; `<name>` being `configName`, `labkit`,
  unless the caller says another), read with Effect's YAML (`fileLayer`), merged and decoded
  (`loadConfiguration`), with the MCP servers they name.
- `merge.ts`: layers of parsed values merged, the last write winning.
- `seams.ts`: the seam lists a configuration gives a session, and the layer that provides them.
- `schema.ts`: the JSON Schema of a file; `scripts/config-schema.ts` writes it.

## What is not built

- The hosts read no layer yet: the CLI and the ACP host compose their lists in code.
- `every` does not yet say which entry, by its name, vetoed.
- A change of settings during a session (a draft, taken between turns): TODO.md, Configuration.
- Plug-ins on `knownModels`, `settling` and `toolSources`: the seams are there, no built-in is on
  them.

## Rules

- CF1. A layer is a mapping of `plugins`, a list for each seam (`toolCalls`, `modelRequests`,
  `turnEnd`, `knownModels`, `settling`, `toolSources`), `maxHolds`, `mcpServers` and `extensions`.
  `plugins` maps a name to a plug-in's settings, a setting not given taking its default; the plug-in
  is the one the name names unless `use` says another. Each seam lists names, in order, each one in
  `plugins` or a plug-in's own name (its defaults), the plug-in being on that seam. The entries
  become the session's lists, in the same order, each made by its plug-in from its settings, which
  are the same on every list it is on.
- CF2. What a layer does not say, the host says: whether anyone is there to answer a question
  before a call runs (`canAsk`), which `permissions` reads.
- CF3. A configuration that cannot be used is refused, naming the layer that last wrote the value at
  fault, where in it, and what is wrong: a key that is not the configuration's, a seam that is not a
  list of names, a name neither in `plugins` nor a plug-in, a plug-in not on the seam that lists it,
  a `use` that is not a plug-in, a setting the plug-in does not have, a value its Schema refuses.
- CF4. The layers merge in order, the last write winning: two mappings merge key by key, deeply, so
  an empty mapping changes nothing; any other value, a list and `null` included, replaces whole what
  was there, what was under it included. A plug-in a later layer writes `null` takes its defaults.
  The merge is a fold in order: a value that is not a mapping cuts off what earlier layers had under
  it, and a later mapping starts again.
- CF5. A file that is not there is an empty layer. A seam no layer lists is not provided: the host's
  own list for it, or the seam's default, stands.
- CF6. A configuration that lists turn-end hooks says `maxHolds`, in one of its layers.
- CF7. `extensions` names modules, each path absolute or relative to its file's folder, each
  exporting by default a plug-in or a list of them. Only a trusted layer, the user's own, may name
  them; a project's layer that does is refused. They are loaded, each module once, before the layers
  are decoded, and their plug-ins registered as the built-ins are, for every layer to use. Two
  plug-ins with one name are refused.
- CF8. The JSON Schema of a file is made from the plug-ins' Schemas: `plugins` takes a plug-in's
  settings under its own name, and `use` with that plug-in's settings under any other, and no other
  property; each seam's list takes names.
- CF9. Two of one plug-in, with different settings, are two names in `plugins`, each with `use`.
- CF10. `mcpServers` maps a name to a server: its `command`, `args`, `env`, `cwd`, whether a
  session needs it (`required`, false unless said) and how long it has to connect
  (`connectTimeout`, a duration). They merge key by key, so a project can add a server or change one
  of the user's.
