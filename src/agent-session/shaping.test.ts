/** What `shaping.ts` says of parts and files: how a file is pointed to, and what the log says of a part left out. */

import { expect } from "bun:test";
import { BlobId, MediaType } from "../agent-machine/received.ts";
import { ProviderName, ThinkingText, WindowId } from "../agent-machine/names.ts";
import { receivedJson } from "./received.ts";
import { test } from "../../tests/support/test.ts";
import type { ContextPart } from "./contracts.ts";
import { blobPointer, omittedPart } from "./shaping.ts";

const blob = (size: number) => ({ id: BlobId.make("abc"), mediaType: MediaType.make("image/png"), size });

test.each([
  [1023, "1023 B"],
  [1024, "1 KiB"],
  [1535, "1 KiB"],
  [1536, "2 KiB"],
  [1024 * 1024 - 1, "1024 KiB"],
  [1024 * 1024, "1.0 MiB"],
  [1.25 * 1024 * 1024, "1.3 MiB"],
])("a file of %d bytes is pointed to as %s", (size, said) => {
  expect(blobPointer(blob(size))).toBe(`[image/png, ${said}: blob://abc.png]`);
});

test("a part left out that holds no text is described by its JSON", () => {
  const part: ContextPart = { _tag: "File", blob: blob(10) };
  const text = JSON.stringify(part);
  expect(omittedPart(part, "not taken").supplied[0]?.details).toMatchObject({ part: "File", chars: text.length, start: text.slice(0, 120), reason: "not taken" });
});

test("a part of a provider's compaction left out is said to be from that compaction, by its window", () => {
  const part: ContextPart = {
    _tag: "Thinking",
    provider: ProviderName.make("anthropic"),
    from: { _tag: "Compaction", window: WindowId.make("window-1") },
    text: ThinkingText.make("Summed up."),
    received: receivedJson({ type: "compaction" }),
  };
  expect(omittedPart(part, "not taken").supplied[0]?.details).toMatchObject({ part: "Thinking", from: "anthropic compaction", window: "window-1" });
});
