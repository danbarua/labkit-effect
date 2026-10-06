/**
 * Git tools backed by es-git, which give results like the git command's. Each tool is a primitive
 * (`tool.ts`) that takes the repository's folder as its `repository` input, and opens the repository
 * for each call; making the tools opens and changes nothing.
 *
 * `gitTools(root)` binds every tool to the repository at `root` (`bound.ts`), so the model is not
 * offered `repository`, and adds an `intent` input (`described.ts`). It also returns the system text
 * that says the working folder is the repository's root.
 *
 * - A path in a tool's input is a pathspec relative to the repository's root. An absolute path, `..`
 *   or `.git` is refused.
 * - A tool with an `action` input (`git_branch`, `git_remote`, `git_stash`, `git_tag`) states, for
 *   each action, the inputs that the action needs and the other inputs that it uses. A call without
 *   an input its action needs is refused. A call with an input its action does not use runs without
 *   it: a WARN is logged, and the result says which were ignored.
 * - The credential for `git_push` and `git_pull` comes from the host (`credential`), never from a
 *   tool's input.
 */

import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as git from "es-git";
import { Effect, Schema } from "effect";
import { ToolName } from "../agent-machine/names.ts";
import type { ToolSpec } from "../agent-session/contracts.ts";
import { logKeys } from "../agent-session/log-keys.ts";
import { bound } from "./bound.ts";
import { described } from "./described.ts";
import { anyTool, type Fields, Rejected, Reported, sourceOf, type Tool } from "./tool.ts";

/** The repository's folder: the folder that holds `.git`. */
export const RepositoryPath = Schema.NonEmptyString.annotate({ description: "The repository's folder: the folder that holds .git.", pathOf: "folder" });

/** The fields of a git tool: `repository`, and its own. */
export type WithRepository<F extends Fields> = { readonly repository: typeof RepositoryPath } & F;

const text = (description: string) => Schema.NonEmptyString.annotate({ description });
const optionalText = (description: string) => Schema.optionalKey(text(description));
const flag = (description: string) => Schema.optionalKey(Schema.Boolean.annotate({ description }));
const pathspec = (description: string) => text(description);
const identity = (description: string) =>
  Schema.optionalKey(Schema.Struct({ name: text("The person's name."), email: text("The person's email address.") }).annotate({ description }));

const reject = (problem: string): never => {
  throw new Rejected({ problem });
};
const errorOf = (error: unknown): Rejected | Reported => error instanceof Rejected ? error : new Reported({ message: error instanceof Error ? error.message : String(error) });
const collect = <T>(iterator: Iterator<T>): T[] => Array.from({ [Symbol.iterator]: () => iterator });
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const object = (repo: git.Repository, spec: string) => repo.getObject(repo.revparseSingle(spec));
const commit = (repo: git.Repository, spec = "HEAD") => object(repo, spec).peelToCommit();
const headCommit = (repo: git.Repository): git.Commit | undefined => {
  const symbolic = repo.getReference("HEAD").symbolicTarget();
  return symbolic !== null && repo.findReference(symbolic) === null ? undefined : commit(repo);
};
const cleanState = (repo: git.Repository) => {
  if (repo.state() !== "Clean") reject(`The repository has an operation in progress (${repo.state()}). Resolve it first.`);
};
const checkedPath = (path: string): string => {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.split(/[\\/]/).includes(".git")) reject("Use repository-relative paths without '..' or '.git'.");
  return path;
};
const summary = (value: git.Commit) => ({
  id: value.id(),
  author: value.author(),
  time: value.time().toISOString(),
  message: value.message()
});

/** es-git 0.7 omits line origins in Diff.print; explicit sides avoid ambiguous patch output. */
const changes = (repo: git.Repository, diff: git.Diff, worktree = false): string => {
  const content = (file: git.DiffFile, fromWorktree: boolean) => {
    if (!file.exists()) return null;
    if (file.mode() === "Commit") return {submodule: file.id()};
    const path = file.path();
    const directory = repo.workdir();
    if (fromWorktree && file.mode() === "Link" && path !== null && directory !== null) return readlinkSync(join(directory, path));
    const bytes = fromWorktree && path !== null && directory !== null
      ? readFileSync(join(directory, path))
      : Buffer.from(repo.getObject(file.id()).peelToBlob().content());
    return bytes.includes(0) ? {binary: true, bytes: bytes.length} : bytes.toString("utf8");
  };
  return json(collect(diff.deltas()).map((delta) => ({
    status: delta.status(), oldPath: delta.oldFile().path(), newPath: delta.newFile().path(),
    before: content(delta.oldFile(), false), after: content(delta.newFile(), worktree),
  })));
};

/** es-git has no index.readTree: checkout into a temporary directory updates only the real index. */
const stageTree = (repo: git.Repository, target: git.GitObject, path?: string) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-git-index-"));
  try {
    const selected = path === undefined ? {} : {path};
    // Materialize the old index so checkout also removes entries absent from the target tree.
    repo.checkoutIndex(undefined, {force: true, updateIndex: false, targetDir: directory, ...selected});
    repo.checkoutTree(target, {force: true, updateIndex: true, targetDir: directory, ...selected});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
};

/** Move HEAD using branch APIs; libgit2 refuses to force-update an attached branch. */
const moveHead = (repo: git.Repository, target: git.Commit) => {
  if (repo.headDetached()) {
    repo.setHeadDetached(target);
    return;
  }
  const reference = repo.head();
  const previous = headCommit(repo);
  repo.setHeadDetached(target);
  try {
    repo.createBranch(reference.shorthand(), target, {force: true});
  } catch (error) {
    if (previous !== undefined) repo.setHeadDetached(previous);
    throw error;
  } finally {
    repo.setHead(reference.name());
  }
};

const switchTo = (repo: git.Repository, input: { readonly target: string; readonly create?: boolean | undefined; readonly force?: boolean | undefined }, detach = false) => {
  cleanState(repo);
  if (input.create && detach) reject("create and detach cannot be used together.");
  if (input.create && repo.findBranch(input.target, "Local") !== null) reject(`Branch ${input.target} already exists.`);
  const branch = input.create || detach ? null : repo.findBranch(input.target, "Local");
  if (!detach && !input.create && branch === null) reject(`No local branch named ${input.target}. Use checkout with detach for a revision.`);
  const start = branch === null ? input.target : `refs/heads/${input.target}`;
  const target = commit(repo, input.create ? "HEAD" : start);
  // Preflight before creating a branch or changing HEAD.
  const options = {force: input.force ?? false, overwriteIgnored: false};
  repo.checkoutTree(target.asObject(), {...options, dryRun: true});
  if (input.create) repo.createBranch(input.target, target);
  repo.checkoutTree(target.asObject(), options);
  if (detach) repo.setHeadDetached(target);
  else repo.setHead(`refs/heads/${input.target}`);
  return json({head: target.id(), branch: detach ? null : input.target});
};

/** For each action of a tool with an `action` input: the inputs it needs, and the other inputs it uses. */
type Actions<A extends string> = Readonly<Record<A, { readonly needs: ReadonlyArray<string>; readonly uses: ReadonlyArray<string> }>>;

/** Returns the line that a result ends with when inputs were not used by the call's action. */
const unusedNote = (action: string, unused: ReadonlyArray<string>): string => (unused.length === 0 ? "" : `\n[Not used by ${action}, so ignored: ${unused.join(", ")}.]`);

/**
 * Returns a git tool named `name` with the inputs `fields` and `repository`. Each call opens the
 * repository at `repository` (not a folder above it) and runs `run` with it. A value or an error
 * that `run` throws is the call's result or failure.
 */
const gitTool = <F extends Fields & { readonly intent?: never }>(
  name: string,
  kind: ToolSpec["kind"],
  readOnly: boolean,
  description: string,
  fields: F,
  run: (repo: git.Repository, input: Schema.Struct<WithRepository<F>>["Type"], signal: AbortSignal) => string | Promise<string>,
): Tool<WithRepository<F>> => ({
  name: ToolName.make(name),
  kind,
  replay: readOnly ? "safe" : "unsafe",
  description,
  // The struct of `repository` and `fields` has the fields `WithRepository<F>`.
  input: Schema.Struct({ repository: RepositoryPath, ...fields }) as unknown as Schema.Struct<WithRepository<F>>,
  run: (input) =>
    Effect.tryPromise({
      // Every git tool's input has `repository`, as `WithRepository` requires.
      try: async (signal) => run(await git.openRepository((input as { readonly repository: string }).repository, { noSearch: true }, signal), input, signal),
      catch: errorOf,
    }),
});

/**
 * Returns a git tool with an `action` input, as `gitTool` does. A call without an input that its
 * action needs is refused before the repository is opened. A call with inputs that its action does
 * not use (`actions`) runs without them: a WARN is logged, and the result ends with a note naming them.
 */
const actionTool = <A extends string, F extends Fields & { readonly intent?: never; readonly action: Schema.Top & { readonly Type: A } }>(
  name: string,
  kind: ToolSpec["kind"],
  description: string,
  actions: Actions<A>,
  fields: F,
  run: (repo: git.Repository, input: Schema.Struct<WithRepository<F>>["Type"] & { readonly action: A }, signal: AbortSignal) => string | Promise<string>,
): Tool<WithRepository<F>> => {
  // The input's `action` is one of `A`, as its field requires.
  const tool = gitTool(name, kind, false, description, fields, (repo, input, signal) => run(repo, input as Schema.Struct<WithRepository<F>>["Type"] & { readonly action: A }, signal));
  return {
    ...tool,
    run: (input) => {
      const given = input as Readonly<Record<string, unknown>> & { readonly action: A };
      const { needs, uses } = actions[given.action];
      const missing = needs.filter((each) => given[each] === undefined);
      if (missing.length > 0) return Effect.fail(new Rejected({ problem: `The ${given.action} action needs ${missing.join(" and ")}.` }));
      const unused = Object.keys(given).filter((each) => each !== "action" && each !== "repository" && given[each] !== undefined && !needs.includes(each) && !uses.includes(each));
      const logged = unused.length === 0 ? Effect.void : Effect.logWarning(logKeys.tools.inputIgnored, { tool: name, action: given.action, ignored: unused });
      return logged.pipe(
        Effect.andThen(tool.run(input)),
        Effect.map((output) => `${output}${unusedNote(given.action, unused)}`),
      );
    },
  };
};

/** The actions of `git_branch`. */
const branchActions: Actions<"list" | "create" | "delete" | "rename"> = {
  list: { needs: [], uses: ["type"] },
  create: { needs: ["name"], uses: ["start"] },
  delete: { needs: ["name"], uses: ["force"] },
  rename: { needs: ["name", "new_name"], uses: [] },
};

/** The actions of `git_remote`. */
const remoteActions: Actions<"list" | "add" | "set_url"> = {
  list: { needs: [], uses: [] },
  add: { needs: ["name", "url"], uses: [] },
  set_url: { needs: ["name", "url"], uses: [] },
};

/** The actions of `git_stash`. */
const stashActions: Actions<"list" | "save" | "apply" | "pop" | "drop"> = {
  list: { needs: [], uses: [] },
  save: { needs: [], uses: ["message", "include_untracked", "keep_index"] },
  apply: { needs: [], uses: ["index", "restore_index"] },
  pop: { needs: [], uses: ["index", "restore_index"] },
  drop: { needs: [], uses: ["index"] },
};

/** The actions of `git_tag`. */
const tagActions: Actions<"list" | "create" | "delete"> = {
  list: { needs: [], uses: ["pattern"] },
  create: { needs: ["name"], uses: ["target", "message", "force"] },
  delete: { needs: ["name"], uses: [] },
};

/** Returns `value`, an input that the call's action needs: `actionTool` refuses a call without it before `run`. */
const needed = <T>(value: T | undefined): T => value ?? reject("An input that the action needs is missing.");

/**
 * The git tools, each given to `use`, in order: `use` wraps a tool (`gitTools` binds it to a
 * repository) and returns it as a list holds it. `credential` is used by `git_push` and `git_pull`.
 */
export const gitToolsWith = <T>(
  use: <F extends Fields & { readonly intent?: never }>(tool: Tool<WithRepository<F>>) => T,
  options: { readonly credential?: git.Credential } = {},
): ReadonlyArray<T> => [
  use(
    gitTool(
      "git_status",
      "read",
      true,
      "List the changed paths, with their index and worktree status.",
      { path: Schema.optionalKey(pathspec("Optional: a file or folder, relative to the repository's root, whose changes to list. Default: the whole repository.")) },
      (repo, input) => {
        const path = input.path === undefined ? undefined : checkedPath(input.path).replace(/\/$/, "");
        return json(collect(repo.statuses().iter()).filter((entry) => path === undefined || path === "." || entry.path() === path || entry.path().startsWith(`${path}/`)).map((entry) => ({ path: entry.path(), ...entry.status() })));
      },
    ),
  ),
  use(
    actionTool(
      "git_branch",
      "edit",
      "List, create, rename or delete local branches. The list marks the current branch.",
      branchActions,
      {
        action: Schema.Literals(["list", "create", "delete", "rename"]).annotate({ description: "What to do." }),
        type: Schema.optionalKey(Schema.Literals(["Local", "Remote"]).annotate({ description: "Optional, for list: the branches to list. Default: local and remote branches." })),
        name: optionalText("For create, delete and rename: the branch's name."),
        start: optionalText("Optional, for create: the revision that the branch starts at. Default: HEAD."),
        force: flag("Optional, for delete: delete a branch that is not merged into HEAD. Default: false."),
        new_name: optionalText("For rename: the branch's new name."),
      },
      (repo, input) => {
        if (input.action === "list") {
          // As `git branch` marks the current branch with `*`, the list marks it `current`.
          const head = repo.getReference("HEAD").symbolicTarget();
          return json(collect(repo.branches(input.type === undefined ? {} : { type: input.type })).map((branch) => ({ ...branch, ...(branch.type === "Local" && head === `refs/heads/${branch.name}` ? { current: true } : {}) })));
        }
        const name = needed(input.name);
        if (input.action === "create") {
          repo.createBranch(name, commit(repo, input.start));
          return `Created ${name}.`;
        }
        const branch = repo.getBranch(name, "Local");
        if (input.action === "rename") {
          branch.rename(needed(input.new_name));
          return `Renamed ${name} to ${input.new_name}.`;
        }
        if (branch.isHead()) reject("Cannot delete the current branch.");
        const target = branch.referenceTarget();
        if (!input.force && target !== null && repo.getMergeBase(commit(repo).id(), target) !== target) reject("Branch is not merged into HEAD; force is required to delete it.");
        // oxlint-disable-next-line abstract/no-in-place-change -- es-git branch deletion, not a collection mutation.
        branch.delete();
        return `Deleted ${name}.`;
      },
    ),
  ),
  use(
    gitTool(
      "git_diff",
      "read",
      true,
      "Return the changed files, with each file's content before and after: UTF-8 text, or a binary file's size. Default: the worktree compared with the index.",
      {
        staged: flag("Optional: compare the index with HEAD instead. Default: false."),
        from: optionalText("Optional: a revision to compare the worktree with; with to, the first of two revisions."),
        to: optionalText("Optional, with from: the second revision."),
        path: Schema.optionalKey(pathspec("Optional: a file or folder, relative to the repository's root, to limit the diff to.")),
      },
      (repo, input) => {
        if (input.to !== undefined && input.from === undefined) reject("to requires from.");
        if (input.staged && (input.from !== undefined || input.to !== undefined)) reject("staged cannot be combined with from or to.");
        const diffOptions = input.path === undefined ? {} : { pathspecs: [checkedPath(input.path)] };
        if (input.staged) return changes(repo, repo.diffTreeToTree(headCommit(repo)?.tree(), repo.getTree(repo.index().writeTree()), diffOptions));
        if (input.to !== undefined) return changes(repo, repo.diffTreeToTree(commit(repo, input.from).tree(), commit(repo, input.to).tree(), diffOptions));
        if (input.from !== undefined) return changes(repo, repo.diffTreeToWorkdirWithIndex(commit(repo, input.from).tree(), diffOptions), true);
        return changes(repo, repo.diffIndexToWorkdir(undefined, diffOptions), true);
      },
    ),
  ),
  use(
    gitTool(
      "git_log",
      "read",
      true,
      "Return the commit history, newest first.",
      {
        revision: optionalText("Optional: the revision to start from, or a range A..B. Default: HEAD."),
        limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).annotate({ description: "Optional: the number of commits to return, at most 1000. Default: 20." })),
      },
      (repo, input) => {
        if (input.revision === undefined && headCommit(repo) === undefined) return "[]";
        const walk = repo.revwalk().setSorting(git.RevwalkSort.Topological | git.RevwalkSort.Time);
        if (input.revision?.includes("..")) walk.pushRange(input.revision);
        // oxlint-disable-next-line abstract/no-in-place-change -- Seed the native revision walker.
        else walk.push(repo.revparseSingle(input.revision ?? "HEAD"));
        return json(Array.from({ length: input.limit ?? 20 }, () => walk.next()).flatMap((id) => (id === null ? [] : [summary(repo.getCommit(id))])));
      },
    ),
  ),
  use(
    gitTool(
      "git_show",
      "read",
      true,
      "Show a commit and its changes from its first parent, with each file's content before and after; or show the UTF-8 content of a blob.",
      { revision: optionalText("Optional: a commit's revision, or a blob as revision:path, such as HEAD:src/a.ts. Default: HEAD.") },
      (repo, input) => {
        const target = object(repo, input.revision ?? "HEAD");
        if (target.type() === "Blob") return Buffer.from(target.peelToBlob().content()).toString("utf8");
        const value = target.peelToCommit();
        // oxlint-disable-next-line abstract/no-in-place-change -- Seed the native revision walker.
        const walk = repo.revwalk().simplifyFirstParent().push(value.id());
        walk.next();
        const parentId = walk.next();
        const parent = parentId === null ? undefined : repo.getCommit(parentId).tree();
        return `${json(summary(value))}\n${changes(repo, repo.diffTreeToTree(parent, value.tree()))}`;
      },
    ),
  ),
  use(
    actionTool(
      "git_remote",
      "edit",
      "List the remotes, add a remote, or change a remote's fetch URL.",
      remoteActions,
      {
        action: Schema.Literals(["list", "add", "set_url"]).annotate({ description: "What to do." }),
        name: optionalText("For add and set_url: the remote's name."),
        url: optionalText("For add and set_url: the remote's URL."),
      },
      (repo, input) => {
        if (input.action === "list")
          return json(
            repo.remoteNames().map((name) => {
              const remote = repo.getRemote(name);
              return { name, url: remote.url(), pushUrl: remote.pushurl() };
            }),
          );
        const [name, url] = [needed(input.name), needed(input.url)];
        if (input.action === "add") repo.createRemote(name, url);
        else {
          repo.getRemote(name);
          repo.config().setString(`remote.${name}.url`, url);
        }
        return `Remote ${name} updated.`;
      },
    ),
  ),
  use(
    gitTool("git_rev_parse", "read", true, "Return the full object ID of a revision, or of revision:path.", { revision: text("The revision, or revision:path.") }, (repo, input) =>
      repo.revparseSingle(input.revision),
    ),
  ),
  use(
    gitTool(
      "git_add",
      "edit",
      false,
      "Stage the additions, changes and deletions that match the pathspecs.",
      {
        paths: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)).annotate({ description: 'Pathspecs relative to the repository\'s root. ["."] stages everything.' }),
        force: flag("Optional: stage ignored files too. Default: false."),
      },
      (repo, input) => {
        const specs = input.paths.map(checkedPath);
        const index = repo.index();
        index.addAll(specs, { force: input.force ?? false });
        index.updateAll(specs);
        index.write();
        return "Index updated.";
      },
    ),
  ),
  use(
    gitTool(
      "git_commit",
      "edit",
      false,
      "Commit the staged changes and move HEAD to the new commit. The result is the commit's ID.",
      {
        message: text("The commit message."),
        author: identity("Optional: the author. Default: the repository's configured identity."),
        committer: identity("Optional: the committer. Default: the repository's configured identity."),
        allow_empty: flag("Optional: commit when nothing is staged. Default: false."),
      },
      (repo, input) => {
        cleanState(repo);
        const index = repo.index();
        if (index.hasConflicts()) reject("Resolve index conflicts before committing.");
        const tree = repo.getTree(index.writeTree());
        const parent = headCommit(repo);
        if (!input.allow_empty && (parent === undefined ? tree.isEmpty() : parent.treeId() === tree.id())) reject("Nothing staged to commit.");
        return repo.commit(tree, input.message, {
          updateRef: "HEAD",
          parents: parent === undefined ? [] : [parent.id()],
          ...(input.author === undefined ? {} : { author: input.author }),
          ...(input.committer === undefined ? {} : { committer: input.committer }),
        });
      },
    ),
  ),
  use(
    gitTool(
      "git_push",
      "execute",
      false,
      "Push to a remote.",
      {
        remote: optionalText("Optional: the remote. Default: origin."),
        refspecs: Schema.optionalKey(
          Schema.Array(Schema.NonEmptyString)
            .check(Schema.isMinLength(1))
            .annotate({ description: "Optional: the refspecs to push; a refspec can delete or force-update a reference. Default: the current branch, to the remote branch of the same name." }),
        ),
      },
      async (repo, input, signal) => {
        const head = repo.head();
        if (input.refspecs === undefined && !head.isBranch()) reject("Detached HEAD requires explicit refspecs.");
        const failures: string[] = [];
        // oxlint-disable-next-line abstract/no-in-place-change -- Native remote push operation.
        await repo.getRemote(input.remote ?? "origin").push(
          input.refspecs === undefined ? [`${head.name()}:${head.name()}`] : [...input.refspecs],
          {
            ...(options.credential === undefined ? {} : { credential: options.credential }),
            callbacks: {
              pushUpdateReference: (ref, status) => {
                // oxlint-disable-next-line abstract/no-in-place-change -- Collect failures from the native callback during this push.
                if (status !== null) failures.push(`${ref}: ${status}`);
              },
            },
          },
          signal,
        );
        if (failures.length > 0) throw new Error(failures.join("\n"));
        return "Push completed.";
      },
    ),
  ),
  use(
    gitTool(
      "git_pull",
      "execute",
      false,
      "Fetch a remote branch and fast-forward the current branch to it. A history that has diverged is refused: no merge or rebase is done.",
      {
        remote: optionalText("Optional: the remote. Default: the current branch's upstream remote, else origin."),
        branch: optionalText("Optional: the remote branch. Default: the current branch's upstream branch, else the current branch's name."),
      },
      async (repo, input, signal) => {
        cleanState(repo);
        const head = repo.head();
        if (!head.isBranch()) reject("Pull requires an attached local branch.");
        const config = repo.config();
        const remoteName = input.remote ?? config.findString(`branch.${head.shorthand()}.remote`) ?? "origin";
        const branchName = input.branch ?? (input.remote === undefined ? config.findString(`branch.${head.shorthand()}.merge`)?.replace(/^refs\/heads\//, "") : undefined) ?? head.shorthand();
        if (!git.isValidBranchName(branchName)) reject("Invalid remote branch name.");
        const remote = repo.getRemote(remoteName);
        await remote.fetch([`refs/heads/${branchName}`], { fetch: options.credential === undefined ? {} : { credential: options.credential } }, signal);
        const target = commit(repo, "FETCH_HEAD");
        const { analysis } = repo.analyzeMerge([repo.getAnnotatedCommit(target)]);
        if (analysis.upToDate) return "Already up to date.";
        if (!analysis.fastForward) reject("Pull requires a fast-forward; local and remote histories have diverged.");
        repo.checkoutTree(target.asObject(), { overwriteIgnored: false });
        moveHead(repo, target);
        return `Fast-forwarded to ${target.id()}.`;
      },
    ),
  ),
  use(
    gitTool(
      "git_switch",
      "edit",
      false,
      "Switch to a local branch.",
      {
        target: text("The branch's name."),
        create: flag("Optional: create the branch at HEAD first. Default: false."),
        force: flag("Optional: discard changes to tracked files that conflict with the switch. Default: false."),
      },
      (repo, input) => switchTo(repo, input),
    ),
  ),
  use(
    gitTool(
      "git_checkout",
      "edit",
      false,
      "Check out a local branch, create a branch at HEAD, or check out a revision with HEAD detached. To restore files, use git_restore.",
      {
        target: text("The branch's name; with detach, a revision."),
        create: flag("Optional: create the branch at HEAD first. Default: false."),
        detach: flag("Optional: check out the revision with HEAD detached. Default: false."),
        force: flag("Optional: discard changes to tracked files that conflict with the checkout. Default: false."),
      },
      (repo, input) => switchTo(repo, input, input.detach ?? false),
    ),
  ),
  use(
    gitTool(
      "git_restore",
      "edit",
      false,
      "Restore files from the index or from a revision, discarding the changes in the destination.",
      {
        path: pathspec("A pathspec relative to the repository's root."),
        source: optionalText("Optional: the revision to restore from. Default: the index, for the worktree; HEAD, for the index."),
        staged: flag("Optional: restore the index. Default: false."),
        worktree: flag("Optional: restore the worktree. Default: true, unless staged is true."),
      },
      (repo, input) => {
        const path = checkedPath(input.path);
        const staged = input.staged ?? false;
        const worktree = input.worktree ?? !staged;
        if (!staged && !worktree) reject("Select staged or worktree.");
        const target = input.source !== undefined || staged ? object(repo, input.source ?? "HEAD") : undefined;
        if (staged && target !== undefined) stageTree(repo, target, path);
        if (worktree) {
          const checkout = { path, force: true, updateIndex: false };
          if (target === undefined) repo.checkoutIndex(undefined, checkout);
          else repo.checkoutTree(target, checkout);
        }
        return `Restored ${path}.`;
      },
    ),
  ),
  use(
    gitTool(
      "git_reset",
      "edit",
      false,
      "Move HEAD, and the current branch, to a revision.",
      {
        revision: optionalText("Optional: the revision. Default: HEAD."),
        mode: Schema.optionalKey(
          Schema.Literals(["soft", "mixed", "hard"]).annotate({
            description: "Optional: soft keeps the index and the worktree; mixed resets the index; hard resets the index and the tracked files in the worktree, discarding their changes. Default: mixed.",
          }),
        ),
      },
      (repo, input) => {
        cleanState(repo);
        const target = commit(repo, input.revision);
        const mode = input.mode ?? "mixed";
        if (mode === "hard") repo.checkoutTree(target.asObject(), { force: true, updateIndex: true });
        if (mode === "mixed") stageTree(repo, target.asObject());
        moveHead(repo, target);
        return `Reset ${mode} to ${target.id()}.`;
      },
    ),
  ),
  use(
    actionTool(
      "git_stash",
      "edit",
      "List, save, apply, pop or drop stashes.",
      stashActions,
      {
        action: Schema.Literals(["list", "save", "apply", "pop", "drop"]).annotate({ description: "What to do." }),
        message: optionalText("Optional, for save: the stash's message."),
        include_untracked: flag("Optional, for save: stash untracked files too. Default: false."),
        keep_index: flag("Optional, for save: leave the staged changes in the index. Default: false."),
        index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "Optional, for apply, pop and drop: the stash's index. Default: 0." })),
        restore_index: flag("Optional, for apply and pop: restore the staged changes to the index too. Default: false."),
      },
      (repo, input) => {
        if (input.action === "list") return json(collect(repo.stashList().iter()).map((entry) => ({ index: entry.index(), id: entry.id(), message: entry.message() })));
        if (input.action === "save")
          return repo.stashSave({ ...(input.message === undefined ? {} : { message: input.message }), includeUntracked: input.include_untracked ?? false, keepIndex: input.keep_index ?? false });
        const index = input.index ?? 0;
        if (input.action === "drop") repo.stashDrop(index);
        else if (input.action === "pop") repo.stashPop(index, { reinstantiateIndex: input.restore_index ?? false });
        else repo.stashApply(index, { reinstantiateIndex: input.restore_index ?? false });
        return `Stash ${input.action} completed.`;
      },
    ),
  ),
  use(
    actionTool(
      "git_tag",
      "edit",
      "List, create or delete tags.",
      tagActions,
      {
        action: Schema.Literals(["list", "create", "delete"]).annotate({ description: "What to do." }),
        pattern: optionalText("Optional, for list: a glob pattern that the tags' names match."),
        name: optionalText("For create and delete: the tag's name."),
        target: optionalText("Optional, for create: the revision to tag. Default: HEAD."),
        message: optionalText("Optional, for create: the message of an annotated tag. Default: a lightweight tag, which has no message."),
        force: flag("Optional, for create: replace a tag of the same name. Default: false."),
      },
      (repo, input) => {
        if (input.action === "list") return json(repo.tagNames(input.pattern));
        const name = needed(input.name);
        if (input.action === "delete") {
          repo.deleteTag(name);
          return `Deleted tag ${name}.`;
        }
        const target = object(repo, input.target ?? "HEAD");
        return input.message === undefined ? repo.createLightweightTag(name, target, { force: input.force ?? false }) : repo.createTag(name, target, input.message, { force: input.force ?? false });
      },
    ),
  ),
];

/** The system text that says the working folder is the root of the repository that the git tools work in. */
export const repositoryLine = "The working folder is the root of a git repository, which the git tools work in.";

/** Whether `folder` is the root of a git repository: it holds `.git`, a folder or a file. */
export const isRepositoryRoot = (folder: string): boolean => existsSync(join(folder, ".git"));

/**
 * The git tools bound to the repository at `root`: the catalog, the tool source that runs a call,
 * and the system text that says the working folder is the repository's root (`repositoryLine`).
 * With `strictInput`, a call whose input has properties its tool does not take is refused; without
 * (the default), it runs without them, and its result says which were ignored.
 */
export function gitTools(root: string, options: { readonly strictInput?: boolean; readonly credential?: git.Credential } = {}) {
  const tools = gitToolsWith((tool) => anyTool(described(bound({ repository: root })(tool))), options);
  return { catalog: tools.map((tool) => tool.spec), source: sourceOf(tools, { strictInput: options.strictInput ?? false }), system: repositoryLine };
}
