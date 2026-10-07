# Trusted folders

A folder can hold files that change what labkit does:

- `.env` files, whose variables can choose settings, start MCP servers or load extensions;
- `.labkit/` settings, which can change what labkit asks before it acts;
- `bunfig.toml`, which can make Bun run code before labkit starts.

A folder you cloned could hold any of these. So labkit reads a folder's `.env` files and `.labkit/`
settings only when you trust the folder, and never reads its `bunfig.toml`.

## Trusting a folder

When you run `labkit` at a terminal in a folder that has a `.env` file or `.labkit/` settings, and
you have not trusted the folder, labkit asks:

```
? Trust /Users/you/Code/project? Its .env and .labkit/ can change what labkit does.
❯ Yes, trust this folder
  No, start without reading them
```

- **Yes** adds the folder to `~/.config/labkit/trusted-folders.json`, and labkit reads its files from
  now on.
- **No** starts labkit without them, and asks again next time.

A folder inside a trusted folder is trusted too: trusting `~/Code` trusts every project in it.

`labkit -p` never asks. In a folder that is not trusted, it says which files it did not read and
runs without them.

To stop trusting a folder, remove it from `trusted-folders.json`.

## Project settings

A trusted folder's `.labkit/*.yml` files are read when you ask for them with `--setting-sources`:

```sh
labkit --setting-sources user,project          # your settings, then the project's
labkit --setting-sources user,project,local    # and the project's *.local.yml, which you keep out of git
```

Asking for a folder's settings when the folder is not trusted stops labkit with an error that says
so.

## In an editor

In an editor, labkit runs in the workspace the editor opened. The editor decides whether that
workspace is trusted (VS Code's workspace trust, for example), so labkit treats it as trusted.
