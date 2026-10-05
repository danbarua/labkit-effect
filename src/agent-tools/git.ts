/** Git tools backed by es-git. Constructing the catalog does not open or change a repository. */
import {mkdtempSync, readFileSync, readlinkSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import * as git from "es-git";
import {Data, Effect, Schema} from "effect";
import {FailureText, ToolName} from "../agent-machine/names.ts";
import type {ToolOutcome} from "../agent-machine/observation.ts";
import type {ToolSpec} from "../agent-session/contracts.ts";
import type {ToolSource} from "../agent-session/tool-sources.ts";
import {decoderOf, ignoredNote, jsonSchemaOf} from "../agent-session/tool-input.ts";
import {parseJson, receivedText} from "../agent-session/received.ts";

const text = Schema.NonEmptyString;
const optionalText = Schema.optionalKey(text);
const flag = Schema.optionalKey(Schema.Boolean);
const paths = Schema.Array(text).check(Schema.isMinLength(1));
const identity = Schema.Struct({name: text, email: text});
const revision = Schema.Struct({revision: optionalText});
const switching = Schema.Struct({target: text, create: flag, force: flag});

class Rejected extends Data.TaggedError("Rejected")<{ readonly problem: string }> {
}

class Reported extends Data.TaggedError("Reported")<{ readonly message: string }> {
}

const reject = (problem: string): never => {
    throw new Rejected({problem});
};
const errorOf = (error: unknown): Rejected | Reported => error instanceof Rejected ? error : new Reported({message: error instanceof Error ? error.message : String(error)});
const collect = <T>(iterator: Iterator<T>): T[] => Array.from({[Symbol.iterator]: () => iterator});
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

const switchTo = (repo: git.Repository, input: typeof switching.Type, detach = false) => {
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

interface GitTool extends ToolSpec {
    readonly execute: (input: unknown) => Effect.Effect<string, Rejected | Reported>;
}

/** All paths are relative to this repository's root. Credentials come from the host, never tool inputs. */
export function gitTools(root: string, options: {
    readonly strictInput?: boolean;
    readonly credential?: git.Credential
} = {}) {
    const repositoryPath = resolve(root);
    const define = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
        name: string, schema: S, kind: ToolSpec["kind"], readOnly: boolean, description: string,
        run: (repo: git.Repository, input: S["Type"], signal: AbortSignal) => string | Promise<string>,
    ): GitTool => ({
        name: ToolName.make(name), kind, replay: readOnly ? "safe" : "unsafe",
        description: `${description} Repository: ${repositoryPath}.`, input: jsonSchemaOf(schema),
        execute: (input) => decoderOf(schema, options.strictInput ?? false)(input).pipe(
            Effect.mapError((error) => new Rejected({problem: `${name} does not take this input: ${error.message}`})),
            Effect.flatMap(({value, ignored}) => Effect.tryPromise({
                try: async (signal) => {
                    const repo = await git.openRepository(repositoryPath, {noSearch: true}, signal);
                    return await run(repo, value, signal);
                },
                catch: errorOf,
            }).pipe(
                Effect.map((output) => `${output}${ignoredNote(name, ignored)}`),
                Effect.mapError((error) => error instanceof Reported ? new Reported({message: `${error.message}${ignoredNote(name, ignored)}`}) : error),
            )),
        ),
    });

    const tools: ReadonlyArray<GitTool> = [
        define("status", Schema.Struct({path: optionalText}), "read", true, "List changed paths and their index/worktree status flags. Optional path filters to a repository-relative file or directory.", (repo, input) => {
            const path = input.path === undefined ? undefined : checkedPath(input.path).replace(/\/$/, "");
            return json(collect(repo.statuses().iter()).filter((entry) => path === undefined || path === "." || entry.path() === path || entry.path().startsWith(`${path}/`)).map((entry) => ({path: entry.path(), ...entry.status()})));
        }),
        define("branch", Schema.Union([
            Schema.Struct({
                action: Schema.Literal("list"),
                type: Schema.optionalKey(Schema.Literals(["Local", "Remote"]))
            }),
            Schema.Struct({action: Schema.Literal("create"), name: text, start: optionalText}),
            Schema.Struct({action: Schema.Literal("delete"), name: text, force: flag}),
            Schema.Struct({action: Schema.Literal("rename"), name: text, newName: text}),
        ]), "edit", false, "List, create, rename, or delete local branches. Deletion requires a merged branch unless force is true.", (repo, input) => {
            if (input.action === "list") return json(collect(repo.branches(input.type === undefined ? {} : {type: input.type})));
            if (input.action === "create") {
                repo.createBranch(input.name, commit(repo, input.start));
                return `Created ${input.name}.`;
            }
            const branch = repo.getBranch(input.name, "Local");
            if (input.action === "rename") {
                branch.rename(input.newName);
                return `Renamed ${input.name} to ${input.newName}.`;
            }
            if (branch.isHead()) reject("Cannot delete the current branch.");
            const target = branch.referenceTarget();
            if (!input.force && target !== null && repo.getMergeBase(commit(repo).id(), target) !== target) reject("Branch is not merged into HEAD; force is required to delete it.");
            // oxlint-disable-next-line abstract/no-in-place-change -- es-git branch deletion, not a collection mutation.
            branch.delete();
            return `Deleted ${input.name}.`;
        }),
        define("diff", Schema.Struct({
                staged: flag,
                from: optionalText,
                to: optionalText,
                path: optionalText
            }), "read", true,
            "Return changed files with explicit before/after UTF-8 content (binary files report size). Default: index versus worktree; staged: HEAD versus index; from: revision versus worktree; from and to: two revisions.", (repo, input) => {
                if (input.to !== undefined && input.from === undefined) reject("to requires from.");
                if (input.staged && (input.from !== undefined || input.to !== undefined)) reject("staged cannot be combined with from or to.");
                const diffOptions = input.path === undefined ? {} : {pathspecs: [checkedPath(input.path)]};
                if (input.staged) return changes(repo, repo.diffTreeToTree(headCommit(repo)?.tree(), repo.getTree(repo.index().writeTree()), diffOptions));
                if (input.to !== undefined) return changes(repo, repo.diffTreeToTree(commit(repo, input.from).tree(), commit(repo, input.to).tree(), diffOptions));
                if (input.from !== undefined) return changes(repo, repo.diffTreeToWorkdirWithIndex(commit(repo, input.from).tree(), diffOptions), true);
                return changes(repo, repo.diffIndexToWorkdir(undefined, diffOptions), true);
            }),
        define("log", Schema.Struct({
                revision: optionalText,
                limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 1000})))
            }), "read", true,
            "Return commit history, newest first (default 20, maximum 1000). revision may be a revision or A..B range.", (repo, input) => {
                if (input.revision === undefined && headCommit(repo) === undefined) return "[]";
                const walk = repo.revwalk().setSorting(git.RevwalkSort.Topological | git.RevwalkSort.Time);
                if (input.revision?.includes("..")) walk.pushRange(input.revision);
                // oxlint-disable-next-line abstract/no-in-place-change -- Seed the native revision walker.
                else walk.push(repo.revparseSingle(input.revision ?? "HEAD"));
                return json(Array.from({length: input.limit ?? 20}, () => walk.next()).flatMap((id) => id === null ? [] : [summary(repo.getCommit(id))]));
            }),
        define("show", revision, "read", true, "Show a commit and its first-parent changes (explicit before/after file content), or the UTF-8 contents of a blob such as HEAD:path.", (repo, input) => {
            const target = object(repo, input.revision ?? "HEAD");
            if (target.type() === "Blob") return Buffer.from(target.peelToBlob().content()).toString("utf8");
            const value = target.peelToCommit();
            // oxlint-disable-next-line abstract/no-in-place-change -- Seed the native revision walker.
            const walk = repo.revwalk().simplifyFirstParent().push(value.id());
            walk.next();
            const parentId = walk.next();
            const parent = parentId === null ? undefined : repo.getCommit(parentId).tree();
            return `${json(summary(value))}\n${changes(repo, repo.diffTreeToTree(parent, value.tree()))}`;
        }),
        define("remote", Schema.Union([
            Schema.Struct({action: Schema.Literal("list")}),
            Schema.Struct({action: Schema.Literal("add"), name: text, url: text}),
            Schema.Struct({action: Schema.Literal("setUrl"), name: text, url: text}),
        ]), "edit", false, "List remotes, add a remote, or set a remote's fetch URL.", (repo, input) => {
            if (input.action === "list") return json(repo.remoteNames().map((name) => {
                const remote = repo.getRemote(name);
                return {name, url: remote.url(), pushUrl: remote.pushurl()};
            }));
            if (input.action === "add") repo.createRemote(input.name, input.url);
            else {
                repo.getRemote(input.name);
                repo.config().setString(`remote.${input.name}.url`, input.url);
            }
            return `Remote ${input.name} updated.`;
        }),
        define("revParse", Schema.Struct({revision: text}), "read", true, "Resolve a single revision or revision:path to its full object ID.", (repo, input) => repo.revparseSingle(input.revision)),
        define("add", Schema.Struct({
            paths,
            force: flag
        }), "edit", false, "Stage additions, modifications, and deletions matching repository-relative pathspecs. Use ['.'] for all paths; force includes ignored files.", (repo, input) => {
            const specs = input.paths.map(checkedPath);
            const index = repo.index();
            index.addAll(specs, {force: input.force ?? false});
            index.updateAll(specs);
            index.write();
            return "Index updated.";
        }),
        define("commit", Schema.Struct({
                message: text,
                author: Schema.optionalKey(identity),
                committer: Schema.optionalKey(identity),
                allowEmpty: flag
            }), "edit", false,
            "Commit the staged index and advance HEAD. Uses repository identity unless author/committer are supplied. Refuses empty commits by default.", (repo, input) => {
                cleanState(repo);
                const index = repo.index();
                if (index.hasConflicts()) reject("Resolve index conflicts before committing.");
                const tree = repo.getTree(index.writeTree());
                const parent = headCommit(repo);
                if (!input.allowEmpty && (parent === undefined ? tree.isEmpty() : parent.treeId() === tree.id())) reject("Nothing staged to commit.");
                return repo.commit(tree, input.message, {
                    updateRef: "HEAD", parents: parent === undefined ? [] : [parent.id()],
                    ...(input.author === undefined ? {} : {author: input.author}), ...(input.committer === undefined ? {} : {committer: input.committer})
                });
            }),
        define("push", Schema.Struct({remote: optionalText, refspecs: Schema.optionalKey(paths)}), "execute", false,
            "Push to remote (default origin). Default refspec pushes the current local branch to the same remote branch. Explicit refspecs can delete or force-update refs.", async (repo, input, signal) => {
                const head = repo.head();
                if (input.refspecs === undefined && !head.isBranch()) reject("Detached HEAD requires explicit refspecs.");
                const failures: string[] = [];
                // oxlint-disable-next-line abstract/no-in-place-change -- Native remote push operation.
                await repo.getRemote(input.remote ?? "origin").push(input.refspecs === undefined ? [`${head.name()}:${head.name()}`] : [...input.refspecs], {
                    ...(options.credential === undefined ? {} : {credential: options.credential}),
                    callbacks: {
                        pushUpdateReference: (ref, status) => {
                            // oxlint-disable-next-line abstract/no-in-place-change -- Collect failures from the native callback during this push.
                            if (status !== null) failures.push(`${ref}: ${status}`);
                        }
                    },
                }, signal);
                if (failures.length > 0) throw new Error(failures.join("\n"));
                return "Push completed.";
            }),
        define("pull", Schema.Struct({remote: optionalText, branch: optionalText}), "execute", false,
            "Fetch and fast-forward the current branch only. Uses its configured upstream, or origin and the current branch name. Diverged history is refused; no merge or rebase is performed.", async (repo, input, signal) => {
                cleanState(repo);
                const head = repo.head();
                if (!head.isBranch()) reject("Pull requires an attached local branch.");
                const config = repo.config();
                const remoteName = input.remote ?? config.findString(`branch.${head.shorthand()}.remote`) ?? "origin";
                const branchName = input.branch ?? (input.remote === undefined ? config.findString(`branch.${head.shorthand()}.merge`)?.replace(/^refs\/heads\//, "") : undefined) ?? head.shorthand();
                if (!git.isValidBranchName(branchName)) reject("Invalid remote branch name.");
                const remote = repo.getRemote(remoteName);
                await remote.fetch([`refs/heads/${branchName}`], {fetch: options.credential === undefined ? {} : {credential: options.credential}}, signal);
                const target = commit(repo, "FETCH_HEAD");
                const {analysis} = repo.analyzeMerge([repo.getAnnotatedCommit(target)]);
                if (analysis.upToDate) return "Already up to date.";
                if (!analysis.fastForward) reject("Pull requires a fast-forward; local and remote histories have diverged.");
                repo.checkoutTree(target.asObject(), {overwriteIgnored: false});
                moveHead(repo, target);
                return `Fast-forwarded to ${target.id()}.`;
            }),
        define("switch", switching, "edit", false, "Switch to a local branch; create creates it from HEAD. force discards conflicting tracked changes.", (repo, input) => switchTo(repo, input)),
        define("checkout", Schema.Struct({target: text, create: flag, detach: flag, force: flag}), "edit", false,
            "Check out a local branch, create one from HEAD, or check out a revision with detach=true. Use restore for paths.", (repo, input) => switchTo(repo, input, input.detach ?? false)),
        define("restore", Schema.Struct({
                path: text,
                source: optionalText,
                staged: flag,
                worktree: flag
            }), "edit", false,
            "Restore a pathspec. Default: worktree from index. staged restores index from HEAD; source overrides the source revision. staged and worktree together restore both. Discards changes in the selected destination.", (repo, input) => {
                const path = checkedPath(input.path);
                const staged = input.staged ?? false;
                const worktree = input.worktree ?? !staged;
                if (!staged && !worktree) reject("Select staged or worktree.");
                const target = input.source !== undefined || staged ? object(repo, input.source ?? "HEAD") : undefined;
                if (staged && target !== undefined) stageTree(repo, target, path);
                if (worktree) {
                    const checkout = {path, force: true, updateIndex: false};
                    if (target === undefined) repo.checkoutIndex(undefined, checkout);
                    else repo.checkoutTree(target, checkout);
                }
                return `Restored ${path}.`;
            }),
        define("reset", Schema.Struct({
                revision: optionalText,
                mode: Schema.optionalKey(Schema.Literals(["soft", "mixed", "hard"]))
            }), "edit", false,
            "Move HEAD to a revision (default HEAD). soft preserves index/worktree; mixed (default) resets index; hard resets index and tracked worktree, discarding changes.", (repo, input) => {
                cleanState(repo);
                const target = commit(repo, input.revision);
                const mode = input.mode ?? "mixed";
                if (mode === "hard") repo.checkoutTree(target.asObject(), {force: true, updateIndex: true});
                if (mode === "mixed") stageTree(repo, target.asObject());
                moveHead(repo, target);
                return `Reset ${mode} to ${target.id()}.`;
            }),
        define("stash", Schema.Union([
            Schema.Struct({action: Schema.Literal("list")}),
            Schema.Struct({
                action: Schema.Literal("save"),
                message: optionalText,
                includeUntracked: flag,
                keepIndex: flag
            }),
            Schema.Struct({
                action: Schema.Literals(["apply", "pop", "drop"]),
                index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
                restoreIndex: flag
            }),
        ]), "edit", false, "List, save, apply, pop, or drop stashes. index defaults to 0; restoreIndex also restores staged changes when applying/popping.", (repo, input) => {
            if (input.action === "list") return json(collect(repo.stashList().iter()).map((entry) => ({
                index: entry.index(),
                id: entry.id(),
                message: entry.message()
            })));
            if (input.action === "save") return repo.stashSave({
                ...(input.message === undefined ? {} : {message: input.message}),
                includeUntracked: input.includeUntracked ?? false,
                keepIndex: input.keepIndex ?? false
            });
            const index = input.index ?? 0;
            if (input.action === "drop") repo.stashDrop(index);
            else if (input.action === "pop") repo.stashPop(index, {reinstantiateIndex: input.restoreIndex ?? false});
            else repo.stashApply(index, {reinstantiateIndex: input.restoreIndex ?? false});
            return `Stash ${input.action} completed.`;
        }),
        define("tag", Schema.Union([
            Schema.Struct({action: Schema.Literal("list"), pattern: optionalText}),
            Schema.Struct({
                action: Schema.Literal("create"),
                name: text,
                target: optionalText,
                message: optionalText,
                force: flag
            }),
            Schema.Struct({action: Schema.Literal("delete"), name: text}),
        ]), "edit", false, "List, create, or delete tags. A message creates an annotated tag; otherwise the tag is lightweight.", (repo, input) => {
            if (input.action === "list") return json(repo.tagNames(input.pattern));
            if (input.action === "delete") {
                repo.deleteTag(input.name);
                return `Deleted tag ${input.name}.`;
            }
            const target = object(repo, input.target ?? "HEAD");
            return input.message === undefined ? repo.createLightweightTag(input.name, target, {force: input.force ?? false}) : repo.createTag(input.name, target, input.message, {force: input.force ?? false});
        }),
    ];
    const catalog: ReadonlyArray<ToolSpec> = tools.map(({name, kind, replay, description, input}) => ({
        name,
        kind,
        replay,
        description,
        input
    }));
    const rejected = (problem: string): ToolOutcome => ({
        _tag: "Failed",
        reason: {_tag: "InputRejected", problem: FailureText.make(problem)}
    });
    const source: Effect.Effect<ToolSource> = Effect.succeed({
        tools: catalog,
        run: (name, input) => {
            const found = tools.find((tool) => tool.name === name);
            if (found === undefined) return Effect.succeed<ToolOutcome>({_tag: "Failed", reason: {_tag: "NotFound"}});
            const parsed = parseJson(input);
            if ("reason" in parsed) return Effect.succeed(rejected(`The input could not be read: ${parsed.reason}.`));
            return found.execute(parsed.value).pipe(
                Effect.map((output): ToolOutcome => ({_tag: "Succeeded", output: receivedText(output)})),
                Effect.catchTags({
                    Rejected: (error) => Effect.succeed(rejected(error.problem)),
                    Reported: (error) => Effect.succeed<ToolOutcome>({
                        _tag: "Failed",
                        reason: {_tag: "Reported", error: receivedText(error.message)}
                    }),
                }),
            );
        },
    });
    return {catalog, source};
}
