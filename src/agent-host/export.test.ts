/** A session's transcript as Markdown, read from its facts alone. */

import { expect } from "bun:test";
import { Schema } from "effect";
import { boringOpening } from "../../tests/support/boring.ts";
import { type DrivenMachines, observe, open } from "../../tests/support/drive.ts";
import { json } from "../../tests/support/received.ts";
import { test } from "../../tests/support/test.ts";
import { Fact } from "../agent-machine/fact.ts";
import { answerPicking, OptionId } from "../agent-policy/permissions.ts";
import { markdownOf } from "./export.ts";

/** The lines of a transcript, as `markdownOf` ends it. */
const lines = (...each: ReadonlyArray<string>) => `${each.join("\n")}\n`;

const asked = (text: string, attachments?: ReadonlyArray<unknown>) => ({
  _tag: "InputArrived",
  from: { _tag: "User" },
  text,
  ...(attachments === undefined ? {} : { attachments }),
});
const responded = (turn: string, parts: ReadonlyArray<unknown>, more: object = {}) => ({
  _tag: "ModelResponded",
  turn,
  provider: "boring",
  model: "boring-1",
  parts,
  ending: { _tag: "Complete" },
  metadata: json({}),
  ...more,
});
const plain = (text: string) => ({ mediaType: "text/plain", body: { _tag: "Text", text } });
const call = (id: string, tool: string, input: unknown) => ({ _tag: "ToolCall", call: id, tool, input: json(input) });
const succeeded = (id: string, output: unknown) => ({ _tag: "ToolEnded", call: id, outcome: { _tag: "Succeeded", output } });
/** What the permission policy asks before `rm` runs (`questionIn` reads it). */
const question = json({
  tool: "rm",
  kind: "delete",
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
});

const opened = () => {
  const session = open();
  observe(session, boringOpening());
  return session;
};

/** The output of a call to `cat` with `output`, in a session's one turn, as the transcript shows it. */
const shownOutput = (output: unknown): string => {
  const session = opened();
  observe(session, asked("Show it."));
  observe(session, responded("turn-1", [call("c1", "cat", { path: "big.txt" })]));
  observe(session, succeeded("c1", output));
  observe(session, responded("turn-1", [{ _tag: "Text", text: "Shown." }]));
  const transcript = markdownOf(session.journal);
  const start = transcript.indexOf("Output:\n\n") + "Output:\n\n".length;
  return transcript.slice(start, transcript.indexOf("\n\n### Assistant", start));
};

/** The totals that end `session`'s transcript. */
const totals = (session: DrivenMachines) => {
  const transcript = markdownOf(session.journal);
  return transcript.slice(transcript.indexOf("## Totals"));
};

test("a recorded session: each turn's input, thinking, answer, calls with their outcomes and permission, how it ended; then the totals", () => {
  const session = opened();
  observe(session, asked("Tidy the folder.", [{ id: "ab12", mediaType: "image/png", size: 2048, name: "plan.png" }]));
  observe(
    session,
    responded(
      "turn-1",
      [
        { _tag: "Thinking", text: "I should look first.", received: json({}) },
        { _tag: "Text", text: "Let me look." },
        call("c1", "ls", { path: "." }),
        call("c2", "rm", { path: "old.txt" }),
      ],
      { usage: { input: 100, output: 20, thinking: 5 } },
    ),
  );
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  observe(session, succeeded("c1", json(["a.ts", "old.txt"])));
  observe(session, { _tag: "PermissionAsked", call: "c2", asks: question });
  observe(session, { _tag: "PermissionAnswered", call: "c2", answer: answerPicking(OptionId.make("reject-once")) });
  observe(session, { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Failed", reason: { _tag: "Vetoed", reason: plain("The user rejected the call.") } } });
  observe(session, responded("turn-1", [{ _tag: "Text", text: "There is **a.ts**; I left `old.txt` alone." }], { usage: { input: 150, output: 12 } }));
  observe(session, asked("Count its lines."));
  observe(session, responded("turn-2", [call("c3", "wc", { path: "a.ts" })]));
  observe(session, { _tag: "ToolCallDispatched", call: "c3" });
  observe(session, { _tag: "TurnInterrupted", turn: "turn-2" });
  observe(session, { _tag: "ToolEnded", call: "c3", outcome: { _tag: "Failed", reason: { _tag: "Indeterminate" } } });
  expect(markdownOf(session.journal)).toBe(
    lines(
      "# Session `s1`",
      "",
      "Model: `boring/boring-1`",
      "",
      "## Turn 1",
      "",
      "### User",
      "",
      "Tidy the folder.",
      "",
      "- Attachment: [image/png, 2 KiB, plan.png: blob://ab12]",
      "",
      "### Assistant",
      "",
      "<details>",
      "<summary>Thinking</summary>",
      "",
      "I should look first.",
      "",
      "</details>",
      "",
      "Let me look.",
      "",
      "#### Tool call `ls` (`c1`)",
      "",
      "```json",
      '{"path":"."}',
      "```",
      "",
      "Output:",
      "",
      "```json",
      '["a.ts","old.txt"]',
      "```",
      "",
      "#### Tool call `rm` (`c2`)",
      "",
      "```json",
      '{"path":"old.txt"}',
      "```",
      "",
      "Permission asked (Allow once / Reject); answered: Reject.",
      "",
      "Vetoed: The user rejected the call.",
      "",
      "### Assistant",
      "",
      "There is **a.ts**; I left `old.txt` alone.",
      "",
      "## Turn 2",
      "",
      "### User",
      "",
      "Count its lines.",
      "",
      "### Assistant",
      "",
      "#### Tool call `wc` (`c3`)",
      "",
      "```json",
      '{"path":"a.ts"}',
      "```",
      "",
      "Indeterminate: the tool began to run and how it ended was not observed. It may have had effects.",
      "",
      "_The turn was interrupted._",
      "",
      "## Totals",
      "",
      "- Turns: 2",
      "- Model requests: 3",
      "- Tokens, as the providers reported them: 250 in, 32 out (5 of them thinking)",
      "- Cost: $0.0000 (US dollars, for the responses from a model with a known price)",
    ),
  );
});

test("a turn with no ending is left running: a call whose response was not recorded shows where it arrived, with no outcome", () => {
  const session = opened();
  observe(session, asked("List the files."));
  observe(session, { _tag: "ToolCallArrived", turn: "turn-1", call: "c1", tool: "ls", input: json({}) });
  observe(session, { _tag: "ToolCallDispatched", call: "c1" });
  const transcript = markdownOf(session.journal);
  expect(transcript.slice(transcript.indexOf("## Turn 1"), transcript.indexOf("## Totals"))).toBe(
    lines(
      "## Turn 1",
      "",
      "### User",
      "",
      "List the files.",
      "",
      "### Assistant",
      "",
      "#### Tool call `ls` (`c1`)",
      "",
      "```json",
      "{}",
      "```",
      "",
      "No outcome is recorded.",
      "",
      "_The turn was left running: no ending is recorded._",
      "",
    ),
  );
});

test("a tool's output is cut after 8 KiB, never inside a character, with the number of bytes omitted; stored bytes are named, not read", () => {
  const whole = "a".repeat(8 * 1024);
  expect(shownOutput(plain(whole))).toBe(lines("```", whole, "```").trimEnd());
  // "é" is two bytes, at 8191 and 8192: the cut falls inside it, so it goes before it.
  const over = `${"a".repeat(8191)}é${"b".repeat(100)}`;
  expect(shownOutput(plain(over))).toBe(lines("```", "a".repeat(8191), "```", "", "_Cut at 8 KiB: 102 bytes more were left out._").trimEnd());
  expect(shownOutput({ mediaType: "image/png", body: { _tag: "Stored", id: "cd34", size: 70_000 } })).toBe("[70000 bytes of image/png: blob://cd34]");
  // Output holding a fence is fenced with a longer one, so it cannot close the block early.
  expect(shownOutput(plain("```\nx\n```"))).toBe(lines("````", "```", "x", "```", "````").trimEnd());
});

test("a change of model: the heading names each model asked, the transcript where it was taken, and the totals price the responses and gauge the model asked now", () => {
  const session = opened();
  observe(session, asked("Hello."));
  observe(session, responded("turn-1", [{ _tag: "Text", text: "Hi." }], { usage: { input: 50, output: 5 } }));
  observe(session, { _tag: "ModelChangeArrived", provider: "anthropic", model: "claude-haiku-4-5" });
  observe(session, asked("Again."));
  observe(
    session,
    responded("turn-2", [{ _tag: "Text", text: "Hi again." }], {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: { input: 1000, output: 200, cacheRead: 400, cacheWrite: 100 },
    }),
  );
  const transcript = markdownOf(session.journal);
  expect(transcript.slice(0, transcript.indexOf("## Turn 1"))).toBe(lines("# Session `s1`", "", "Models: `boring/boring-1`, then `anthropic/claude-haiku-4-5`", ""));
  expect(transcript).toContain(lines("Hi.", "", "_From here the session asks `anthropic/claude-haiku-4-5`._", "", "## Turn 2"));
  // Only the priced response costs: 500 uncached at $1, 400 read at $0.10, 100 written at $1.25 and 200 out at $5, per million.
  expect(totals(session)).toBe(
    lines(
      "## Totals",
      "",
      "- Turns: 2",
      "- Model requests: 2",
      "- Tokens, as the providers reported them: 1050 in (400 read from the cache, 100 written to it), 205 out",
      "- Cost: $0.0017 (US dollars, for the responses from a model with a known price)",
      "- Context: 1200 of 200000 tokens of `anthropic/claude-haiku-4-5`",
    ),
  );
});

/** `entries`, each an observation or a decision, as facts in order: observations from a test, all at one time. */
const factsOf = (entries: ReadonlyArray<{ readonly observation: unknown } | { readonly decision: unknown }>): ReadonlyArray<Fact> =>
  entries.map((entry, at) =>
    Schema.decodeUnknownSync(Fact)(
      "observation" in entry
        ? { _tag: "Observed", seq: at + 1, time: "2026-10-04T12:00:00.000Z", origin: { _tag: "Test", name: "export" }, observation: entry.observation }
        : { _tag: "Decided", seq: at + 1, time: "2026-10-04T12:00:00.000Z", decision: entry.decision },
    ),
  );

test("the transcript names each input's speaker, each way a tool call failed, an unrecognised part, dropped input, and each way a turn ended without an answer", () => {
  const facts = factsOf([
    { observation: boringOpening() },
    { observation: { _tag: "InputArrived", from: { _tag: "System" }, text: "Check the files." } },
    { observation: { _tag: "TurnStarted", turn: "turn-1" } },
    { decision: { _tag: "InputDelivered", turn: "turn-1", inputs: [2] } },
    {
      observation: responded("turn-1", [
        { _tag: "Unrecognised", received: plain("a part of a kind not known") },
        call("c1", "gone", {}),
        call("c2", "cat", { path: 1 }),
        call("c3", "write", { path: "a" }),
        call("c4", "rm", { path: "b" }),
      ]),
    },
    { observation: { _tag: "ToolEnded", call: "c1", outcome: { _tag: "Failed", reason: { _tag: "NotFound" } } } },
    { observation: { _tag: "ToolEnded", call: "c2", outcome: { _tag: "Failed", reason: { _tag: "InputRejected", problem: "path is not a string" } } } },
    { observation: { _tag: "ToolEnded", call: "c3", outcome: { _tag: "Failed", reason: { _tag: "Reported", error: plain("disk full") } } } },
    { observation: { _tag: "ToolEnded", call: "c4", outcome: { _tag: "Failed", reason: { _tag: "NotRun" } } } },
    { decision: { _tag: "TurnEnded", turn: "turn-1", ending: { _tag: "Incomplete" } } },
    { observation: { _tag: "InputArrived", from: { _tag: "Agent", agent: "helper" }, text: "Summarise." } },
    { observation: { _tag: "TurnStarted", turn: "turn-2" } },
    { decision: { _tag: "InputDelivered", turn: "turn-2", inputs: [11] } },
    { observation: { _tag: "InputArrived", from: { _tag: "User" }, text: "Also count them." } },
    { decision: { _tag: "InputDropped", turn: "turn-2", inputs: [14] } },
    { decision: { _tag: "TurnEnded", turn: "turn-2", ending: { _tag: "CutShort" } } },
    { observation: { _tag: "TurnStarted", turn: "turn-3" } },
    { decision: { _tag: "TurnEnded", turn: "turn-3", ending: { _tag: "Failed", failure: "the provider refused the request" } } },
    { observation: { _tag: "TurnStarted", turn: "turn-4" } },
    { decision: { _tag: "TurnEnded", turn: "turn-4", ending: { _tag: "Vetoed", reason: plain("the budget is spent") } } },
  ]);
  const transcript = markdownOf(facts);
  expect(transcript.slice(transcript.indexOf("## Turn 1"), transcript.indexOf("## Totals"))).toMatchInlineSnapshot(`
    "## Turn 1

    ### System

    Check the files.

    ### Assistant

    _A part of the response was not recognised: a part of a kind not known_

    #### Tool call \`gone\` (\`c1\`)

    \`\`\`json
    {}
    \`\`\`

    Failed: no tool is named \`gone\`.

    #### Tool call \`cat\` (\`c2\`)

    \`\`\`json
    {"path":1}
    \`\`\`

    Failed: the tool rejected its input: path is not a string

    #### Tool call \`write\` (\`c3\`)

    \`\`\`json
    {"path":"a"}
    \`\`\`

    Failed; the tool reported:

    \`\`\`
    disk full
    \`\`\`

    #### Tool call \`rm\` (\`c4\`)

    \`\`\`json
    {"path":"b"}
    \`\`\`

    Not run.

    _The turn ended with no answer._

    ## Turn 2

    ### Agent \`helper\`

    Summarise.

    _Input given while the turn ran was dropped, as the turn did not end in an answer:_

    ### User

    Also count them.

    _The turn ended cut short: the model's response stopped at a limit._

    ## Turn 3

    _The turn failed: the provider refused the request_

    ## Turn 4

    _A request to the model was vetoed, and the turn ended: the budget is spent_

    "
  `);
});

