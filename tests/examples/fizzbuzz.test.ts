import { expect } from "bun:test";
import { test } from "../support/test.ts";
import { Effect, Metric } from "effect";
import { TestClock } from "effect/testing";
import { Conversation } from "../../src/agent-context/assemble.ts";
import { estimatedTokens } from "../../src/agent-context/example-providers.ts";
import type { Fact } from "../../src/agent-machine/fact.ts";
import { CallId, ToolName } from "../../src/agent-machine/names.ts";
import { type ContextMessage, type ModelContext, ToolRunner } from "../../src/agent-session/contracts.ts";
import { conversationOf } from "../../src/agent-session/conversation.ts";
import { asText, receivedJson } from "../../src/agent-session/received.ts";
import { FizzBuzzCompaction } from "../../src/examples/fizzbuzz/compaction.ts";
import { advanced, basic, countingUser, play } from "../../src/examples/fizzbuzz/scenario.ts";
import { FizzBuzzToolRunner } from "../../src/examples/fizzbuzz/tools.ts";
import { CountedToolRunner } from "../../src/instrumentation/tool-metrics.ts";
import { toolStats } from "../../src/instrumentation/tool-stats.ts";
import { runTest } from "../support/run.ts";

/** One line per part: who sent it and what it was. */
const transcript = (messages: ReadonlyArray<ContextMessage>): ReadonlyArray<string> =>
  messages.flatMap((message) =>
    message.parts.map((part) => {
      switch (part._tag) {
        case "Text":
          return `${message.role}: ${part.text}`;
        case "Commentary":
          return `${message.role}: commentary ${part.text}`;
        case "ToolCall":
          return `${message.role}: ${part.tool}(${asText(part.input)})`;
        case "ToolResult":
          return `${message.role}: result ${part.outcome._tag === "Succeeded" ? asText(part.outcome.output) : part.outcome.reason._tag}`;
        case "Thinking":
          return `${message.role}: thinking ${part.text}`;
        case "Unrecognised":
          return `${message.role}: unrecognised ${asText(part.received)}`;
        case "File":
          return `${message.role}: file ${part.blob.id}`;
        default:
          return part satisfies never;
      }
    }),
  );

const tokens = (context: ModelContext) =>
  estimatedTokens({ system: context.system === undefined ? [] : [context.system], notices: [], tools: context.tools, messages: context.messages });

test("the user counts to 15; the model classifies each multiple of 3 or 5 and replies with the next number", async () => {
  const { facts, seen } = await runTest(play(countingUser(8)));
  const last = seen.at(-1);
  expect(last?.system).toContain("Number Classification Assistant");
  expect(last?.tools.map((tool) => tool.name as string)).toEqual(["classify"]);
  expect(transcript(last?.messages ?? [])).toEqual([
    "user: 1",
    "assistant: 2",
    "user: 3",
    'assistant: classify({"label":"Fizz"})',
    'user: result {"classified":"Fizz"}',
    "assistant: 4",
    "user: 5",
    'assistant: classify({"label":"Buzz"})',
    'user: result {"classified":"Buzz"}',
    "assistant: 6",
    "user: 7",
    "assistant: 8",
    "user: 9",
    'assistant: classify({"label":"Fizz"})',
    'user: result {"classified":"Fizz"}',
    "assistant: 10",
    "user: 11",
    "assistant: 12",
    "user: 13",
    "assistant: 14",
    "user: 15",
    'assistant: classify({"label":"FizzBuzz"})',
    'user: result {"classified":"FizzBuzz"}',
  ]);
  const ended = facts.flatMap((fact) =>
    fact._tag === "Decided" && fact.decision._tag === "TurnEnded" ? [fact.decision.ending._tag] : [],
  );
  expect(ended).toEqual(Array.from({ length: 8 }, () => "Completed"));
});

const at = <A>(time: string, effect: Effect.Effect<A>) =>
  runTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(time));
      return yield* effect;
    }).pipe(Effect.provide(TestClock.layer())),
  );

test("past 20 messages, the completed turns are sent as a summary, and the model still counts on", async () => {
  const { facts, seen } = await at("2026-09-29T09:30:00.000Z", play(countingUser(12), { ...basic, conversation: FizzBuzzCompaction(20) }));
  expect(transcript(seen.at(-1)?.messages ?? [])).toEqual([
    [
      "user: System Date: 2026-09-29T09:30:00.000Z",
      "**Conversation Summary (auto-generated)**",
      "This summary was generated from your conversation with the user.",
      "Continue the conversation, do not mention this summary to the user.",
      "",
      "The user and the assistant exchanged 22 messages.",
      "The assistant classified the following numbers as",
      '- "Fizz": 3, 9, 21',
      '- "Buzz": 5',
      '- "FizzBuzz": 15',
      "",
      "The last number you returned to the user was: 22",
    ].join("\n"),
    "user: 23",
  ]);
  const replies = transcript(conversationOf(facts)).filter((line) => /^assistant: \d+$/.test(line));
  expect(replies).toEqual(countingUser(12).map((n) => `assistant: ${Number(n) + 1}`));
});

test("the context the model is sent grows with every request", async () => {
  const { seen } = await runTest(play(countingUser(200)));
  const counts = seen.map((context) => context.messages.length);
  expect(counts.every((count, index) => index === 0 || count > (counts[index - 1] ?? 0))).toBe(true);
  const sizes = seen.map(tokens);
  const compacted = await at("2026-09-29T09:30:00.000Z", play(countingUser(200), { ...basic, conversation: FizzBuzzCompaction(20) }));
  const compactedSizes = compacted.seen.map(tokens);
  await runTest(
    Effect.logInfo("fizzbuzz.context.measured", {
      userMessages: 200,
      requests: seen.length,
      estimatedTokens: { first: sizes[0], last: sizes.at(-1) },
      compactedPast20Messages: { mostEstimatedTokens: Math.max(...compactedSizes) },
    }),
  );
});

test("with report_error offered, the model reports a number out of sequence, a fraction and a word, then counts on", async () => {
  const { seen } = await runTest(play(["1", "3", "7", "3.5", "banana", "5"], advanced));
  const last = seen.at(-1);
  expect(last?.tools.map((tool) => tool.name as string)).toEqual(["classify", "report_error"]);
  expect(transcript(last?.messages ?? [])).toEqual([
    "user: 1",
    "assistant: 2",
    "user: 3",
    'assistant: classify({"label":"Fizz"})',
    'user: result {"classified":"Fizz"}',
    "assistant: 4",
    "user: 7",
    'assistant: report_error({"error_code":"number_out_of_sequence","error_message":"Expected 5 after 4, got 7."})',
    'user: result {"reported":"number_out_of_sequence"}',
    "assistant: number_out_of_sequence",
    "user: 3.5",
    'assistant: report_error({"error_code":"irrational_number","error_message":"3.5 is not a whole number."})',
    'user: result {"reported":"irrational_number"}',
    "assistant: irrational_number",
    "user: banana",
    'assistant: report_error({"error_code":"irrational_user","error_message":"\\"banana\\" is not a number."})',
    'user: result {"reported":"irrational_user"}',
    "assistant: irrational_user",
    "user: 5",
    'assistant: classify({"label":"Buzz"})',
    'user: result {"classified":"Buzz"}',
  ]);
});

test("after compaction, the model finds the last number it returned in the summary and catches a skip", async () => {
  const { facts } = await at("2026-09-29T09:30:00.000Z", play(["1", "3", "5", "9"], { ...advanced, conversation: FizzBuzzCompaction(4) }));
  expect(transcript(conversationOf(facts)).slice(-4)).toEqual([
    "user: 9",
    'assistant: report_error({"error_code":"number_out_of_sequence","error_message":"Expected 7 after 6, got 9."})',
    'user: result {"reported":"number_out_of_sequence"}',
    "assistant: number_out_of_sequence",
  ]);
});

test("a tool call whose input does not fit its schema is rejected with the decoder's reason", async () => {
  const outcome = await runTest(
    Effect.gen(function* () {
      return yield* (yield* ToolRunner).run(ToolName.make("classify"), receivedJson({ label: "Fuzz" }), CallId.make("call-1"));
    }).pipe(Effect.provide(FizzBuzzToolRunner)),
  );
  expect(outcome as unknown).toEqual({
    _tag: "Failed",
    reason: { _tag: "InputRejected", problem: 'Expected "Fizz" | "Buzz" | "FizzBuzz"\n  at ["label"]' },
  });
});

const noneFailed = { Reported: 0, NotFound: 0, InputRejected: 0, Vetoed: 0, Indeterminate: 0, NotRun: 0 };

test("tool usage for the session is counted from its facts", async () => {
  const { facts } = await runTest(play(["1", "3", "7", "3.5", "banana", "5", "7", "9", "11", "13", "15"], advanced));
  expect(Object.fromEntries(toolStats(facts))).toEqual({
    classify: { calls: 4, succeeded: 4, failed: { ...noneFailed }, unfinished: 0 },
    report_error: { calls: 3, succeeded: 3, failed: { ...noneFailed }, unfinished: 0 },
  });
});

test("tool metrics, recorded live and attributed by session, agree with the counts from each session's facts", async () => {
  const counted = { ...advanced, tools: CountedToolRunner(FizzBuzzToolRunner) };
  const { alice, bob, snapshot } = await runTest(
    Effect.gen(function* () {
      const alice = yield* play(["1", "3", "7", "5"], { ...counted, session: "alice" });
      const bob = yield* play(countingUser(8), { ...counted, session: "bob" });
      return { alice, bob, snapshot: yield* Metric.snapshot };
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  );
  const live = (session: string) =>
    Object.fromEntries(
      snapshot.flatMap((metric) =>
        metric.id === "agent.tool.runs" && metric.attributes?.["session"] === session && metric.type === "Counter"
          ? [[`${metric.attributes["tool"]} ${metric.attributes["outcome"]}`, Number(metric.state.count)]]
          : [],
      ),
    );
  const fromFacts = (facts: ReadonlyArray<Fact>) =>
    Object.fromEntries([...toolStats(facts)].map(([tool, stats]) => [`${tool} Succeeded`, stats.succeeded]));
  expect(live("alice")).toEqual(fromFacts(alice.facts));
  expect(live("bob")).toEqual(fromFacts(bob.facts));
  expect(live("alice")).toEqual({ "classify Succeeded": 2, "report_error Succeeded": 1 });
  expect(live("bob")).toEqual({ "classify Succeeded": 4 });
});

test("the summary is dated with the last fact it summarises, so the same facts give the same summary later", async () => {
  const { facts } = await at("2026-09-29T09:30:00.000Z", play(countingUser(12), { ...basic, conversation: FizzBuzzCompaction(20) }));
  const view = (time: string) =>
    at(
      time,
      Effect.gen(function* () {
        return yield* (yield* Conversation).messages(facts);
      }).pipe(Effect.provide(FizzBuzzCompaction(20))),
    );
  const [then, later] = [await view("2026-09-29T09:30:00.000Z"), await view("2027-01-01T00:00:00.000Z")];
  expect(later).toEqual(then);
  expect(transcript(later)[0]).toStartWith("user: System Date: 2026-09-29T09:30:00.000Z");
});
