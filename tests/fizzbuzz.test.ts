import { expect, test } from "bun:test";
import { Effect } from "effect";
import { estimatedTokens } from "../src/agent-context/providers.ts";
import type { ContextMessage, ModelContext } from "../src/agent-effect/contracts.ts";
import { asText } from "../src/agent-effect/received.ts";
import { countingUser, play } from "../src/fizzbuzz/scenario.ts";

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

test("the context the model is sent grows with every request", async () => {
  const { seen } = await Effect.runPromise(play(countingUser(200)));
  const counts = seen.map((context) => context.messages.length);
  expect(counts.every((count, index) => index === 0 || count > (counts[index - 1] ?? 0))).toBe(true);
  const sizes = seen.map(tokens);
  console.log(`FizzBuzz, 200 user messages: ${seen.length} requests, estimated tokens from ${sizes[0]} to ${sizes.at(-1)}`);
});
