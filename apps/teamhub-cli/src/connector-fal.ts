import {
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  validateSchema,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { array, id, object, rootSchema, str } from "./connector-schemas.js";
import {
  generationResume,
  savedFiles,
  saveRemoteFiles,
  type GenerationProvider,
} from "./connector-media.js";
import { ConnectorError } from "./errors.js";
import { readBounded } from "./http-client.js";

const anyObject = { type: "object", additionalProperties: true };
const falFile = object(
  { url: id, contentType: str, fileName: str, sizeBytes: { type: "integer" } },
  ["url"],
);
const requestOutput = rootSchema(
  {
    requestId: id,
    model: id,
    status: { enum: ["queued", "running", "completed", "failed"] },
    queuePosition: { type: "integer", minimum: 0 },
    error: str,
    outputs: array(falFile),
    result: anyObject,
    files: savedFiles,
    nextCommand: str,
    warning: str,
  },
  ["requestId", "model", "status"],
);

export const falGeneration: GenerationProvider = {
  outputSchema: requestOutput,
  bindings(input) {
    if (input.mode === "price")
      return [
        ...(input.model ? [] : ["FAL_AI_GET_MODELS"]),
        "FAL_AI_GET_PRICING",
      ];
    if (input.mode === "job")
      return ["FAL_AI_QUEUE_GET_STATUS", "FAL_AI_GET_QUEUE_REQUEST_RESULT"];
    return [
      ...(input.files ? ["FAL_AI_UPLOAD_FILE"] : []),
      "FAL_AI_SUBMIT_ASYNC_JOB",
    ];
  },
  bindingSchema(slug, schema) {
    if (slug !== "FAL_AI_SUBMIT_ASYNC_JOB") return schema;
    // The free-profile restriction does not apply to a user's own fal key.
    const { allOf: _freeProfile, ...rest } = schema;
    return rest;
  },
  execute: executeFal,
};

function outputType(entry: Json): string | undefined {
  const category = record(entry.metadata ?? {}).category;
  if (category === "text-to-image" || category === "image-to-image")
    return "image";
  if (
    category === "text-to-video" ||
    category === "image-to-video" ||
    category === "video-to-video"
  )
    return "video";
  return undefined;
}
function assertOutputType(entry: Json, type: unknown): void {
  if (outputType(entry) !== type)
    throw new ConnectorError(
      "invalid_input",
      "This model does not generate the requested media type; select one from --price.",
    );
}

async function prices(input: Json, runtime: ConnectorRuntime): Promise<Json> {
  let entries: Json[];
  let next: Json = { hasMore: false };
  if (input.model) {
    const entry = await modelEntry(runtime, input.model as string);
    assertOutputType(entry, input.type);
    entries = [entry];
  } else {
    const fp = {
      account: runtime.account.connection_id,
      type: input.type,
      limit: input.limit,
    };
    const categories =
      input.type === "image"
        ? ["text-to-image", "image-to-image"]
        : ["text-to-video", "image-to-video", "video-to-video"];
    const state = cursor(input.cursor, fp);
    const category = (state.category ?? 0) as number;
    if (
      !Number.isInteger(category) ||
      category < 0 ||
      category >= categories.length
    )
      throw new ConnectorError(
        "usage",
        "The price-list cursor has an invalid category.",
      );
    const raw = await runtime.call(
      "FAL_AI_GET_MODELS",
      optionalFields({
        limit: input.limit,
        category: categories[category],
        cursor: state.token,
        status: "active",
      }),
    );
    if (
      !Array.isArray(raw.models) ||
      typeof raw.has_more !== "boolean" ||
      (raw.has_more && typeof raw.next_cursor !== "string")
    )
      throw new ConnectorError(
        "incomplete_response",
        "The model list or its next-page cursor is incomplete.",
      );
    entries = raw.models
      .map((item) => record(item))
      .filter((entry) => outputType(entry) === input.type);
    const hasMore = raw.has_more || category + 1 < categories.length;
    next = {
      hasMore,
      ...(hasMore
        ? {
            nextCursor: nextCursor(
              raw.has_more
                ? { category, token: raw.next_cursor }
                : { category: category + 1 },
              fp,
            ),
          }
        : {}),
    };
  }
  const ids = entries.map((entry) =>
    requiredString(entry.endpoint_id, "model ID"),
  );
  const pricing = ids.length
    ? await runtime.call("FAL_AI_GET_PRICING", { endpoint_id: ids })
    : { prices: [] };
  if (!Array.isArray(pricing.prices))
    throw new ConnectorError(
      "incomplete_response",
      "The price list is incomplete.",
    );
  const rows = pricing.prices.map((item) => record(item));
  let missingPrice = false;
  const models = entries.map((entry) => {
    const model = entry.endpoint_id as string;
    const meta = record(entry.metadata ?? {});
    const price = rows.find((row) => row.endpoint_id === model);
    const known =
      price && typeof price.unit_price === "number" && price.unit_price >= 0;
    if (!known) missingPrice = true;
    const schemas = input.model ? openapiSchemas(entry.openapi) : undefined;
    return optionalFields({
      modelId: model,
      name: meta.display_name,
      description: meta.description,
      outputType: input.type,
      price: known
        ? optionalFields({
            unitPrice: price.unit_price,
            unit: price.unit,
            currency: price.currency,
          })
        : undefined,
      docsUrl: `https://fal.ai/models/${model}/api`,
      inputs: schemas ? fields(schemas.input, schemas.components) : undefined,
      outputs: schemas?.output
        ? fields(schemas.output, schemas.components)
        : undefined,
    });
  });
  return optionalFields({
    models,
    ...next,
    pricingStatus: missingPrice ? "partial" : "available",
    warning: missingPrice
      ? "A model has no published unit price; consult its provider page before generating."
      : undefined,
  });
}

async function executeFal(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (input.mode === "price") return prices(input, runtime);
  if (input.mode === "job")
    return checkRequest(runtime, input, (input.jobIds as string[])[0]!);
  const model = input.model as string;
  const type = input.type as string;
  const entry = await modelEntry(runtime, model);
  assertOutputType(entry, input.type);
  const schemas = openapiSchemas(entry.openapi);
  const body = { ...(input.parameters as Json) };
  const files = (input.files ?? []) as { field: string; path: string }[];
  const byField = new Map<string, string[]>();
  for (const item of files)
    byField.set(item.field, [...(byField.get(item.field) ?? []), item.path]);
  const placeholder = "https://v3.fal.media/files/input";
  if (schemas) {
    const properties = record(schemas.input.properties ?? {});
    for (const [name, paths] of byField) {
      const declared = resolveRef(properties[name], schemas.components);
      if (paths.length > 1 && declared.type !== "array")
        throw new ConnectorError(
          "invalid_input",
          `Only an array field takes several --file values; ${name} takes one.`,
        );
      body[name] =
        declared.type === "array" ? paths.map(() => placeholder) : placeholder;
    }
    for (const name of Object.keys(body))
      if (!Object.hasOwn(properties, name))
        throw new ConnectorError(
          "invalid_input",
          `This model has no input field ${name}; run teamhub ${type}-gen --provider fal --price --model ${model}.`,
        );
    const required = Array.isArray(schemas.input.required)
      ? (schemas.input.required as string[])
      : [];
    const missing = required.filter((name) => !Object.hasOwn(body, name));
    if (missing.length)
      throw new ConnectorError(
        "invalid_input",
        `This model requires ${missing.join(", ")}; run teamhub ${type}-gen --provider fal --price --model ${model}.`,
      );
    for (const [name, item] of Object.entries(body))
      if (!(await matchesSchema(record(properties[name]), schemas, item)))
        throw new ConnectorError(
          "invalid_input",
          `${name} does not accept this value; run teamhub ${type}-gen --provider fal --price --model ${model} for its type and allowed values.`,
        );
    if (!(await matchesSchema(schemas.input, schemas, body)))
      throw new ConnectorError(
        "invalid_input",
        `The input does not satisfy this model's schema; run teamhub ${type}-gen --provider fal --price --model ${model}.`,
      );
  } else
    for (const [name, paths] of byField)
      body[name] =
        paths.length > 1 ? paths.map(() => placeholder) : placeholder;
  for (const [name, paths] of byField) {
    const urls: string[] = [];
    for (const local of paths) {
      const file = runtime.files.find((item) => item.localPath === local);
      if (!file)
        throw new ConnectorError(
          "incomplete_response",
          "An input file snapshot is missing.",
        );
      const reference = await runtime.stageFile(file, "FAL_AI_UPLOAD_FILE");
      const uploaded = await runtime.call(
        "FAL_AI_UPLOAD_FILE",
        { file: reference },
        true,
      );
      urls.push(requiredString(uploaded.access_url, "uploaded file URL"));
    }
    body[name] = Array.isArray(body[name]) ? urls : urls[0];
  }
  const submitted = await runtime.call(
    "FAL_AI_SUBMIT_ASYNC_JOB",
    { model_id: model, input: body },
    true,
  );
  const request = requiredString(submitted.request_id, "request ID");
  const nextCommand = generationResume(input, runtime, [request]);
  // A later failure reports this receipt, so nobody pays for the request twice.
  runtime.noteReceipt({ requestId: request, model, nextCommand });
  // The request runs on fal's queue; the caller checks it later with --job.
  return optionalFields({
    requestId: request,
    model,
    status: queueStatus(submitted.status) ?? "queued",
    queuePosition:
      typeof submitted.queue_position === "number"
        ? submitted.queue_position
        : undefined,
    nextCommand,
    warning: schemas
      ? undefined
      : "fal returned no schema for this model, so fal checked the input itself when it received the request.",
  });
}

function queueApp(model: string): string {
  const parts = model.split("/");
  return parts
    .slice(0, ["workflows", "comfy"].includes(parts[0]!) ? 3 : 2)
    .join("/");
}
function queueStatus(value: unknown): string | undefined {
  const state = typeof value === "string" ? value.toUpperCase() : "";
  return state === "IN_QUEUE"
    ? "queued"
    : state === "IN_PROGRESS"
      ? "running"
      : state === "COMPLETED"
        ? "completed"
        : undefined;
}

/** Checks a request once and, when it has finished, reads and saves its result. */
async function checkRequest(
  runtime: ConnectorRuntime,
  input: Json,
  request: string,
): Promise<Json> {
  const model = input.model as string;
  const head = { requestId: request, model };
  const status = await runtime.call("FAL_AI_QUEUE_GET_STATUS", {
    model_id: queueApp(model),
    request_id: request,
  });
  const state = queueStatus(status.status);
  if (state === undefined)
    throw new ConnectorError(
      "incomplete_response",
      "fal returned an unknown request status.",
    );
  if (state !== "completed")
    return optionalFields({
      ...head,
      status: state,
      queuePosition:
        typeof status.queue_position === "number"
          ? status.queue_position
          : undefined,
      nextCommand: generationResume(input, runtime, [request]),
    });
  const result = await runtime.call("FAL_AI_GET_QUEUE_REQUEST_RESULT", {
    model_id: queueApp(model),
    request_id: request,
  });
  const outputs = falFiles(result);
  const error = result.error ?? result.detail;
  if (error !== undefined && !outputs.length)
    return {
      ...head,
      status: "failed",
      error: typeof error === "string" ? error : JSON.stringify(error),
    };
  const files = input.output
    ? await saveRemoteFiles(
        outputs.map((item, index) => ({
          url: item.url as string,
          label: `output-${index + 1}`,
          contentType: item.contentType as string | undefined,
        })),
        input.output as string,
        runtime.context,
      )
    : undefined;
  return optionalFields({
    ...head,
    status: "completed",
    outputs,
    result,
    files,
  });
}

/** fal File objects anywhere in a model output: a URL with file metadata. */
function falFiles(value: unknown, depth = 0, found: Json[] = []): Json[] {
  if (depth > 8 || !value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) falFiles(item, depth + 1, found);
    return found;
  }
  const item = value as Json;
  if (
    typeof item.url === "string" &&
    item.url.startsWith("https://") &&
    ["content_type", "file_name", "file_size", "width", "height"].some(
      (key) => item[key] !== undefined,
    )
  ) {
    if (!found.some((entry) => entry.url === item.url))
      found.push(
        optionalFields({
          url: item.url,
          contentType:
            typeof item.content_type === "string"
              ? item.content_type
              : undefined,
          fileName:
            typeof item.file_name === "string" ? item.file_name : undefined,
          sizeBytes: Number.isSafeInteger(item.file_size)
            ? item.file_size
            : undefined,
        }),
      );
    return found;
  }
  for (const child of Object.values(item)) falFiles(child, depth + 1, found);
  return found;
}

/**
 * One model with its OpenAPI schema, read from fal's public catalog: the
 * Composio tool does not return model schemas. The catalog needs no
 * credential, so none is sent.
 */
async function modelEntry(runtime: ConnectorRuntime, model: string) {
  const url = new URL("https://api.fal.ai/v1/models");
  url.searchParams.set("endpoint_id", model);
  url.searchParams.set("expand", "openapi-3.0");
  let raw: Json;
  try {
    const response = await (runtime.context.fetch ?? globalThis.fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    raw = record(
      JSON.parse(
        new TextDecoder().decode(await readBounded(response, 16 * 1024 * 1024)),
      ),
    );
  } catch {
    throw new ConnectorError(
      "provider_unavailable",
      "fal's model catalog could not be read; try again later.",
      { retryable: true },
    );
  }
  const found = (Array.isArray(raw.models) ? raw.models : [])
    .map((item) => record(item))
    .filter((item) => item.endpoint_id === model);
  if (found.length !== 1)
    throw new ConnectorError("not_found", "fal has no model with this ID.");
  return found[0]!;
}

interface ModelSchemas {
  input: Json;
  output?: Json;
  components: Json;
}

function child(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as Json)[key];
  }
  return current;
}

function resolveRef(value: unknown, components: Json): Json {
  const node =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Json)
      : {};
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const target = child(
    components,
    "schemas",
    ref.replace(/^#\/components\/schemas\//u, ""),
  );
  return target && typeof target === "object" ? (target as Json) : {};
}

/**
 * The request body and result schemas from a model's OpenAPI document, or
 * nothing when fal could not expand it (the document is then an error).
 */
function openapiSchemas(openapi: unknown): ModelSchemas | undefined {
  const components = (child(openapi, "components") ?? {}) as Json;
  const paths = child(openapi, "paths");
  let input: Json | undefined, output: Json | undefined;
  for (const [route, item] of Object.entries(
    paths && typeof paths === "object" ? (paths as Json) : {},
  )) {
    const body = child(
      item,
      "post",
      "requestBody",
      "content",
      "application/json",
      "schema",
    );
    if (!input && body) input = resolveRef(body, components);
    const result = child(
      item,
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
    );
    if (!output && result && route.endsWith("{request_id}"))
      output = resolveRef(result, components);
  }
  if (!input || typeof input.properties !== "object") return undefined;
  return { input, ...(output ? { output } : {}), components };
}

async function matchesSchema(
  schema: Json,
  schemas: ModelSchemas,
  value: unknown,
): Promise<boolean> {
  try {
    return await validateSchema(
      { ...schema, components: schemas.components },
      value,
    );
  } catch {
    // A schema this validator cannot compile is checked by fal on submission.
    return true;
  }
}

function typeName(value: Json, components: Json): string {
  if (typeof value.$ref === "string") {
    const target = resolveRef(value, components);
    const names = Object.keys(resolveSchemaNode(target.properties));
    if (names.length) return `object (${names.join(", ")})`;
    if (typeof target.type === "string") return target.type;
    return value.$ref.replace(/^#\/components\/schemas\//u, "");
  }
  const choices = value.anyOf ?? value.oneOf;
  if (Array.isArray(choices))
    return choices
      .map((item) => typeName(resolveSchemaNode(item), components))
      .join(" | ");
  if (value.type === "array")
    return `array<${typeName(resolveSchemaNode(value.items), components)}>`;
  return typeof value.type === "string" ? value.type : "any";
}

function resolveSchemaNode(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function fields(value: Json, components: Json): Json[] {
  const properties = resolveSchemaNode(value.properties);
  const required = new Set(Array.isArray(value.required) ? value.required : []);
  return Object.entries(properties).map(([name, raw]) => {
    const node = resolveSchemaNode(raw);
    // A field such as image_size takes a preset name or an object, so the
    // allowed names sit in one branch of its anyOf.
    const branches = node.anyOf ?? node.oneOf;
    const allowed = [
      node,
      ...(Array.isArray(branches) ? (branches as unknown[]) : []),
    ].flatMap((item) => {
      const values = resolveRef(item, components).enum;
      return Array.isArray(values) ? (values as unknown[]) : [];
    });
    return optionalFields({
      name,
      type: typeName(node, components),
      required: required.has(name),
      default: node.default,
      enum: allowed.length ? [...new Set(allowed)] : undefined,
      description:
        typeof node.description === "string"
          ? node.description.replace(/\s+/gu, " ").trim() || undefined
          : undefined,
    });
  });
}
