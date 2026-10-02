/**
 * Wires that carry newline-delimited JSON, ACP's stdio framing: one message per line, a batch as one
 * array on one line, never pretty-printed. Blank lines are skipped; a line that is not JSON arrives
 * as `Unparsable`. A line may arrive split across chunks, and one chunk may hold several lines.
 */

import { Effect, Stdio, Stream } from "effect";
import { type Wire, WireError, WireInput } from "./json-rpc.ts";

const encoder = new TextEncoder();

/** The messages in a stream of newline-delimited JSON. */
const messages = <E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<WireInput, E> =>
  bytes.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((text) => text.trim() !== ""),
    Stream.map((text) => {
      try {
        return WireInput.Json({ value: JSON.parse(text) });
      } catch {
        return WireInput.Unparsable({ text });
      }
    }),
  );

/**
 * The wire over this process's stdin and stdout, as an editor launches an ACP agent. `read` ends when
 * stdin closes. Only messages are written to stdout, but Effect's default logger writes there too:
 * a program on this wire sets `References.LogToStderr` (or logs elsewhere).
 */
export const fromStdio: Effect.Effect<Wire, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  return {
    read: messages(
      stdio.stdin.pipe(Stream.mapError((cause) => new WireError({ reason: "stdin could not be read", cause }))),
    ),
    write: (message) =>
      Stream.run(Stream.succeed(`${JSON.stringify(message)}\n`), stdio.stdout()).pipe(
        Effect.mapError((cause) => new WireError({ reason: "stdout could not be written", cause })),
      ),
  };
});

/**
 * The wire over a pair of byte streams: a child process's pipes, or `TransformStream`s in one process.
 * `read` ends when `readable` closes. The writer of `writable` is taken at the first write and kept.
 */
export const fromWebStreams = (readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>): Wire => {
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  return {
    read: messages(
      Stream.fromReadableStream({
        evaluate: () => readable,
        onError: (cause) => new WireError({ reason: "the stream could not be read", cause }),
      }),
    ),
    write: (message) =>
      Effect.tryPromise({
        try: () => {
          writer ??= writable.getWriter();
          return writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
        },
        catch: (cause) => new WireError({ reason: "the message could not be written", cause }),
      }),
  };
};
