/** What a request carried (the model context, as JSON), recorded with the request. */

import { Schema } from "effect";
import type { Received } from "../agent-machine/received.ts";
import { ModelContext } from "./contracts.ts";
import { parseJson, receivedJson } from "./received.ts";

const codec = Schema.toCodecJson(ModelContext);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);

/** Encodes `context` as it is recorded with the request that carries it. */
export const sentAs = (context: ModelContext): Received => receivedJson(encode(context) as Schema.Json);

/** Decodes the context that a recorded request carried. A record that does not hold one is a defect. */
export const sentIn = (sent: Received): ModelContext => {
  const parsed = parseJson(sent);
  if ("reason" in parsed) throw new Error(`What a request carried cannot be read: ${parsed.reason}`);
  return decode(parsed.value);
};
