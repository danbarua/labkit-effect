# Example configuration folders

Configuration folders as a host reads them. A test in `config.test.ts` loads these folders, so an
example that no longer loads fails `bun run check`. `docs/agent-config.md` describes every key.

| Folder | Read | Trusted |
| --- | --- | --- |
| `user/`: the user's configuration folder (`~/.config/labkit/`, or `--config-dir`) | always | yes |
| `project/.labkit/`: a project's folder; its files other than `*.local.yml` | with `--setting-sources project` | no |
| `project/.labkit/`: the user's own files for the project, `*.local.yml` | with `--setting-sources local` | no |

- Each folder's `.yml` and `.yaml` files are read in the order of their names, so a name can start
  with a sorting prefix (`10_`, `20_`). A file whose name starts with `.` is not read.
- A later file overrides an earlier one. Two mappings merge key by key; any other value, a list
  included, replaces what was there whole.
- A file that is not trusted may not name `extensions` or `mcpServers`, because both run code and a
  project's files come with the project.
- The first line of each file names the JSON Schema, so an editor with the YAML language server
  checks the file as it is typed.

The user's folder here:

| File | Holds |
| --- | --- |
| `10_policies.yml` | Plug-ins, and the seam lists that use them. |
| `20_mcp.yml` | MCP servers. |
| `30_extensions.yml` | An extension, the plug-in it adds, and a seam list restated to use it. |
| `40_models.yml` | The model that a new session asks, and what is known of models over models.dev's catalog. |
| `50_settings.yml` | The user's settings: whether the CLI shows the model's thinking. |
