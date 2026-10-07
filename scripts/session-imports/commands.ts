/**
 * Builds the corpus of shell commands that coding agents ran, from their saved sessions, for
 * measuring the permission policy (`ask-rate.ts`) and, later, for a classifier:
 *
 *   bun run commands:import [--exo <bash-calls.jsonl>]
 *
 * The corpus is `~/.local/share/<brand>/session-imports/commands.jsonl`, one command a line:
 * `{ key, source, session, transcript, timestamp, cwd, command, model?, failed? }`. It only grows: a command
 * stays when its transcript is deleted (Claude Code removes transcripts older than its
 * `cleanupPeriodDays`, 30 unless set; `omp gc` removes omp's), so the numbers can be measured again.
 *
 * Sources, each read only where its transcripts are:
 * - `claude-code`: `~/.claude/projects/**.jsonl`, each `Bash` call's `command`;
 * - `codex`: `~/.codex/sessions/**.jsonl`, each `exec_command` call's `cmd`, whether called directly
 *   or from code mode's `exec` (`tools.exec_command({cmd: "…"})`, with the command a literal string);
 *   and each `shell` call's command (`bash -lc <script>`: the script);
 * - `omp`: `~/.omp/agent/sessions/**.jsonl`, each `bash` call's `command`. omp sends `cat`, `head`,
 *   `tail`, `grep` and `rg` to its own tools, so its commands have fewer of them;
 * - `--exo <file>`: exo-project's corpus (spike 01_1's `bash-calls.jsonl`, Claude Code's commands of
 *   August 2026), read once. Its rows have the keys that the `claude-code` source gives the same
 *   calls, so a call is in the corpus once.
 *
 * A command's key is its source, session and call id. A transcript is read again only when its size
 * or modification time changed since it was last read (`transcripts.json` beside the corpus), or when
 * this script reads more of a transcript than the version that wrote that index (`indexVersion`). A
 * command read again fills in the fields that its entry lacks (an older entry's `model`); an entry's
 * other fields are kept.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { brandFrom, dataFolderOf } from "../../src/agent-host/brand.ts";

/** One command in the corpus. */
export interface CorpusCommand {
  readonly key: string;
  readonly source: "claude-code" | "codex" | "omp";
  readonly session: string;
  readonly transcript: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly command: string;
  /** The model that made the call, where the transcript says. */
  readonly model?: string;
  /** Whether the call failed, where the transcript says. */
  readonly failed?: boolean;
}

/** The corpus's folder: `<data folder>/session-imports`. */
export const corpusFolder = join(dataFolderOf(brandFrom(process.env)), "session-imports");
export const corpusFile = join(corpusFolder, "commands.jsonl");
const indexFile = join(corpusFolder, "transcripts.json");
/** The version of what is read from each transcript; an index of an earlier version has every transcript read again. 2: the model. */
const indexVersion = 2;

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json };
type Row = { readonly [key: string]: Json };
const isRow = (value: Json | undefined): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");
const rows = (file: string): ReadonlyArray<Row> =>
  readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const parsed = JSON.parse(line) as Json;
        return isRow(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });

/** Claude Code: each `Bash` call, failed when its result says `is_error`. */
const claudeCode = (file: string): ReadonlyArray<CorpusCommand> => {
  const all = rows(file);
  const failed = new Set(
    all.flatMap((row) => {
      const content = isRow(row["message"]) ? row["message"]["content"] : undefined;
      return Array.isArray(content) ? content.flatMap((block: Json) => (isRow(block) && block["type"] === "tool_result" && block["is_error"] === true ? [text(block["tool_use_id"])] : [])) : [];
    }),
  );
  return all.flatMap((row) => {
    const content = isRow(row["message"]) ? row["message"]["content"] : undefined;
    if (row["type"] !== "assistant" || !Array.isArray(content)) return [];
    return content.flatMap((block: Json): ReadonlyArray<CorpusCommand> => {
      if (!isRow(block) || block["type"] !== "tool_use" || block["name"] !== "Bash" || !isRow(block["input"])) return [];
      const command = text(block["input"]["command"]);
      const session = text(row["sessionId"]);
      const id = text(block["id"]);
      const model = isRow(row["message"]) ? text(row["message"]["model"]) : "";
      return command === ""
        ? []
        : [{ key: `claude-code:${session}:${id}`, source: "claude-code", session, transcript: file, timestamp: text(row["timestamp"]), cwd: text(row["cwd"]), command, ...(model === "" ? {} : { model }), failed: failed.has(id) }];
    });
  });
};

/** The literal `cmd` strings of `tools.exec_command({cmd: "…"})` in Codex's code-mode source. */
const execCommandsIn = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/exec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/g)].flatMap((match) => {
    try {
      return [JSON.parse(match[1] ?? '""') as string];
    } catch {
      return [];
    }
  });

/** Codex: each `exec_command` call (direct or from code mode's `exec`) and each `shell` call. */
const codex = (file: string): ReadonlyArray<CorpusCommand> => {
  const all = rows(file);
  const meta = all.find((row) => row["type"] === "session_meta");
  const payload = meta !== undefined && isRow(meta["payload"]) ? meta["payload"] : {};
  const session = text(payload["id"]);
  const cwd = text(payload["cwd"]);
  // The model of each row: the latest turn context's, before it.
  const models = all.reduce<ReadonlyArray<string>>((sofar, row) => {
    const context = row["type"] === "turn_context" && isRow(row["payload"]) ? text(row["payload"]["model"]) : "";
    return [...sofar, context === "" ? (sofar.at(-1) ?? text(payload["model"])) : context];
  }, []);
  return all.flatMap((row, at) => {
    const call = isRow(row["payload"]) ? row["payload"] : undefined;
    if (row["type"] !== "response_item" || call === undefined) return [];
    const model = models[at] ?? "";
    const id = text(call["call_id"]);
    const commands = (() => {
      if (call["type"] === "custom_tool_call" && call["name"] === "exec") return execCommandsIn(text(call["input"]));
      if (call["type"] !== "function_call") return [];
      const args = (() => {
        try {
          const parsed = JSON.parse(text(call["arguments"])) as Json;
          return isRow(parsed) ? parsed : {};
        } catch {
          return {};
        }
      })();
      if (call["name"] === "exec_command") return [text(args["cmd"])];
      const shell = args["command"];
      if (call["name"] === "shell" && Array.isArray(shell)) {
        const words = shell.map((word: Json) => text(word));
        return [words.length === 3 && ["bash", "sh", "zsh"].includes(words[0] ?? "") && /^-l?c$/.test(words[1] ?? "") ? (words[2] ?? "") : words.join(" ")];
      }
      return [];
    })();
    return commands
      .filter((command) => command !== "")
      .map((command, index): CorpusCommand => ({ key: `codex:${session}:${id}:${index}`, source: "codex", session, transcript: file, timestamp: text(row["timestamp"]), cwd, command, ...(model === "" ? {} : { model }) }));
  });
};

/** omp: each `bash` call. */
const omp = (file: string): ReadonlyArray<CorpusCommand> => {
  const all = rows(file);
  const opened = all.find((row) => row["type"] === "session");
  const session = text(opened?.["id"]);
  const cwd = text(opened?.["cwd"]);
  // The model of each row: the latest model change's, before it.
  const models = all.reduce<ReadonlyArray<string>>((sofar, row) => [...sofar, row["type"] === "model_change" ? text(row["model"]) : (sofar.at(-1) ?? "")], []);
  return all.flatMap((row, at) => {
    const model = models[at] ?? "";
    const message = isRow(row["message"]) ? row["message"] : undefined;
    const content = message?.["content"];
    if (message?.["role"] !== "assistant" || !Array.isArray(content)) return [];
    return content.flatMap((block: Json): ReadonlyArray<CorpusCommand> => {
      if (!isRow(block) || block["type"] !== "toolCall" || block["name"] !== "bash" || !isRow(block["arguments"])) return [];
      const command = text(block["arguments"]["command"]);
      return command === "" ? [] : [{ key: `omp:${session}:${text(block["id"])}`, source: "omp", session, transcript: file, timestamp: text(row["timestamp"]), cwd, command, ...(model === "" ? {} : { model }) }];
    });
  });
};

/** exo-project's corpus: Claude Code's calls, keyed as the `claude-code` source keys them. */
const exoProject = (file: string): ReadonlyArray<CorpusCommand> =>
  rows(file).flatMap((row): ReadonlyArray<CorpusCommand> => {
    const command = text(row["command"]);
    const session = text(row["session_id"]);
    return command === ""
      ? []
      : [{ key: `claude-code:${session}:${text(row["tool_use_id"])}`, source: "claude-code", session, transcript: text(row["transcript"]), timestamp: text(row["timestamp"]), cwd: text(row["cwd"]), command, failed: row["is_error"] === true }];
  });

const sources = [
  { name: "claude-code", root: join(homedir(), ".claude", "projects"), extract: claudeCode },
  { name: "codex", root: join(homedir(), ".codex", "sessions"), extract: codex },
  { name: "omp", root: join(homedir(), ".omp", "agent", "sessions"), extract: omp },
] as const;

const transcriptsIn = (folder: string): ReadonlyArray<string> =>
  existsSync(folder)
    ? readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? transcriptsIn(join(folder, entry.name)) : entry.name.endsWith(".jsonl") ? [join(folder, entry.name)] : [],
      )
    : [];

if (import.meta.main) {
  mkdirSync(corpusFolder, { recursive: true });
  const entries = new Map<string, CorpusCommand>((existsSync(corpusFile) ? rows(corpusFile) : []).map((row) => [text(row["key"]), row as unknown as CorpusCommand]));
  const stored = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, "utf8")) as { readonly version?: number; readonly transcripts?: Record<string, string> }) : {};
  const index: Record<string, string> = stored.version === indexVersion ? { ...stored.transcripts } : {};
  const added: Record<string, number> = {};
  const filled: Record<string, number> = {};
  const take = (name: string, commands: ReadonlyArray<CorpusCommand>) => {
    for (const command of commands) {
      const before = entries.get(command.key);
      if (before === undefined) {
        entries.set(command.key, command);
        added[name] = (added[name] ?? 0) + 1;
      } else if (Object.keys(command).some((field) => !(field in before))) {
        entries.set(command.key, { ...command, ...before });
        filled[name] = (filled[name] ?? 0) + 1;
      }
    }
  };
  const exoAt = process.argv.indexOf("--exo");
  const exo = exoAt === -1 ? undefined : process.argv[exoAt + 1];
  if (exo !== undefined) {
    if (!existsSync(exo)) {
      console.error(`ERROR: No such file: ${exo}.`);
      console.error("HINT: Give --exo the path of exo-project's bash-calls.jsonl.");
      process.exit(1);
    }
    take("exo-project", exoProject(exo));
  }
  for (const source of sources) {
    for (const transcript of transcriptsIn(source.root)) {
      const stat = statSync(transcript);
      const seen = `${stat.size}:${stat.mtimeMs}`;
      if (index[transcript] === seen) continue;
      take(source.name, source.extract(transcript));
      index[transcript] = seen;
    }
  }
  writeFileSync(corpusFile, [...entries.values()].map((command) => `${JSON.stringify(command)}\n`).join(""));
  writeFileSync(indexFile, `${JSON.stringify({ version: indexVersion, transcripts: index }, null, 1)}\n`);
  const total = [...entries.values()].reduce<Record<string, number>>((counts, command) => ({ ...counts, [command.source]: (counts[command.source] ?? 0) + 1 }), {});
  console.log(`${corpusFile}`);
  console.log(`added: ${JSON.stringify(added)}; models filled in: ${JSON.stringify(filled)}`);
  console.log(`in the corpus: ${JSON.stringify(total)}`);
}
