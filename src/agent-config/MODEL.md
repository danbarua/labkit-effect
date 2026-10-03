# agent-config

A session's policies, read from configuration files: plug-ins, each named by `use`, listed in order
on the seams a session's logic plugs into (`agent-session`'s lists), each with its settings.

```yaml
# yaml-language-server: $schema=./policies.schema.json
extensions:
  - ./my-plugin.ts
toolCalls:
  - use: loopBreaker
    nudgeAt: 3
  - use: permissions
    mode: default
modelRequests:
  - use: loopBreaker
  - use: maxTurnRequests
    limit: 1000
turnEnd:
  - use: retryIncomplete
    retries: 1
maxHolds: 1
```

## What is built

- `plugin.ts`: what a plug-in is (`use`, a settings Schema with a default for every setting, the
  seams it is on, its entries), the seams, and what the host says (`HostSays`: whether anyone can be
  asked).
- `builtins.ts`: `loopBreaker`, `permissions`, `maxTurnRequests`, `retryIncomplete`, over the logic
  in `agent-policy` and `agent-host`.
- `file.ts`: the files (`policyFiles`: the user's, `~/.config/<name>/policies.yml`, then the
  project's, `<project>/.<name>/policies.yml`, `<name>` being `configName`, `labkit`, unless the
  caller says another), read with Effect's YAML, decoded and merged (`loadConfiguration`).
- `merge.ts`: layers of parsed values merged, the last write winning.
- `seams.ts`: the seam lists a configuration gives a session, and the layer that provides them.
- `schema.ts`: the JSON Schema of a file; `scripts/config-schema.ts` writes it.

## What is not built

- The hosts read no file yet: the CLI and the ACP host compose their lists in code.
- A change of settings during a session (a draft, taken between turns): TODO.md, Configuration.
- Plug-ins on `knownModels`, `settling` and `toolSources`: the seams are there, no built-in is on
  them.

## Rules

- CF1. A file is a mapping of a list for each seam (`toolCalls`, `modelRequests`, `turnEnd`,
  `knownModels`, `settling`, `toolSources`), `maxHolds` and `extensions`. Each list is in order;
  each entry is `use: <plug-in>` and that plug-in's settings, a setting not given taking its
  default. The entries become the session's lists, in the same order, each made by its plug-in from
  its settings.
- CF2. What a file does not say, the host says: whether anyone is there to answer a question before
  a call runs (`canAsk`), which `permissions` reads.
- CF3. A file that cannot be used is refused, naming the file, where in it, and what is wrong: a key
  that is not the file's, a seam that is not a list, an entry whose `use` is not a plug-in on its
  seam (the ones that are named), a setting the plug-in does not have, a value its Schema refuses.
  Each file is decoded alone, then the merged layers again.
- CF4. The user's file, then the project's, merge in that order, the last write winning: two
  mappings merge key by key, deeply; any other value, a list included, is replaced whole.
- CF5. A file that is not there is an empty layer. A seam no file lists is not provided: the host's
  own list for it, or the seam's default, stands.
- CF6. A configuration that lists turn-end hooks says `maxHolds`, in one of its layers.
- CF7. `extensions` names modules, each path absolute or relative to its file's folder, each
  exporting by default a plug-in or a list of them. Every layer's extensions are loaded, each module
  once, before any entry is decoded, and their plug-ins are registered as the built-ins are. Two
  plug-ins with one name are refused.
- CF8. The JSON Schema of a file is made from the plug-ins' Schemas: each seam's entries name a
  plug-in on it and take its settings and no other property.
