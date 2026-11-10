import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fromFile, Parser } from "@asyncapi/parser";
import { compile } from "json-schema-to-typescript";
import { parse } from "yaml";

import { assertRunnerGatewayTopology } from "./runner-asyncapi-topology.mjs";
import { renderRunnerGo, renderRunnerGoModule } from "./runner-go.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const schemaPath = path.join(
  repositoryRoot,
  "contracts/runner-gateway/envelope.schema.json",
);
const asyncApiPath = path.join(
  repositoryRoot,
  "contracts/runner-gateway/asyncapi.yaml",
);
const outputDirectory = resolveOutputDirectory(
  process.argv.slice(2),
  "--output",
);
const goOutputDirectory = resolveOutputDirectory(
  process.argv.slice(2),
  "--go-output",
);

const createValidatorSource = ({
  protocolVersion,
  maxBytes,
  maxDepth,
  maxArrayItems,
  maxObjectProperties,
  maxNodes,
}) => `/** Generated Runner Gateway validator. Do not edit. */
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { runnerGatewayEnvelopeSchema } from "./schema.js";
import type {
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  JsonValue,
  OpaqueObject,
  OperationResult,
  RunEvent,
  RunnerGatewayEnvelope,
} from "./types.js";

/** The only Runner Gateway protocol this release speaks. */
export const RUNNER_GATEWAY_PROTOCOL_VERSION = ${JSON.stringify(protocolVersion)} as const;

export const RUNNER_GATEWAY_FRAME_LIMITS = {
  maxBytes: ${maxBytes},
  maxDepth: ${maxDepth},
  maxArrayItems: ${maxArrayItems},
  maxObjectProperties: ${maxObjectProperties},
  maxNodes: ${maxNodes},
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema(runnerGatewayEnvelopeSchema);
const compileEnvelope = (definition: string) =>
  ajv.compile({
    $ref: runnerGatewayEnvelopeSchema.$id + "#/$defs/" + definition,
  });
const validateEnvelope = ajv.getSchema(runnerGatewayEnvelopeSchema.$id);
if (!validateEnvelope) {
  throw new Error("Runner Gateway root validator is unavailable");
}
const validateAgentToDaemon = compileEnvelope("AgentToDaemonEnvelope");
const validateDaemonToAgent = compileEnvelope("DaemonToAgentEnvelope");
const validateJsonValue = compileEnvelope("JsonValue");
const validateOpaqueObject = compileEnvelope("OpaqueObject");
const validateOperationResult = compileEnvelope("OperationResult");
const validateRunEvent = compileEnvelope("RunEvent");

export class RunnerGatewayEnvelopeError extends Error {
  readonly details: string;

  constructor(details: string) {
    super(\`Invalid Runner Gateway envelope: \${details}\`);
    this.name = "RunnerGatewayEnvelopeError";
    this.details = details;
  }
}

export const parseRunnerGatewayEnvelope = (
  value: unknown,
): RunnerGatewayEnvelope => {
  return parseEnvelope(value, validateEnvelope, "RunnerGatewayEnvelope");
};

export const parseAgentToDaemonEnvelope = (
  value: unknown,
): AgentToDaemonEnvelope =>
  parseEnvelope(value, validateAgentToDaemon, "AgentToDaemonEnvelope");

export const parseDaemonToAgentEnvelope = (
  value: unknown,
): DaemonToAgentEnvelope =>
  parseEnvelope(value, validateDaemonToAgent, "DaemonToAgentEnvelope");

export const parseRunnerGatewayJsonValue = (value: unknown): JsonValue =>
  parseEnvelope(value, validateJsonValue, "JsonValue");

export const parseRunnerGatewayOpaqueObject = (
  value: unknown,
): OpaqueObject => parseEnvelope(value, validateOpaqueObject, "OpaqueObject");

export const parseRunnerGatewayOperationResult = (
  value: unknown,
): OperationResult =>
  parseEnvelope(value, validateOperationResult, "OperationResult");

export const parseRunnerGatewayRunEvent = (value: unknown): RunEvent =>
  parseEnvelope(value, validateRunEvent, "RunEvent");

const parseEnvelope = <T>(
  value: unknown,
  validate: ValidateFunction,
  name: string,
): T => {
  assertBoundedFrame(value, name);
  if (validate(value)) {
    assertSemanticInvariants(value, name);
    return value as T;
  }
  const details = ajv.errorsText(validate.errors, { separator: "; " });
  throw new RunnerGatewayEnvelopeError(name + ": " + details);
};

type FrameStackItem =
  | { kind: "enter"; value: unknown; depth: number }
  | { kind: "leave"; value: object };

const assertBoundedFrame = (value: unknown, name: string): void => {
  const ancestors = new WeakSet<object>();
  const stack: FrameStackItem[] = [{ kind: "enter", value, depth: 0 }];
  let nodeCount = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) {
      continue;
    }
    if (item.kind === "leave") {
      ancestors.delete(item.value);
      continue;
    }
    nodeCount += 1;
    if (nodeCount > RUNNER_GATEWAY_FRAME_LIMITS.maxNodes) {
      throw frameLimitError(name, "node count");
    }
    if (item.depth > RUNNER_GATEWAY_FRAME_LIMITS.maxDepth) {
      throw frameLimitError(name, "nesting depth");
    }
    if (typeof item.value !== "object" || item.value === null) {
      continue;
    }
    if (ancestors.has(item.value)) {
      throw frameLimitError(name, "cyclic object graph");
    }
    ancestors.add(item.value);
    stack.push({ kind: "leave", value: item.value });

    const children = Array.isArray(item.value)
      ? item.value
      : Object.values(item.value);
    const itemLimit = Array.isArray(item.value)
      ? RUNNER_GATEWAY_FRAME_LIMITS.maxArrayItems
      : RUNNER_GATEWAY_FRAME_LIMITS.maxObjectProperties;
    if (children.length > itemLimit) {
      throw frameLimitError(
        name,
        Array.isArray(item.value) ? "array length" : "object property count",
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: "enter",
        value: children[index],
        depth: item.depth + 1,
      });
    }
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw frameLimitError(name, "JSON serialization");
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      RUNNER_GATEWAY_FRAME_LIMITS.maxBytes
  ) {
    throw frameLimitError(name, "encoded byte length");
  }
};

const frameLimitError = (
  name: string,
  limit: string,
): RunnerGatewayEnvelopeError =>
  new RunnerGatewayEnvelopeError(name + ": frame exceeds " + limit + " limit");

const assertSemanticInvariants = (value: unknown, name: string): void => {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return;
  }
  if (value.type === "runner.hello" && "active_operations" in value) {
    if ("runtime_registrations" in value) {
      const registrations = value.runtime_registrations as Array<{
        tenant_id: string;
        owner_actor_id: string;
        provider_type: string;
      }>;
      const keys = registrations.map(
        (registration) =>
          registration.tenant_id +
          "\u0000" +
          registration.owner_actor_id +
          "\u0000" +
          registration.provider_type,
      );
      if (new Set(keys).size !== keys.length) {
        throw new RunnerGatewayEnvelopeError(
          name + ": runtime registration observations contain duplicate identity",
        );
      }
    }
    const activeOperations = value.active_operations as Array<{
      runner_id: string;
      last_acked_seq: number;
      last_emitted_seq: number;
    }>;
    if (
      activeOperations.some(
        ({ last_acked_seq: acked, last_emitted_seq: emitted }) =>
          acked > emitted,
      )
    ) {
      throw new RunnerGatewayEnvelopeError(
        name + ": last_acked_seq exceeds last_emitted_seq",
      );
    }
    if (
      "runner_id" in value &&
      activeOperations.some(
        ({ runner_id: activeRunnerId }) => activeRunnerId !== value.runner_id,
      )
    ) {
      throw new RunnerGatewayEnvelopeError(
        name + ": active operation runner_id does not match runner.hello",
      );
    }
    if ("agent_runners" in value) {
      const agentRunners = value.agent_runners as Array<{
        runner_id: string;
        tenant_id: string;
        agent_id: string;
      }>;
      if (
        "runner_id" in value &&
        agentRunners.some(
          ({ runner_id: agentRunnerId }) => agentRunnerId !== value.runner_id,
        )
      ) {
        throw new RunnerGatewayEnvelopeError(
          name + ": Agent Runner snapshot runner_id does not match runner.hello",
        );
      }
      const keys = agentRunners.map(
        ({ tenant_id: tenantId, agent_id: agentId }) => tenantId + "\u0000" + agentId,
      );
      if (new Set(keys).size !== keys.length) {
        throw new RunnerGatewayEnvelopeError(
          name + ": Agent Runner snapshot contains duplicate tenant and agent identity",
        );
      }
    }
  }
  if (
    value.type === "operation.start" &&
    "runtime_type" in value &&
    "request" in value
  ) {
    const request = value.request as {
      kind: string;
      runtime: { type: unknown };
      run_context?: unknown;
    };
    if (value.runtime_type !== request.runtime.type) {
      throw new RunnerGatewayEnvelopeError(
        name + ": runtime_type does not match request.runtime.type",
      );
    }
  }
};
`;

const schemaSource = await readFile(schemaPath, "utf8");
const schema = JSON.parse(schemaSource);
const asyncApi = parse(await readFile(asyncApiPath, "utf8"));
await validateAsyncApi(asyncApi);
const validatorSource = createValidatorSource({
  ...requireFrameLimits(asyncApi),
  protocolVersion: schema.$defs.ProtocolVersion.const,
});

await mkdir(outputDirectory, { recursive: true });
const types = (
  await compile(schema, "RunnerGatewayEnvelope", {
    bannerComment:
      "/** Generated from contracts/runner-gateway/envelope.schema.json. Do not edit. */",
    additionalProperties: false,
    unknownAny: false,
    unreachableDefinitions: true,
    style: { semi: true, singleQuote: false, tabWidth: 2, useTabs: false },
  })
).replace(/\[k: string\]: any;/g, "[k: string]: unknown;");
await writeFile(path.join(outputDirectory, "types.ts"), types, "utf8");
await writeFile(
  path.join(outputDirectory, "schema.ts"),
  `/** Generated Runner Gateway JSON Schema. Do not edit. */\nexport const runnerGatewayEnvelopeSchema = ${JSON.stringify(schema, null, 2)} as const;\n`,
  "utf8",
);
await writeFile(
  path.join(outputDirectory, "validator.ts"),
  validatorSource,
  "utf8",
);
await mkdir(goOutputDirectory, { recursive: true });
await writeFile(
  path.join(goOutputDirectory, "go.mod"),
  renderRunnerGoModule(),
  "utf8",
);
await writeFile(
  path.join(goOutputDirectory, "wire.gen.go"),
  renderRunnerGo(schema),
  "utf8",
);

function resolveOutputDirectory(args, flag) {
  const outputIndex = args.indexOf(flag);
  if (outputIndex === -1 || !args[outputIndex + 1]) {
    throw new Error(
      "Usage: generate-runner-contract.mjs --output <directory> --go-output <directory>",
    );
  }
  return path.resolve(repositoryRoot, args[outputIndex + 1]);
}

async function validateAsyncApi(asyncApi) {
  const parser = new Parser();
  const { document, diagnostics } = await fromFile(
    parser,
    asyncApiPath,
  ).parse();
  if (!document) {
    const details = diagnostics
      .map(({ message, path }) => `${path.join(".")}: ${message}`)
      .join("; ");
    throw new Error(`Invalid Runner Gateway AsyncAPI: ${details}`);
  }
  const production = asyncApi?.servers?.production;
  const runnerBearer = asyncApi?.components?.securitySchemes?.runnerBearer;
  if (
    asyncApi?.asyncapi !== "3.0.0" ||
    !Array.isArray(production?.security) ||
    production.security[0]?.$ref !==
      "#/components/securitySchemes/runnerBearer" ||
    runnerBearer?.type !== "http" ||
    runnerBearer?.scheme !== "bearer"
  ) {
    throw new Error(
      "Runner Gateway AsyncAPI must use v3 and apply HTTP Bearer runner security",
    );
  }
  assertRunnerGatewayTopology(asyncApi);
}

function requireFrameLimits(asyncApi) {
  const limits = asyncApi?.["x-frame-limits"];
  const keys = [
    "maxBytes",
    "maxDepth",
    "maxArrayItems",
    "maxObjectProperties",
    "maxNodes",
  ];
  if (
    typeof limits !== "object" ||
    limits === null ||
    Object.keys(limits).length !== keys.length ||
    keys.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)
  ) {
    throw new Error(
      "Runner Gateway AsyncAPI must define positive frame limits",
    );
  }
  return limits;
}
