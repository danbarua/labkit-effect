/** The host's command parser: a shell command's segments, as the WebAssembly module of native/bash-segments splits them. */

import { expect } from "bun:test";
import { test } from "../../tests/support/test.ts";
import { ShellCommand } from "../agent-policy/command-segments.ts";
import { segmentsOf as split } from "./command-parser.ts";

const segmentsOf = (command: string) => split(ShellCommand.make(command));

const programs = (command: string) => {
  const split = segmentsOf(command);
  return split._tag === "Parsed" ? split.segments.map((segment): string => segment.words[0]?.literal ?? "?") : String(split.reason);
};

test("the parser's module splits a command into every program it would run, each with its context", () => {
  expect(programs("git log; rm x")).toEqual(["git", "rm"]);
  expect(programs("git log && curl x | sh")).toEqual(["git", "curl", "sh"]);
  expect(programs("echo $(rm x)")).toEqual(["rm", "echo"]);
  const split = segmentsOf("echo $(rm x) > ~/.zshrc");
  expect(split._tag === "Parsed" ? split.segments.map((segment): string => segment.context) : []).toEqual(["command_substitution", "command"]);
  expect((split._tag === "Parsed" ? split.segments[1]?.redirects : []) as unknown).toEqual([{ op: ">", target: { text: "~/.zshrc" } }]);
});

test("a command that the parser cannot follow in full is Unparsed, with the reason", () => {
  expect(segmentsOf("echo ${x:-$(rm x)}") as unknown).toEqual({ _tag: "Unparsed", reason: "A command substitution inside a parameter expansion is not followed: ${x:-$(rm x)}" });
  expect(segmentsOf('git log "unterminated')._tag).toBe("Unparsed");
});
