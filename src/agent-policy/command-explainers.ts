/**
 * Plain-English notes for a permission question, for what a command does that its words do not say
 * plainly. Each explainer handles one kind of thing, from a program's words (`Unit`):
 *
 * | Explainer | Notes |
 * | --- | --- |
 * | `destructive` | what cannot be undone: `rm` (and `-r`, `-f`), `git reset --hard`, `git push --force`, `git clean`, `git checkout -- <files>`, `git restore`, `git branch -D`, `git stash drop`, `-R` on `chmod`, `chown` and `chgrp`, `dd` to a device |
 * | `network` | the hosts it connects to, and whether it sends them data: `curl`, `wget`, `git push`, `pull`, `fetch` and `clone`, `ssh`, `scp`, `rsync` |
 * | `installs` | what installing packages runs or changes: `npm`, `yarn`, `pnpm`, `bun`, `pip`, `uv pip`, `cargo install`, `gem install`, `go install`, `brew install` |
 * | `paths` | each path outside the working folder that is written relatively, as its full path |
 *
 * `explainers` lists them, and `notesOf` gives a unit's notes, in that order. `commandNotes` gives
 * the notes about the command as a whole: what the session grants offered cover, and a pipeline
 * whose exit status is its last program's.
 *
 * An explainer reads literal words only: a word that is not written out says nothing.
 */

import { codeSpan } from "./code-span.ts";
import { type Segment, type SegmentsOf, type ShellCommand, WordText } from "./command-segments.ts";
import { type Folders, fullPathOf, judgesPathsOf, type Unit } from "./command-units.ts";
import { Explanation } from "./sed-script.ts";

/** Notes about one program, from its unit; none when it has nothing to say. */
export type Explainer = (unit: Unit, folders: Folders | undefined) => ReadonlyArray<Explanation>;

type Text = Parameters<typeof Explanation.make>[0];
const said = (text: Text): Explanation => Explanation.make(text);
const name = (word: WordText | undefined): WordText => WordText.make((word ?? "").slice((word ?? "").lastIndexOf("/") + 1));

/** The unit's words that are literal, from the program on; the program by the last part of its path. */
const wordsOf = (unit: Unit): ReadonlyArray<WordText> => unit.words.flatMap((word, at) => (word.literal === undefined ? [] : [at === 0 ? name(word.literal) : word.literal]));

/** Whether `args` has one of `options`, alone or (a one-letter option) in a cluster of short ones (`-rf`). */
const hasOption = (args: ReadonlyArray<WordText>, ...options: ReadonlyArray<Text>): boolean =>
  args.some((arg) => options.includes(arg) || (/^-[A-Za-z]{2,}$/.test(arg) && options.some((option) => /^-[A-Za-z]$/.test(option) && arg.includes(option.slice(1)))));

/** `word` as a Markdown code span (`codeSpan`), for a text that names a program, a path or a host. */
const coded = (word: WordText): WordText => WordText.make(codeSpan(word));

const listed = (items: ReadonlyArray<WordText>): Text => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// —— destructive ——

const gitDestructive: ReadonlyMap<WordText, (args: ReadonlyArray<WordText>) => ReadonlyArray<Explanation>> = new Map([
  [WordText.make("reset"), (args) => (hasOption(args, "--hard") ? [said("It discards every uncommitted change to the files git tracks. The changes cannot be got back.")] : [])],
  [
    WordText.make("push"),
    (args) => {
      if (hasOption(args, "--force-with-lease") || args.some((arg) => arg.startsWith("--force-with-lease="))) return [said("It replaces the remote branch with yours, unless the remote branch changed since you last fetched it. Commits on the remote that yours does not have are lost there.")];
      return hasOption(args, "-f", "--force") || args.some((arg) => arg.startsWith("+")) ? [said("It replaces the remote branch with yours. Commits on the remote that yours does not have are lost there.")] : [];
    },
  ],
  [
    WordText.make("clean"),
    (args) =>
      hasOption(args, "-f", "--force")
        ? [said(`It deletes the files${hasOption(args, "-d") ? " and folders" : ""} that git does not track${hasOption(args, "-x") ? ", including those git ignores" : ""}. They cannot be got back.`)]
        : [],
  ],
  [WordText.make("checkout"), (args) => (args.includes(WordText.make("--")) || args.includes(WordText.make(".")) ? [said("It discards the uncommitted changes to the files it names. They cannot be got back.")] : [])],
  [WordText.make("restore"), (args) => (hasOption(args, "--staged", "-S") && !hasOption(args, "--worktree", "-W") ? [] : [said("It discards the uncommitted changes to the files it names. They cannot be got back.")])],
  [WordText.make("branch"), (args) => (hasOption(args, "-D") || (hasOption(args, "-d", "--delete") && hasOption(args, "-f", "--force")) ? [said("It deletes the branch even when its commits are not merged anywhere.")] : [])],
  [
    WordText.make("stash"),
    (args) => {
      if (args[0] === WordText.make("clear")) return [said("It deletes every stashed change. They cannot be got back.")];
      return args[0] === WordText.make("drop") ? [said("It deletes a stashed change. It cannot be got back.")] : [];
    },
  ],
]);

const recursiveChange = (program: WordText): Explainer => (unit) => (hasOption(wordsOf(unit).slice(1), "-R", "--recursive") ? [said(`With ${codeSpan("-R")}, ${codeSpan(program)} changes every file and folder inside the folders it names.`)] : []);

const destructiveBy: ReadonlyMap<WordText, Explainer> = new Map<WordText, Explainer>([
  [
    WordText.make("rm"),
    (unit) => {
      const args = wordsOf(unit).slice(1);
      const what = hasOption(args, "-r", "-R", "--recursive") ? "the files and folders it names, with everything in the folders" : "the files it names";
      return [said(`It deletes ${what}${hasOption(args, "-f", "--force") ? ", without asking first" : ""}. Deleted files do not go to the Trash.`)];
    },
  ],
  [WordText.make("git"), (unit) => {
    const [, subcommand, ...args] = wordsOf(unit);
    return subcommand === undefined ? [] : (gitDestructive.get(subcommand)?.(args) ?? []);
  }],
  [WordText.make("chmod"), recursiveChange(WordText.make("chmod"))],
  [WordText.make("chown"), recursiveChange(WordText.make("chown"))],
  [WordText.make("chgrp"), recursiveChange(WordText.make("chgrp"))],
  [WordText.make("dd"), (unit) => (wordsOf(unit).some((word) => word.startsWith("of=/dev/") && !["of=/dev/null", "of=/dev/stdout", "of=/dev/stderr"].includes(word)) ? [said("It writes straight to a device, replacing what is on it.")] : [])],
]);

/** What cannot be undone. */
export const destructive: Explainer = (unit, folders) => destructiveBy.get(wordsOf(unit)[0] ?? WordText.make(""))?.(unit, folders) ?? [];

// —— network ——

/** The host of `word` when it is a URL (`https://example.com/x`), or a remote path (`host:path`, `user@host:path`) for `scp` and `rsync`. */
const hostOf = (word: WordText, remotePaths: boolean): WordText | undefined => {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(word);
  if (url?.[1] !== undefined) return WordText.make(url[1]);
  const remote = remotePaths ? /^(?:[^@/:\s]+@)?([A-Za-z0-9.-]+):/.exec(word) : null;
  return remote?.[1] === undefined ? undefined : WordText.make(remote[1]);
};

const unique = (items: ReadonlyArray<WordText>): ReadonlyArray<WordText> => [...new Set(items)];

const sendsData = (args: ReadonlyArray<WordText>): boolean =>
  args.some((arg) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json|--post-data.*|--post-file.*|--body-data.*)$/.test(arg.split("=")[0] ?? "")) ||
  args.some((arg, at) => (arg === WordText.make("-X") || arg === WordText.make("--request") || arg === WordText.make("--method")) && /^(POST|PUT|PATCH|DELETE)$/i.test(args[at + 1] ?? ""));

const webClients = new Set(["curl", "wget", "http", "https", "xh"].map((each) => WordText.make(each)));

const gitRemote: ReadonlyMap<WordText, Text> = new Map([
  [WordText.make("push"), "It sends your commits to"],
  [WordText.make("pull"), "It fetches commits from"],
  [WordText.make("fetch"), "It fetches commits from"],
]);

/** The hosts it connects to. */
export const network: Explainer = (unit) => {
  const [program, ...args] = wordsOf(unit);
  if (program === undefined) return [];
  if (webClients.has(program)) {
    const hosts = unique(args.flatMap((arg) => (hostOf(arg, false) === undefined ? [] : [hostOf(arg, false) ?? arg])));
    return hosts.length === 0 ? [] : [said(`It ${sendsData(args) ? "sends data to" : "connects to"} ${listed(hosts.map(coded))}.`)];
  }
  if (program === WordText.make("git")) {
    const [subcommand, ...rest] = args;
    const operands = rest.filter((arg) => !arg.startsWith("-"));
    if (subcommand === WordText.make("clone")) {
      const host = operands[0] === undefined ? undefined : (hostOf(operands[0], true) ?? undefined);
      return [said(`It downloads a repository${host === undefined ? "" : ` from ${codeSpan(host)}`}.`)];
    }
    const lead = subcommand === undefined ? undefined : gitRemote.get(subcommand);
    return lead === undefined ? [] : [said(`${lead} ${operands[0] === undefined ? "the branch's remote" : `the remote ${codeSpan(operands[0])}`}.`)];
  }
  if (program === WordText.make("ssh")) {
    const host = args.find((arg) => !arg.startsWith("-"));
    return host === undefined ? [] : [said(`It connects to ${codeSpan(host)}${args.indexOf(host) < args.length - 1 ? " and runs a command there" : ""}.`)];
  }
  if (program === WordText.make("scp") || program === WordText.make("rsync")) {
    const hosts = unique(args.flatMap((arg) => (arg.startsWith("-") ? [] : (hostOf(arg, true) === undefined ? [] : [hostOf(arg, true) ?? arg]))));
    return hosts.length === 0 ? [] : [said(`It copies files to or from ${listed(hosts.map(coded))}.`)];
  }
  return [];
};

// —— installs ——

const nodeInstalls = new Set(["install", "i", "ci", "add", "update", "up", "upgrade"].map((each) => WordText.make(each)));
const runsScripts = (args: ReadonlyArray<WordText>): boolean => !hasOption(args, "--ignore-scripts");

const installsBy: ReadonlyMap<WordText, (args: ReadonlyArray<WordText>) => ReadonlyArray<Explanation>> = new Map<WordText, (args: ReadonlyArray<WordText>) => ReadonlyArray<Explanation>>([
  [
    WordText.make("npm"),
    (args) =>
      args[0] !== undefined && nodeInstalls.has(args[0])
        ? [said(`It downloads packages from the npm registry${runsScripts(args) ? " and runs their install scripts, which can run any code on this machine" : ", without running their install scripts"}.`)]
        : [],
  ],
  [
    WordText.make("yarn"),
    (args) =>
      args[0] === undefined || nodeInstalls.has(args[0])
        ? [said(`It downloads packages from the npm registry${runsScripts(args) ? " and runs their install scripts, which can run any code on this machine" : ", without running their install scripts"}.`)]
        : [],
  ],
  [
    WordText.make("pnpm"),
    (args) =>
      args[0] !== undefined && nodeInstalls.has(args[0])
        ? [said("It downloads packages from the npm registry. Depending on the pnpm version and the project's settings, it runs their install scripts, which can run any code on this machine.")]
        : [],
  ],
  [
    WordText.make("bun"),
    (args) =>
      args[0] !== undefined && nodeInstalls.has(args[0])
        ? [said("It downloads packages from the npm registry. It runs install scripts only for the packages bun trusts: its own list of common packages, and those in your package.json's trustedDependencies.")]
        : [],
  ],
  [WordText.make("pip"), (args) => pipNotes(args)],
  [WordText.make("pip3"), (args) => pipNotes(args)],
  [WordText.make("uv"), (args) => (args[0] === WordText.make("pip") ? pipNotes(args.slice(1)) : args[0] === WordText.make("add") || args[0] === WordText.make("sync") ? [said("It downloads packages from the package index into the project's environment. A package built from source runs its build code.")] : [])],
  [WordText.make("cargo"), (args) => (args[0] === WordText.make("install") ? [said("It downloads and builds a crate, installing it for your user outside the working folder. Its build scripts can run any code on this machine.")] : [])],
  [WordText.make("gem"), (args) => (args[0] === WordText.make("install") ? [said("It downloads gems and installs them for your user. A gem with a native extension runs its build code.")] : [])],
  [WordText.make("go"), (args) => (args[0] === WordText.make("install") ? [said("It downloads and builds Go modules, installing the program for your user outside the working folder.")] : [])],
  [WordText.make("brew"), (args) => (["install", "upgrade", "reinstall"].includes(args[0] ?? "") ? [said("It installs software for your whole user account, outside the working folder.")] : [])],
]);

/** What `pip install` does, from its arguments past `pip`. */
const pipNotes = (args: ReadonlyArray<WordText>): ReadonlyArray<Explanation> =>
  args[0] === WordText.make("install") ? [said("It downloads packages from the package index. A package built from source runs its build code, which can run any code on this machine.")] : [];

/** What installing packages runs or changes. `python3 -m pip install` is `pip install`. */
export const installs: Explainer = (unit) => {
  const words = wordsOf(unit);
  const [program, ...args] = words;
  if (program === undefined) return [];
  if (/^python[0-9.]*$/.test(program) && args[0] === WordText.make("-m") && args[1] !== undefined) return installsBy.get(args[1])?.(args.slice(2)) ?? [];
  return installsBy.get(program)?.(args) ?? [];
};

// —— paths ——

/** Each path outside the working folder that is written relatively (`../lib`, `~/notes`), as its full path. */
export const paths: Explainer = (unit, folders) => {
  if (folders === undefined) return [];
  const written = unique([...unit.outside, ...unit.changesOutside.flatMap((change) => (change.path === undefined ? [] : [change.path]))]);
  return written.flatMap((path) => {
    if (path.startsWith("/") || /[$`"'*?]/.test(path)) return [];
    const full = fullPathOf(path, folders);
    return full === undefined || full === path ? [] : [said(`${codeSpan(path)} is ${codeSpan(full)}.`)];
  });
};

/** The explainers, in the order their notes are shown. */
export const explainers: ReadonlyArray<Explainer> = [destructive, installs, network, paths];

/** A unit's notes: each explainer's, in order. */
export const notesOf = (unit: Unit, folders: Folders | undefined): ReadonlyArray<Explanation> => explainers.flatMap((explainer) => explainer(unit, folders));

// —— the command as a whole ——

/**
 * What a session grant covers, for the grants a question offers: for a program whose paths the policy
 * judges (`rm`), later calls inside the working folder; for any other (`bun test`, `git push`), later
 * calls wherever they read or write, since the policy does not see where.
 */
const grantsNote = (grants: ReadonlyArray<ReadonlyArray<WordText>>): ReadonlyArray<Explanation> => {
  const named = (group: ReadonlyArray<ReadonlyArray<WordText>>): Text => listed(group.map((grant) => coded(WordText.make(grant.join(" ")))));
  const judged = grants.filter((grant) => grant[0] !== undefined && judgesPathsOf(grant[0]));
  const unjudged = grants.filter((grant) => !judged.includes(grant));
  const later = (group: ReadonlyArray<ReadonlyArray<WordText>>): Text => (group.length === 1 ? `later ${named(group)} commands` : `later commands that use them`);
  return [
    ...(judged.length === 0
      ? []
      : [said(`Allowing ${named(judged)} for the rest of the session lets ${later(judged)} run without a question inside the working folder. Outside it, they are still asked about.`)]),
    ...(unjudged.length === 0
      ? []
      : [
          said(
            `Allowing ${named(unjudged)} for the rest of the session lets ${later(unjudged)} run without a question. labkit does not see which files ${unjudged.length === 1 ? "it reads or writes" : "they read or write"} itself, so it does not ask about them, even outside the working folder.`,
          ),
        ]),
  ];
};

/** For each pipeline in `segments`, that only its last program's exit status counts, unless `set -o pipefail` comes before it. */
const pipelineNotes = (segments: ReadonlyArray<Segment>): ReadonlyArray<Explanation> =>
  segments.flatMap((segment, at) => {
    const slot = segment.pipe;
    if (slot === undefined || slot.position !== slot.of - 1) return [];
    const first = segments.find((each) => each.pipe?.pipeline === slot.pipeline && each.pipe.position === 0);
    const pipefail = segments.slice(0, at).some((each) => each.words[0]?.literal === WordText.make("set") && each.words.some((word) => word.literal === WordText.make("pipefail")));
    const firstName = name(first?.words[0]?.literal);
    const lastName = name(segment.words[0]?.literal);
    if (pipefail || first === undefined || firstName === "" || lastName === "") return [];
    return [said(`Only ${codeSpan(lastName)}'s exit status counts: the pipeline from ${codeSpan(firstName)} to ${codeSpan(lastName)} succeeds when ${codeSpan(lastName)} does, even if ${codeSpan(firstName)} fails.`)];
  });

/** The notes about `command` as a whole: what the session grants it offers cover, and its pipelines' exit statuses. */
export const commandNotes = (command: ShellCommand, segmentsOf: SegmentsOf, grants: ReadonlyArray<ReadonlyArray<WordText>>): ReadonlyArray<Explanation> => {
  const split = segmentsOf(command);
  return [...(split._tag === "Parsed" ? pipelineNotes(split.segments) : []), ...grantsNote(grants)];
};
