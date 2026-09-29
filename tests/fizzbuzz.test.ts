import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { estimatedTokens } from "../src/agent-context/providers.ts";
import type { ContextMessage, ModelContext } from "../src/agent-effect/contracts.ts";
import { conversationOf } from "../src/agent-effect/conversation.ts";
import { FizzBuzzCompaction } from "../src/fizzbuzz/compaction.ts";
import { advanced, basic, countingUser, type Played, play } from "../src/fizzbuzz/scenario.ts";
import { FizzBuzzToolRunner } from "../src/fizzbuzz/tools.ts";
import { ToolName } from "../src/agent-core/names.ts";
import { ToolRunner } from "../src/agent-effect/contracts.ts";
import { asText, receivedJson } from "../src/agent-effect/received.ts";

/** One line per part: who sent it and what it was. */
const transcript = (messages: ReadonlyArray<ContextMessage>): ReadonlyArray<string> =>
  messages.flatMap((message) =>
    message.parts.map((part) => {
      switch (part._tag) {
        case "Text":
          return `${message.role}: ${part.text}`;
        case "ToolCall":
          return `${message.role}: ${part.tool}(${asText(part.input)})`;
        case "ToolResult":
          return `${message.role}: result ${part.outcome._tag === "Succeeded" ? asText(part.outcome.output) : part.outcome.reason._tag}`;
        default:
          return part satisfies never;
      }
    }),
  );

const tokens = (context: ModelContext) =>
  estimatedTokens({ system: context.system === undefined ? [] : [context.system], notices: [], tools: context.tools, messages: context.messages });

test("the user counts to 15; the model classifies each multiple of 3 or 5 and replies with the next number", async () => {
  const { facts, seen } = await Effect.runPromise(play(countingUser(8)));
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
  expect(ended).toEqual(Array.from({ length: 8 }, () => "Answered"));
});

const at = (time: string, effect: Effect.Effect<Played>) =>
  Effect.runPromise(
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
  const { seen } = await Effect.runPromise(play(countingUser(200)));
  const counts = seen.map((context) => context.messages.length);
  expect(counts.every((count, index) => index === 0 || count > (counts[index - 1] ?? 0))).toBe(true);
  const sizes = seen.map(tokens);
  const compacted = await at("2026-09-29T09:30:00.000Z", play(countingUser(200), { ...basic, conversation: FizzBuzzCompaction(20) }));
  const compactedSizes = compacted.seen.map(tokens);
  console.log(
    `FizzBuzz, 200 user messages: ${seen.length} requests, estimated tokens from ${sizes[0]} to ${sizes.at(-1)}; ` +
      `compacted past 20 messages: at most ${Math.max(...compactedSizes)}`,
  );
});

test("with report_error offered, the model reports a number out of sequence, a fraction and a word, then counts on", async () => {
  const { seen } = await Effect.runPromise(play(["1", "3", "7", "3.5", "banana", "5"], advanced));
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
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ToolRunner).run(ToolName.make("classify"), receivedJson({ label: "Fuzz" }));
    }).pipe(Effect.provide(FizzBuzzToolRunner)),
  );
  expect(outcome._tag === "Failed" && outcome.reason._tag).toBe("InputRejected");
  console.log(`classify({"label":"Fuzz"}) is rejected: ${outcome._tag === "Failed" && outcome.reason._tag === "InputRejected" ? outcome.reason.problem : ""}`);
});
