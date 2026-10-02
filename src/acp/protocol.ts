/**
 * ACP's protocol versions, modelled on Effect's `McpProtocol`: one `ProtocolAdapter` per version,
 * holding that version's method groups, how it writes and reads `initialize`, and its capability
 * gates.
 *
 * A gate says, for a method and its params under the profile both ends negotiated, whether the
 * method may be sent. A refusal names the capability the method or its params need, as the path of
 * that capability in the `initialize` message that advertises it (`agentCapabilities.loadSession` in
 * version 1, `capabilities.session.delete` in version 2), and says whether the method itself needs
 * it (`needs: "method"`, answered -32601) or only these params do (`needs: "params"`, -32602).
 *
 * A capability counts as advertised when it is present and neither `null` nor `false`: version 1's
 * booleans must be `true`, and object capabilities must be objects (`{}` advertises). The client's
 * `elicitation: {}` advertises no mode: only a non-null `form` or `url` does.
 */

import { Data, Predicate, Schema } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { ErrorCode, type JsonRpcError } from "./json-rpc.ts";
import * as V1 from "./schema/v1.gen.ts";
import * as V1Rpcs from "./schema/v1.rpcs.gen.ts";
import * as V2 from "./schema/v2.gen.ts";
import * as V2Rpcs from "./schema/v2.rpcs.gen.ts";

/** The protocol versions built here. */
export type ProtocolVersion = 1 | 2;

/** The types one protocol version names. */
export interface Version {
  readonly protocolVersion: ProtocolVersion;
  readonly agentRequests: Rpc.Any;
  readonly agentNotifications: Rpc.Any;
  readonly clientRequests: Rpc.Any;
  readonly clientNotifications: Rpc.Any;
  readonly agentCapabilities: object;
  readonly clientCapabilities: object;
  readonly authMethod: unknown;
  readonly implementation: object;
  readonly initializeRequest: object;
  readonly initializeResponse: object;
}

export interface V1Version {
  readonly protocolVersion: 1;
  readonly agentRequests: RpcGroup.Rpcs<typeof V1Rpcs.AgentRequests>;
  readonly agentNotifications: RpcGroup.Rpcs<typeof V1Rpcs.AgentNotifications>;
  readonly clientRequests: RpcGroup.Rpcs<typeof V1Rpcs.ClientRequests>;
  readonly clientNotifications: RpcGroup.Rpcs<typeof V1Rpcs.ClientNotifications>;
  readonly agentCapabilities: V1.AgentCapabilities;
  readonly clientCapabilities: V1.ClientCapabilities;
  readonly authMethod: V1.AuthMethod;
  readonly implementation: V1.Implementation;
  readonly initializeRequest: V1.InitializeRequest;
  readonly initializeResponse: V1.InitializeResponse;
}

export interface V2Version {
  readonly protocolVersion: 2;
  readonly agentRequests: RpcGroup.Rpcs<typeof V2Rpcs.AgentRequests>;
  readonly agentNotifications: RpcGroup.Rpcs<typeof V2Rpcs.AgentNotifications>;
  readonly clientRequests: RpcGroup.Rpcs<typeof V2Rpcs.ClientRequests>;
  readonly clientNotifications: RpcGroup.Rpcs<typeof V2Rpcs.ClientNotifications>;
  readonly agentCapabilities: V2.AgentCapabilities;
  readonly clientCapabilities: V2.ClientCapabilities;
  readonly authMethod: V2.AuthMethod;
  readonly implementation: V2.Implementation;
  readonly initializeRequest: V2.InitializeRequest;
  readonly initializeResponse: V2.InitializeResponse;
}

/** What both ends said of themselves at `initialize`, in the negotiated version's types. */
export interface Profile<V extends Version> {
  readonly protocolVersion: V["protocolVersion"];
  readonly client: {
    readonly capabilities: V["clientCapabilities"];
    readonly info: V["implementation"] | undefined;
  };
  readonly agent: {
    readonly capabilities: V["agentCapabilities"];
    readonly info: V["implementation"] | undefined;
    readonly authMethods: ReadonlyArray<V["authMethod"]>;
  };
}

/** Which way a method goes: `toAgent` for what the client sends and the agent serves, `toClient` the reverse. */
export type Direction = "toAgent" | "toClient";

export type Gate =
  | { readonly _tag: "Allowed" }
  | {
      readonly _tag: "Refused";
      /** The capability, as its path in the `initialize` message that would advertise it. */
      readonly capability: string;
      /** Whether the method itself needs the capability, or only these params do. */
      readonly needs: "method" | "params";
      readonly message: string;
    };

export type Refused = Extract<Gate, { readonly _tag: "Refused" }>;

export interface ProtocolAdapter<V extends Version> {
  readonly protocolVersion: V["protocolVersion"];
  /**
   * `stable` for a released protocol version, `experimental` for a draft. The SDK's main entry is
   * version 1 only, and its draft of version 2 is under `experimental/v2`.
   */
  readonly stability: "stable" | "experimental";
  /** The requests the agent serves, `initialize` included. */
  readonly agentRequests: RpcGroup.RpcGroup<V["agentRequests"]>;
  readonly agentNotifications: RpcGroup.RpcGroup<V["agentNotifications"]>;
  readonly clientRequests: RpcGroup.RpcGroup<V["clientRequests"]>;
  readonly clientNotifications: RpcGroup.RpcGroup<V["clientNotifications"]>;
  /** The methods whose definitions are marked **UNSTABLE**. */
  readonly unstable: ReadonlySet<string>;
  /** `initialize`'s params and result, between their JSON and this version's types. */
  readonly initializeCodec: {
    readonly request: Schema.Codec<V["initializeRequest"], unknown>;
    readonly response: Schema.Codec<V["initializeResponse"], unknown>;
  };
  /** `initialize`'s params as a client of this version sends them. */
  readonly initializeRequest: (client: {
    readonly capabilities: V["clientCapabilities"];
    readonly info: V["implementation"];
  }) => V["initializeRequest"];
  /** `initialize`'s result as an agent of this version answers it. */
  readonly initializeResponse: (agent: {
    readonly capabilities: V["agentCapabilities"];
    readonly info: V["implementation"];
    readonly authMethods: ReadonlyArray<V["authMethod"]>;
  }) => V["initializeResponse"];
  /**
   * The auth methods an agent answers the client that sent `request` with: `authMethods` without
   * those of type `terminal`, unless the client advertised terminal auth.
   */
  readonly offeredAuthMethods: (
    request: V["initializeRequest"],
    authMethods: ReadonlyArray<V["authMethod"]>,
  ) => ReadonlyArray<V["authMethod"]>;
  /** The profile an `initialize` request and its result negotiated. */
  readonly profile: (request: V["initializeRequest"], response: V["initializeResponse"]) => Profile<V>;
  /** The gate on the method alone, whatever its params. */
  readonly methodGate: (direction: Direction, method: string, profile: Profile<V>) => Gate;
  /** The gate on the method and its params (decoded, or as the caller passes them). */
  readonly gate: (direction: Direction, method: string, params: unknown, profile: Profile<V>) => Gate;
}

// oxlint-disable-next-line typescript/no-explicit-any -- any version's adapter, as a list of them holds it
export type AnyAdapter = ProtocolAdapter<any>;

/**
 * The version an agent answers: `offered` when it is in `supported`, otherwise the highest in
 * `supported`. ACP's rule: the answer is always a version, never an error; a client that cannot
 * speak it closes the connection.
 */
export const select = (supported: readonly [number, ...Array<number>], offered: number): number =>
  supported.includes(offered) ? offered : Math.max(...supported);

/**
 * The `protocolVersion` of an `initialize` request's params or of its result, read the same way in
 * every version (an integer from 0 to 65535), or undefined when there is none.
 */
export const readProtocolVersion = (value: unknown): number | undefined => {
  const version = Predicate.isObject(value) ? value["protocolVersion"] : undefined;
  return typeof version === "number" && Number.isInteger(version) && version >= 0 && version <= 65535
    ? version
    : undefined;
};

/** A method the other end has not advertised it can take, refused before anything was sent. */
export class CapabilityNotAdvertised extends Data.TaggedError("CapabilityNotAdvertised")<{
  readonly method: string;
  readonly capability: string;
  readonly message: string;
}> {}

/** The JSON-RPC error a refusal answers an incoming request with: -32601 or -32602, naming the capability. */
export const refusalError = (refused: Refused): JsonRpcError => ({
  code: refused.needs === "method" ? ErrorCode.MethodNotFound : ErrorCode.InvalidParams,
  message: refused.message,
  data: { capability: refused.capability },
});

/** ACP reserves method names that start with `_` for extensions. No gate stands in front of them. */
export const isExtensionMethod = (method: string): boolean => method.startsWith("_");

const allowed: Gate = { _tag: "Allowed" };

/** The value at `path` under `value`, or undefined where the path leaves objects. */
const at = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((current, key) => (Predicate.isObject(current) ? current[key] : undefined), value);

const listAt = (value: unknown, key: string): ReadonlyArray<unknown> => {
  const list = at(value, [key]);
  return Array.isArray(list) ? list : [];
};

const typeOf = (value: unknown, key = "type"): unknown => at(value, [key]);

/** A capability is advertised when it is present and neither `null` nor `false`. */
const isAdvertised = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

/** Refuses unless the capability at `path` under `root` (named `rootName`) is advertised. */
const need = (
  root: unknown,
  rootName: string,
  path: ReadonlyArray<string>,
  needs: "method" | "params",
  why: string,
): Gate => {
  if (isAdvertised(at(root, path))) return allowed;
  const capability = [rootName, ...path].join(".");
  return { _tag: "Refused", capability, needs, message: `${why} needs ${capability}, which was not advertised` };
};

/** The first refusal, or allowed. */
const first = (gates: Iterable<() => Gate>): Gate => {
  for (const gate of gates) {
    const result = gate();
    if (result._tag === "Refused") return result;
  }
  return allowed;
};

/** `authMethods` without those of type `terminal`, unless the client advertised terminal auth at `path` under `request`. */
const offeredAuthMethods = <A>(request: unknown, path: ReadonlyArray<string>, authMethods: ReadonlyArray<A>): ReadonlyArray<A> =>
  isAdvertised(at(request, path))
    ? authMethods
    : authMethods.filter((authMethod) => typeOf(authMethod) !== "terminal");

/** `methodId` must be an advertised method that is not of type `terminal`, which the client runs itself. */
const authMethodGate = (method: string, params: unknown, authMethods: ReadonlyArray<unknown>, idKey: string): Gate => {
  const methodId = at(params, ["methodId"]);
  const found = authMethods.find((advertisedMethod) => at(advertisedMethod, [idKey]) === methodId);
  if (found !== undefined && typeOf(found) !== "terminal") return allowed;
  return {
    _tag: "Refused",
    capability: "authMethods",
    needs: "params",
    message:
      found === undefined
        ? `${method} names the auth method ${JSON.stringify(methodId)}, which the agent did not advertise`
        : `${method} names the terminal auth method ${JSON.stringify(methodId)}, which the client runs itself`,
  };
};

/** Each prompt block of a type that needs a capability: `image`, `audio`, and `resource` (embedded context). */
const promptGate = (method: string, params: unknown, check: (capability: string, why: string) => Gate): Gate =>
  first(
    listAt(params, "prompt").map((block) => () => {
      const type = typeOf(block);
      if (type === "image") return check("image", `${method} with an image block`);
      if (type === "audio") return check("audio", `${method} with an audio block`);
      if (type === "resource") return check("embeddedContext", `${method} with an embedded resource block`);
      return allowed;
    }),
  );

/** `additionalDirectories` that is not empty, and each MCP server's transport. */
const sessionSetupGate = (
  method: string,
  params: unknown,
  additionalDirectories: (why: string) => Gate,
  mcpServer: (type: unknown, why: string) => Gate,
): Gate =>
  first([
    () =>
      listAt(params, "additionalDirectories").length > 0
        ? additionalDirectories(`${method} with additionalDirectories`)
        : allowed,
    ...listAt(params, "mcpServers").map(
      (server) => () => mcpServer(typeOf(server), `${method} with an MCP server of type ${JSON.stringify(typeOf(server))}`),
    ),
  ]);

/** `elicitation/create` in mode `form` or `url` needs that mode advertised; other modes are custom, and no capability names them. */
const elicitationGate = (method: string, params: unknown, check: (mode: string, why: string) => Gate): Gate => {
  const mode = at(params, ["mode"]);
  return mode === "form" || mode === "url" ? check(mode, `${method} in mode ${mode}`) : allowed;
};

const isUpdate = (params: unknown, ...kinds: ReadonlyArray<string>): boolean => {
  const kind = at(params, ["update", "sessionUpdate"]);
  return typeof kind === "string" && kinds.includes(kind);
};

const v1MethodGate = (direction: Direction, method: string, profile: Profile<V1Version>): Gate => {
  if (isExtensionMethod(method)) return allowed;
  const agent = (path: ReadonlyArray<string>) =>
    need(profile.agent.capabilities, "agentCapabilities", path, "method", method);
  const client = (path: ReadonlyArray<string>) =>
    need(profile.client.capabilities, "clientCapabilities", path, "method", method);
  if (direction === "toAgent") {
    const session = method.startsWith("session/") ? method.slice("session/".length) : undefined;
    if (method === "session/load") return agent(["loadSession"]);
    if (session === "resume" || session === "close" || session === "list" || session === "delete" || session === "fork")
      return agent(["sessionCapabilities", session]);
    if (method === "logout") return agent(["auth", "logout"]);
    if (method === "mcp/message") return agent(["mcpCapabilities", "acp"]);
    if (method.startsWith("providers/")) return agent(["providers"]);
    if (method.startsWith("nes/")) return agent(["nes"]);
    if (method.startsWith("document/")) return agent(["nes", "events", "document", method.slice("document/".length)]);
    return allowed;
  }
  if (method === "fs/read_text_file") return client(["fs", "readTextFile"]);
  if (method === "fs/write_text_file") return client(["fs", "writeTextFile"]);
  if (method.startsWith("terminal/")) return client(["terminal"]);
  if (method === "elicitation/complete") return client(["elicitation", "url"]);
  if (method.startsWith("mcp/")) return agent(["mcpCapabilities", "acp"]);
  return allowed;
};

const v1ParamsGate = (direction: Direction, method: string, params: unknown, profile: Profile<V1Version>): Gate => {
  const agent = (path: ReadonlyArray<string>, why: string) =>
    need(profile.agent.capabilities, "agentCapabilities", path, "params", why);
  const client = (path: ReadonlyArray<string>, why: string) =>
    need(profile.client.capabilities, "clientCapabilities", path, "params", why);
  if (direction === "toAgent") {
    switch (method) {
      case "authenticate":
        return authMethodGate(method, params, profile.agent.authMethods, "id");
      case "session/prompt":
        return promptGate(method, params, (capability, why) => agent(["promptCapabilities", capability], why));
      case "session/new":
      case "session/load":
      case "session/resume":
      case "session/fork":
        return sessionSetupGate(
          method,
          params,
          (why) => agent(["sessionCapabilities", "additionalDirectories"], why),
          (type, why) =>
            type === "http" || type === "sse" || type === "acp" ? agent(["mcpCapabilities", type], why) : allowed,
        );
      default:
        return allowed;
    }
  }
  if (method === "elicitation/create")
    return elicitationGate(method, params, (mode, why) => client(["elicitation", mode], why));
  if (method !== "session/update") return allowed;
  const why = `session/update of kind ${JSON.stringify(at(params, ["update", "sessionUpdate"]))}`;
  if (isUpdate(params, "plan_update", "plan_removed")) return client(["plan"], why);
  if (isUpdate(params, "notice")) return client(["session", "notices"], why);
  if (isUpdate(params, "compaction_update", "compaction_summary_chunk")) return client(["session", "compaction"], why);
  if (isUpdate(params, "config_option_update")) {
    const options = listAt(at(params, ["update"]), "configOptions");
    if (options.some((option) => typeOf(option) === "boolean"))
      return client(["session", "configOptions", "boolean"], `${why} with a boolean option`);
  }
  return allowed;
};

const v2MethodGate = (direction: Direction, method: string, profile: Profile<V2Version>): Gate => {
  if (isExtensionMethod(method)) return allowed;
  const agent = (path: ReadonlyArray<string>) => need(profile.agent.capabilities, "capabilities", path, "method", method);
  const client = (path: ReadonlyArray<string>) => need(profile.client.capabilities, "capabilities", path, "method", method);
  if (direction === "toAgent") {
    const session = method.startsWith("session/") ? method.slice("session/".length) : undefined;
    if (session !== undefined) {
      const surface = agent(["session"]);
      if (surface._tag === "Refused") return surface;
      return session === "delete" || session === "fork" ? agent(["session", session]) : allowed;
    }
    if (method === "auth/login" || method === "auth/logout")
      return profile.agent.authMethods.length > 0
        ? allowed
        : {
            _tag: "Refused",
            capability: "authMethods",
            needs: "method",
            message: `${method} needs authMethods, which the agent left empty`,
          };
    if (method === "mcp/message") return agent(["session", "mcp", "acp"]);
    if (method.startsWith("providers/")) return agent(["providers"]);
    if (method.startsWith("nes/")) return agent(["nes"]);
    if (method.startsWith("document/")) return agent(["nes", "events", "document", method.slice("document/".length)]);
    return allowed;
  }
  if (method === "elicitation/complete") return client(["elicitation", "url"]);
  if (method.startsWith("mcp/")) return agent(["session", "mcp", "acp"]);
  return allowed;
};

const v2ParamsGate = (direction: Direction, method: string, params: unknown, profile: Profile<V2Version>): Gate => {
  const agent = (path: ReadonlyArray<string>, why: string) =>
    need(profile.agent.capabilities, "capabilities", path, "params", why);
  const client = (path: ReadonlyArray<string>, why: string) =>
    need(profile.client.capabilities, "capabilities", path, "params", why);
  if (direction === "toClient")
    return method === "elicitation/create"
      ? elicitationGate(method, params, (mode, why) => client(["elicitation", mode], why))
      : allowed;
  switch (method) {
    case "auth/login":
      return authMethodGate(method, params, profile.agent.authMethods, "methodId");
    case "session/prompt":
      return promptGate(method, params, (capability, why) => agent(["session", "prompt", capability], why));
    case "session/new":
    case "session/resume":
    case "session/fork":
      return sessionSetupGate(
        method,
        params,
        (why) => agent(["session", "additionalDirectories"], why),
        (type, why) =>
          type === "http" || type === "stdio" || type === "acp" ? agent(["session", "mcp", type], why) : allowed,
      );
    default:
      return allowed;
  }
};

const gateWith =
  <V extends Version>(
    methodGate: (direction: Direction, method: string, profile: Profile<V>) => Gate,
    paramsGate: (direction: Direction, method: string, params: unknown, profile: Profile<V>) => Gate,
  ) =>
  (direction: Direction, method: string, params: unknown, profile: Profile<V>): Gate => {
    const gate = methodGate(direction, method, profile);
    return gate._tag === "Refused" ? gate : paramsGate(direction, method, params, profile);
  };

/**
 * ACP version 1, the stable protocol. `initialize` carries `clientCapabilities` and `clientInfo`,
 * and its result `agentCapabilities`, `agentInfo` and `authMethods`.
 */
export const v1: ProtocolAdapter<V1Version> = {
  protocolVersion: 1,
  stability: "stable",
  agentRequests: V1Rpcs.AgentRequests,
  agentNotifications: V1Rpcs.AgentNotifications,
  clientRequests: V1Rpcs.ClientRequests,
  clientNotifications: V1Rpcs.ClientNotifications,
  unstable: V1Rpcs.unstable,
  initializeCodec: {
    request: Schema.toCodecJson(V1.InitializeRequest),
    response: Schema.toCodecJson(V1.InitializeResponse),
  },
  initializeRequest: ({ capabilities, info }) => ({ protocolVersion: 1, clientCapabilities: capabilities, clientInfo: info }),
  initializeResponse: ({ capabilities, info, authMethods }) => ({
    protocolVersion: 1,
    agentCapabilities: capabilities,
    agentInfo: info,
    authMethods,
  }),
  offeredAuthMethods: (request, authMethods) =>
    offeredAuthMethods(request, ["clientCapabilities", "auth", "terminal"], authMethods),
  profile: (request, response) => ({
    protocolVersion: 1,
    client: { capabilities: request.clientCapabilities ?? {}, info: request.clientInfo ?? undefined },
    agent: {
      capabilities: response.agentCapabilities ?? {},
      info: response.agentInfo ?? undefined,
      authMethods: response.authMethods ?? [],
    },
  }),
  methodGate: v1MethodGate,
  gate: gateWith(v1MethodGate, v1ParamsGate),
};

/**
 * ACP version 2, the SDK's draft. `initialize` carries `capabilities` and `info` both ways, and its
 * result `authMethods`, which is left out when empty.
 */
export const v2: ProtocolAdapter<V2Version> = {
  protocolVersion: 2,
  stability: "experimental",
  agentRequests: V2Rpcs.AgentRequests,
  agentNotifications: V2Rpcs.AgentNotifications,
  clientRequests: V2Rpcs.ClientRequests,
  clientNotifications: V2Rpcs.ClientNotifications,
  unstable: V2Rpcs.unstable,
  initializeCodec: {
    request: Schema.toCodecJson(V2.InitializeRequest),
    response: Schema.toCodecJson(V2.InitializeResponse),
  },
  initializeRequest: ({ capabilities, info }) => ({ protocolVersion: 2, capabilities, info }),
  initializeResponse: ({ capabilities, info, authMethods }) => ({
    protocolVersion: 2,
    capabilities,
    info,
    ...(authMethods.length > 0 ? { authMethods } : {}),
  }),
  offeredAuthMethods: (request, authMethods) => offeredAuthMethods(request, ["capabilities", "auth", "terminal"], authMethods),
  profile: (request, response) => ({
    protocolVersion: 2,
    client: { capabilities: request.capabilities ?? {}, info: request.info },
    agent: { capabilities: response.capabilities ?? {}, info: response.info, authMethods: response.authMethods ?? [] },
  }),
  methodGate: v2MethodGate,
  gate: gateWith(v2MethodGate, v2ParamsGate),
};
