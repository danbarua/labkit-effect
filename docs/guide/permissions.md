# Permissions

labkit asks before a call that could change something, and runs the rest without asking. What it
asks about depends on the permission mode, on rules you set, and on what you allowed earlier in the
session.

## Permission modes

| Mode | What it does |
| --- | --- |
| `default` | Asks before a file is changed and before a command that is not read-only. |
| `acceptEdits` | Changes files in your folder without asking: the file tools, and a command's writes to files there (`>`, `tee`). Still asks about a program not allowed yet, and about changes outside your folder. |
| `dontAsk` | Asks nothing: what would be asked about is refused, unless you allowed it earlier in the session. |
| `bypassPermissions` | Runs everything, except what a deny rule refuses. |

Choose one with `--permission-mode`, or in an editor with the session's permission setting.

`bypassPermissions` contains nothing. A command runs as your user, with access to every file your
user can read or change, inside your folder or not. Use it only where that is acceptable, such as a
container or a machine you can throw away.

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
| reads outside your folder | `cat ~/.aws/credentials` | the call (see below) |
| writes, deletes or moves outside your folder | `rm -rf ~/Code/other`, `echo x >> ~/.zshrc` | the call (see below) |
| runs code labkit cannot read | `python3 -c '…'`, `curl … \| sh` | the call |
| does not parse | | the call |

"Allow for the rest of the session" names what it allows: `rm`, `git push`, `bun run build`,
`npx eslint`. A later command that runs only allowed programs runs without a question.

Reading outside your folder is asked about every time, even after you allowed the program for the
session or in your settings: allowing `cat` lets `cat` read files in your folder without a
question, not `~/.aws/credentials`. A path rule in your settings lets a read run: `Read(~/.aws/**)`.

Changing files outside your folder is asked about every time, in every mode but
`bypassPermissions`: allowing `rm` lets `rm -rf build` run, not `rm -rf ~/Code/other`. A path rule
lets a change run: `Edit(//tmp/**)` lets `rm -rf /tmp/build` run once `rm` is allowed. A rule
that allows a program says which programs run; a path rule says where they read and change files.
An allow rule for the whole tool (`command`) runs every command. This covers redirects, `tee`, `sed -i`,
`rm`, `mv`, `cp`, `rsync`, `ln`, `touch`, `mkdir`, `chmod`, `chown`, `curl -o`, `wget -O` and
`find -delete`. A path labkit cannot read (`rm -rf "$DIR"`, or `xargs rm`, whose paths come from its
input) counts as outside your folder. Other programs write where their own arguments say
(`go build -o ~/bin/tool`, a script), and labkit does not see where.

`ssh`, `docker` and `kubectl` are allowed by host or container (`ssh build-box`,
`docker exec web`): the command they run there is not judged.

## Trying it

`bun run playground:make [folder]` makes a playground (`~/Code/labkit-playground` unless you name
a folder): a folder with two git repositories in it, `app/` and `lib/`, and a README in each folder
with prompts to type and what each one should do. Some prompts give other answers depending on
the folder the session starts in. `scripts/playground/exercises.ts` holds the prompts; a test checks
that each one does what its README says.

## What a question shows

A question names each program that needs permission and why. Two kinds of program also show what
they will do:

- **`sed`** is explained in plain English, command by command:

  ```text
  sed -i 's/foo/bar/g' notes.txt: it is not allowed yet
    Edits notes.txt in place:
      Replaces every match of `foo` with `bar`, on every line.
      Saves every line, after these changes.
  ```

- **A file a command writes** is shown as a diff against its current text, when the command's words
  show the text: `cat > notes.md <<'EOF'`, `echo done >> log.txt`, `tee -a notes.md <<< '…'`. In an
  editor, the diff is in the command's call, so it shows whether or not you are asked, as an edit's
  does; at the terminal, it is in the question.

- **Notes in plain English** say what the words do not say plainly:
  - what cannot be undone: `rm` (folders with `-r`, without asking with `-f`), `git reset --hard`,
    `git push --force`, `git clean -f`, `git checkout -- <files>`, `git restore`, `git branch -D`,
    `git stash drop`, `-R` on `chmod` and `chown`, `dd` to a device;
  - the hosts a command connects to, and whether it sends them data (`curl`, `wget`, `git push`,
    `git pull`, `git clone`, `ssh`, `scp`, `rsync`);
  - what installing packages downloads and runs (`npm`, `yarn`, `pnpm`, `bun`, `pip`, `cargo install`,
    `gem install`, `go install`, `brew install`);
  - a relative path outside your folder (`../lib/secret.txt`) as its full path;
  - that in a pipeline (`bun test | tail -20`) only the last program's exit status counts;
  - what "Allow … for the rest of the session" covers.

- **Code written in the command** is shown in its language: `python3 -c`, `node -e`, `perl -ne`,
  `ruby -e`, `bun -e`, `deno eval`, an `awk` program, and code given to a program or a shell as a
  here-document (`python3 - <<'EOF'`). In an editor it is a fenced code block, so the editor
  highlights it.

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
      - "Edit(//tmp/labkit/**)"    # change files under /tmp/labkit
      - "Read(~/Code/**)"          # read your other projects
    deny:
      - "command(git push:*)"      # never, in any mode
      - git_push                   # a tool, every call
      - "Read(./.env)"             # never read a .env file in your folder
      - "Edit(~/.ssh/**)"          # never change ~/.ssh, nor delete a folder that holds it
```

| Rule | What it names |
| --- | --- |
| `tool` | every call to the tool |
| `tool(words)` | a command's program that is exactly these words |
| `tool(words:*)` | a command's program that starts with these words |
| `Read(path)` | the files a command reads that match the path; a denied read is a denied change |
| `Edit(path)` | the files a command writes, changes or deletes that match the path; an allowed edit is an allowed read |

Paths are Claude Code's: `//tmp/**` is from the root of the file system, `~/notes/**` from your home
folder, and anything else from your folder (`./.env`, `src/**`). After that, a path is matched as a
line of a `.gitignore` is: `*` within a folder, `**` across folders, and a name without a `/` at any
depth (`.env`, `*.pem`). A path starting with a single `/` is refused: in Claude Code it is
relative to the settings file, and labkit does not know which file a rule came from. Write `//` for
the root.
`command` stands for both command tools: `run_command` at the terminal and `terminal_command` in an
editor.

- **A deny rule** refuses the call in every mode, `bypassPermissions` included, wherever the program
  is in the command, including after `sudo`. A path deny rule refuses a read or a change of a path
  it matches, in your folder or outside it; deleting or moving a folder that holds a denied path is
  refused too (`rm -rf ~` with `Edit(~/.ssh/**)`). A `Read(...)` deny rule refuses changes as well
  as reads, since a file that may not be read may not be changed either: `Read(secrets/**)` refuses
  `cat secrets/key`, `rm secrets/key` and an `edit_file` of `secrets/key`. An `Edit(...)` deny rule
  refuses changes only. When deny rules name programs or paths and labkit
  cannot see them (a command that does not parse, a name or path not written out, paths `xargs`
  reads from its input), labkit asks even in `bypassPermissions`.
- **An allow rule** runs the program without a question. A path allow rule lets a command read or
  change the files it matches outside your folder; the program must still be allowed.

`readOnly` replaces the list of programs that run without a question.

The file tools (`read_file`, `write_file`, `edit_file`, `list_dir`) follow the same paths: a file
outside your folder is asked about, with only that call to allow, unless a path rule allows it; a
path deny rule refuses it in every mode.

`additionalDirectories` lists folders whose files count as inside your folder: a command and the
file tools may read and change files there as they do in your folder, and the agent is told of
them. A folder is absolute, from `~`, or relative to
your folder:

```yaml
plugins:
  permissions:
    additionalDirectories:
      - ~/Code/shared-config
      - ../docs
```

`--add-dir <folder>` adds one for a session, at the terminal or in the ACP launcher, and is
repeatable. In a conversation, `/add-dir <folder>` adds one from the next tool call on, and tells the
agent; `/add-dir` alone lists them. An editor can name more for each session it opens (ACP's
`additionalDirectories`).

## What labkit does not check

labkit judges a command by its words. It does not run the command to see what it does, so these
pass by what their words show:

- **Programs it does not know** write where their own arguments or files say: `make`,
  `bun run build`, `go build -o ~/bin/tool`, a script. Allowing one for the session lets it write
  anywhere your user can.
- **Some programs that change files outside your folder** are not yet read for their paths:
  `tar -x -C <folder>`, `patch -d <folder>`, `install -d`, `scp`, and `git -C <folder>` with a
  subcommand that writes (asked about as a read outside your folder).
- **Symbolic links** are not followed: a link inside your folder to a file outside it counts as
  inside.
- **`cd`** is followed: after `cd src`, a relative path is judged both in your folder and in `src`,
  since the `cd` may fail. After `popd`, `cd -` or a `cd` to a folder not written out, where a
  relative path leads is not known, and it counts as outside your folder.
- **A deny rule that names a file at any depth** (`Read(./.env)`, `Edit(*.pem)`) is not seen inside
  a folder that a recursive search (`rg`, `grep -r`) or a delete (`rm -rf config`) covers. A deny rule
  anchored to a folder is: `Read(secrets/**)` refuses `rg KEY .`, which would search `secrets`.
  Claude Code's checks of shell commands have the same limit.
- **When deny rules name paths,** a path they cannot see is asked about even in
  `bypassPermissions`: one not written out (`"$F"`), a glob (`.en*`), and the paths `xargs` or
  `find -exec` give a program as it runs.
- **Code given to a program** (`python3 -c '…'`, a here-document fed to `bash`) is shown in the
  question, not judged. Deny rules cannot see the programs that code runs.
- **`bypassPermissions`** contains nothing (see Permission modes).
