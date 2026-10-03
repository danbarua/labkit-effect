/** A plug-in an extension exports, for the configuration's tests: `denyTools`, on `toolCalls`, vetoing a call to any tool named in `tools`. */

import { Effect, Schema } from "effect";
import { plugin } from "../../src/agent-config/plugin.ts";
import { denyTools } from "../../src/examples/policies.ts";

export default plugin(
  "denyTools",
  Schema.Struct({ tools: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))) }),
  ["toolCalls"],
  ({ tools }) => ({ toolCalls: () => Effect.succeed(denyTools(tools)) }),
);
