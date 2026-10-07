# Permissions

labkit asks before a call that could change something, and runs the rest without asking. What it
asks about depends on the permission mode, on rules you set, and on what you allowed earlier in the
session.

## Permission modes

| Mode | What it does |
| --- | --- |
| `default` | Asks before a file is changed and before a command that is not read-only. |
| `acceptEdits` | Changes files without asking: the file tools, and a command's writes to files (`>`, `tee`). Still asks about a program not allowed yet. |
| `dontAsk` | Asks nothing: what would be asked about is refused, unless you allowed it earlier in the session. |
| `bypassPermissions` | Runs everything, except what a deny rule refuses. |

Choose one with `--permission-mode`, or in an editor with the session's permission setting.

## Commands

A command is judged by each program it runs: in a pipeline, after `&&` or `;`, inside `$(…)`, and
inside code written out for `bash -c '…'`. `git log | head -5` runs without a question; `git log;
git push` asks about `git push`.

These run without a question when they read only inside your folder: `ls`, `cat`, `head`, `tail`,
`wc`, `pwd`, `echo`, `grep`, `rg`, `which`, `cd`, `git status`, `git log`, `git diff` and `git show`.

labkit asks, and says why, when a command:

| Why | Example | What you can allow |
| --- | --- | --- |
| runs a program not allowed yet | `rm -rf build`, `bun test` | the call, or the program (and its subcommand) for the rest of the session |
| writes a file | `echo done > notes.txt` | the call; `acceptEdits` allows it |
| reads outside your folder | `cat ~/.aws/credentials` | the call |
| runs code labkit cannot read | `python3 -c '…'`, `curl … \| sh` | the call |
| does not parse | | the call |

"Allow for the rest of the session" names what it allows: `rm`, `git push`, `bun run build`,
`npx eslint`. A later command that runs only allowed programs runs without a question.

`ssh`, `docker` and `kubectl` are allowed by host or container (`ssh build-box`,
`docker exec web`): the command they run there is not judged.

## Rules

Rules in your settings allow or refuse calls in every session:

```yaml
# ~/.config/labkit/policies.yml
plugins:
  permissions:
    mode: default
    allow:
      - "command(bun test:*)"      # every command tool, a program starting `bun test`
      - "command(make build)"      # exactly `make build`
    deny:
      - "command(git push:*)"      # never, in any mode
      - git_push                   # a tool, every call
```

| Rule | What it names |
| --- | --- |
| `tool` | every call to the tool |
| `tool(words)` | a command's program that is exactly these words |
| `tool(words:*)` | a command's program that starts with these words |

`command` stands for both command tools: `run_command` at the terminal and `terminal_command` in an
editor.

- **A deny rule** refuses the call in every mode, `bypassPermissions` included, wherever the program
  is in the command, including after `sudo`. When a deny rule names programs and labkit cannot read
  a command (it does not parse, or a program's name is not written out), labkit asks even in
  `bypassPermissions`.
- **An allow rule** runs the program without a question, and lets it read outside your folder.

`readOnly` replaces the list of programs that run without a question.
