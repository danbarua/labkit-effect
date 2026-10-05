/** The permission policy: which calls run, which are vetoed, which wait for an answer, by mode. */

import { expect } from "bun:test";
import { observe, open } from "../../tests/support/drive.ts";
import { test } from "../../tests/support/test.ts";
import type { Fact } from "../agent-machine/fact.ts";
import { CallId, type ToolKind, ToolName } from "../agent-machine/names.ts";
import type { EffectRequest } from "../agent-machine/request.ts";
import { receivedJson } from "../agent-session/received.ts";
import { answerPicking, OptionId, type PermissionMode, permissions, questionIn } from "./permissions.ts";
import type { PolicyStep } from "./policy.ts";

const kinds: Record<string, ToolKind> = { read_file: "read", write_file: "edit", run: "execute" };
const kindOf = (tool: ToolName) => kinds[tool];
const call = (tool: string, id = "c1"): EffectRequest => ({ _tag: "RunTool", call: CallId.make(id), tool: ToolName.make(tool), input: receivedJson({}) });

/** What the policy does with a call to `tool` in `mode`: runs it, vetoes it, or asks. */
const verdict = (mode: PermissionMode, tool: string, facts: ReadonlyArray<Fact> = [], canAsk = true): string => {
  const step: PolicyStep<unknown> = permissions(mode, canAsk, kindOf, facts).start(call(tool));
  return step._tag === "Waiting" ? "asks" : step.verdict._tag === "Continue" ? "runs" : "vetoed";
};

test("each permission mode runs, asks about or vetoes a call by its tool's kind; a tool of unknown kind is asked about in default mode", () => {
  const modes: ReadonlyArray<PermissionMode> = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
  expect(modes.map((mode) => [mode, verdict(mode, "read_file"), verdict(mode, "write_file"), verdict(mode, "run")])).toEqual([
    ["default", "runs", "asks", "asks"],
    ["acceptEdits", "runs", "runs", "asks"],
    ["dontAsk", "runs", "vetoed", "vetoed"],
    ["bypassPermissions", "runs", "runs", "runs"],
  ]);
  // A tool of unknown kind is treated as `other`.
  expect(verdict("default", "unknown_tool")).toBe("asks");
});

test("a question offers four options; allow-once and allow-session let the call run, and reject-once, reject-session and an option not offered veto it", () => {
  const policy = permissions("default", true, kindOf, []);
  const asked = policy.start(call("write_file"));
  if (asked._tag !== "Waiting" || asked.asks === undefined) throw new Error("expected a question");
  const question = questionIn(asked.asks);
  expect(question?.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"]);
  const after = (option: string) => {
    const step = policy.receive(asked.state, { _tag: "Answered", answer: answerPicking(OptionId.make(option)) });
    return step._tag === "Decided" ? step.verdict._tag : step._tag;
  };
  expect([after("allow-once"), after("allow-session"), after("reject-once"), after("reject-session"), after("no-such-option")]).toEqual([
    "Continue",
    "Continue",
    "Veto",
    "Veto",
    "Veto",
  ]);
});

test("after allow-session for a tool, later calls to that tool run without a question in default and dontAsk modes; other tools are still asked about, and allow-once is not remembered", () => {
  const asked = permissions("default", true, kindOf, []).start(call("write_file"));
  if (asked._tag !== "Waiting" || asked.asks === undefined) throw new Error("expected a question");
  const session = open();
  observe(session, { _tag: "PermissionAsked", call: "c1", asks: asked.asks });
  observe(session, { _tag: "PermissionAnswered", call: "c1", answer: answerPicking(OptionId.make("allow-session")) });
  expect(verdict("default", "write_file", session.journal)).toBe("runs");
  expect(verdict("dontAsk", "write_file", session.journal)).toBe("runs");
  // Another tool is still asked about.
  expect(verdict("default", "run", session.journal)).toBe("asks");
  // Allowing once is not remembered.
  const once = open();
  observe(once, { _tag: "PermissionAsked", call: "c1", asks: asked.asks });
  observe(once, { _tag: "PermissionAnswered", call: "c1", answer: answerPicking(OptionId.make("allow-once")) });
  expect(verdict("default", "write_file", once.journal)).toBe("asks");
});

test("when no one can answer, a call to a tool that changes files is vetoed with a reason that names acceptEdits or bypassPermissions", () => {
  const step = permissions("default", false, kindOf, []).start(call("write_file"));
  expect(step._tag === "Decided" && step.verdict._tag === "Veto" && step.verdict.reason.body._tag === "Text" ? step.verdict.reason.body.text : "").toBe(
    "write_file needs permission, and no one is there to answer. --permission-mode acceptEdits or bypassPermissions lets it run.",
  );
  expect(verdict("acceptEdits", "write_file", [], false)).toBe("runs");
});

test("when no one can answer, a call to a tool that does not change files is vetoed with a reason that names only bypassPermissions", () => {
  const step = permissions("default", false, kindOf, []).start(call("run"));
  expect(step._tag === "Decided" && step.verdict._tag === "Veto" && step.verdict.reason.body._tag === "Text" ? step.verdict.reason.body.text : "").toBe(
    "run needs permission, and no one is there to answer. --permission-mode bypassPermissions lets it run.",
  );
  expect(verdict("acceptEdits", "run", [], false)).toBe("vetoed");
});

test("after reject-session for a tool, later calls to that tool are vetoed without a question in every mode; other tools are judged as before", () => {
  const asked = permissions("default", true, kindOf, []).start(call("write_file"));
  if (asked._tag !== "Waiting" || asked.asks === undefined) throw new Error("expected a question");
  const session = open();
  observe(session, { _tag: "PermissionAsked", call: "c1", asks: asked.asks });
  observe(session, { _tag: "PermissionAnswered", call: "c1", answer: answerPicking(OptionId.make("reject-session")) });
  const modes: ReadonlyArray<PermissionMode> = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
  expect(modes.map((mode) => verdict(mode, "write_file", session.journal))).toEqual(["vetoed", "vetoed", "vetoed", "vetoed"]);
  expect(verdict("default", "run", session.journal)).toBe("asks");
  expect(verdict("default", "read_file", session.journal)).toBe("runs");
});
