import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS } from "@agentclientprotocol/sdk";
import * as sdkV2 from "@agentclientprotocol/sdk/experimental/v2";
import { Schema } from "effect";
import { generate, installed } from "../../../scripts/acp-schema.ts";
import { test } from "../../../tests/support/test.ts";
import * as v1 from "./v1.rpcs.gen.ts";
import * as v2 from "./v2.rpcs.gen.ts";

const root = process.cwd();

const tags = (group: { readonly requests: ReadonlyMap<string, unknown> }): Array<string> => [...group.requests.keys()].sort();

const sorted = (methods: object): Array<string> => Object.values(methods).map(String).sort();

/** The methods of each kind and side, as the definitions name them: what each group must hold. */
function expected(document: unknown) {
  const Definitions = Schema.Struct({
    $defs: Schema.Record(Schema.String, Schema.Struct({ "x-method": Schema.optionalKey(Schema.String), "x-side": Schema.optionalKey(Schema.String) })),
  });
  const definitions = Object.entries(Schema.decodeUnknownSync(Definitions)(document).$defs);
  const methods = (side: string, suffix: string) =>
    [
      ...new Set(
        definitions.flatMap(([name, definition]) =>
          definition["x-method"] !== undefined && name.endsWith(suffix) && (definition["x-side"] === side || definition["x-side"] === "both") ? [definition["x-method"]] : [],
        ),
      ),
    ].sort();
  return {
    agentRequests: methods("agent", "Request"),
    agentNotifications: methods("agent", "Notification"),
    clientRequests: methods("client", "Request"),
    clientNotifications: methods("client", "Notification"),
  };
}

test("AS1: the generated files are what scripts/acp-schema.ts makes from the installed SDK's JSON Schemas", () => {
  const { sdkVersion, documents } = installed(root);
  const files = generate(sdkVersion, documents);
  expect(files.map((file) => file.path).sort()).toEqual([
    "src/acp/schema/v1.gen.ts",
    "src/acp/schema/v1.rpcs.gen.ts",
    "src/acp/schema/v2.gen.ts",
    "src/acp/schema/v2.rpcs.gen.ts",
  ]);
  for (const file of files) expect({ path: file.path, content: readFileSync(join(root, file.path), "utf8") }).toEqual(file);
});

test("AS2: v1's groups hold exactly the SDK's agent and client methods, each by its definitions' side and kind", () => {
  const { documents } = installed(root);
  const want = expected(documents.v1);
  expect(tags(v1.AgentRequests)).toEqual(want.agentRequests);
  expect(tags(v1.AgentNotifications)).toEqual(want.agentNotifications);
  expect(tags(v1.ClientRequests)).toEqual(want.clientRequests);
  expect(tags(v1.ClientNotifications)).toEqual(want.clientNotifications);
  expect([...new Set([...tags(v1.AgentRequests), ...tags(v1.AgentNotifications)])].sort()).toEqual(sorted(AGENT_METHODS));
  expect([...new Set([...tags(v1.ClientRequests), ...tags(v1.ClientNotifications)])].sort()).toEqual(sorted(CLIENT_METHODS));
  expect(tags(v1.AgentNotifications)).toContain("session/cancel");
  expect(tags(v1.ClientNotifications)).toContain("session/update");
  expect(tags(v1.AgentRequests)).toContain("mcp/message");
  expect(tags(v1.ClientRequests)).toContain("mcp/message");
});

test("AS2: v2's groups hold exactly the SDK's v2 agent and client methods, each by its definitions' side and kind", () => {
  const { documents } = installed(root);
  const want = expected(documents.v2);
  expect(tags(v2.AgentRequests)).toEqual(want.agentRequests);
  expect(tags(v2.AgentNotifications)).toEqual(want.agentNotifications);
  expect(tags(v2.ClientRequests)).toEqual(want.clientRequests);
  expect(tags(v2.ClientNotifications)).toEqual(want.clientNotifications);
  expect([...new Set([...tags(v2.AgentRequests), ...tags(v2.AgentNotifications)])].sort()).toEqual(sorted(sdkV2.AGENT_METHODS));
  expect([...new Set([...tags(v2.ClientRequests), ...tags(v2.ClientNotifications)])].sort()).toEqual(sorted(sdkV2.CLIENT_METHODS));
  expect(tags(v2.AgentRequests)).toContain("auth/login");
  expect(tags(v2.ClientRequests)).not.toContain("fs/read_text_file");
});

test("AS2: $/cancel_request is in no group of either version", () => {
  for (const group of [v1.AgentRequests, v1.AgentNotifications, v1.ClientRequests, v1.ClientNotifications, v2.AgentRequests, v2.AgentNotifications, v2.ClientRequests, v2.ClientNotifications])
    expect(tags(group)).not.toContain(PROTOCOL_METHODS.cancel_request);
});

test("AS2: `unstable` holds the methods whose definitions are marked **UNSTABLE**, and only those", () => {
  const { documents } = installed(root);
  for (const [document, unstable] of [
    [documents.v1, v1.unstable],
    [documents.v2, v2.unstable],
  ] as const) {
    const Definitions = Schema.Struct({
      $defs: Schema.Record(Schema.String, Schema.Struct({ "x-method": Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String) })),
    });
    const marked = Object.values(Schema.decodeUnknownSync(Definitions)(document).$defs).flatMap((definition) =>
      definition["x-method"] !== undefined && definition.description?.includes("**UNSTABLE**") === true ? [definition["x-method"]] : [],
    );
    expect([...unstable].sort()).toEqual([...new Set(marked)].sort());
  }
  expect(v1.unstable.has("session/fork")).toBe(true);
  expect(v1.unstable.has("session/prompt")).toBe(false);
});
