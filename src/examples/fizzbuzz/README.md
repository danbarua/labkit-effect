# FizzBuzz

An example, not part of the harness. It is a whole session small enough to read: a user counts, a
scripted model replies with the next number and calls a tool for each multiple of 3 or 5. It runs
through the real loop, context assembly and tool runner, so tests can show a capability working end
to end (tool calls, a rejected tool input, tool statistics, a toy compaction) without a provider.

`scenario.ts` plays it; `model.ts` is the scripted model; `tools.ts` and `prompt.ts` are its tools
and system prompt; `compaction.ts` is a toy view that sends completed turns as one summary.
`tests/examples/fizzbuzz.test.ts` runs it.
