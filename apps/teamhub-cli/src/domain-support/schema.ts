import { z } from "zod";
import { SchemaError } from "./errors.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ToolSchema = z.ZodType<unknown, unknown>;
export type SchemaDirection = "input" | "output";

export const toolSchemaToJsonSchema = (
  schema: ToolSchema,
  direction: SchemaDirection,
): JsonObject => {
  let converted: unknown;
  try {
    converted = z.toJSONSchema(schema, {
      cycles: "ref",
      io: direction,
      reused: "inline",
      target: "draft-07",
      unrepresentable: "throw",
    });
  } catch (error) {
    throw new SchemaError(
      "INVALID_SCHEMA",
      `The ${direction} schema cannot be represented as draft-07 JSON Schema`,
      { cause: error, path: `$${direction}` },
    );
  }

  const json = cloneJsonValue(converted, `$${direction}`);
  if (!isJsonObject(json)) {
    throw new SchemaError(
      "INVALID_SCHEMA",
      `The ${direction} schema must generate a JSON object`,
      { path: `$${direction}` },
    );
  }
  if (json.type !== "object") {
    throw new SchemaError(
      "INVALID_SCHEMA",
      `The ${direction} schema root must have type object`,
      { path: `$${direction}` },
    );
  }
  if (json.additionalProperties !== false) {
    throw new SchemaError(
      "INVALID_SCHEMA",
      `The ${direction} schema root must reject additional properties`,
      { path: `$${direction}.additionalProperties` },
    );
  }

  assertCompleteDescriptions(json, `$${direction}`);
  return deepFreezeJson(json);
};

export const assertCompleteDescriptions = (
  schema: JsonObject,
  rootPath = "$schema",
): void => {
  visitSchema(schema, rootPath, true, {
    root: schema,
    visited: new WeakMap(),
  });
};

interface SchemaVisitState {
  readonly root: JsonObject;
  readonly visited: WeakMap<JsonObject, boolean>;
}

const visitSchema = (
  schema: JsonObject,
  path: string,
  descriptionRequired: boolean,
  state: SchemaVisitState,
): void => {
  const reference = schema.$ref;
  const isReference = reference !== undefined;
  const requiresOwnDescription =
    descriptionRequired && !isReference && !isReferenceWrapper(schema);
  const previousRequirement = state.visited.get(schema);
  if (
    previousRequirement === true ||
    previousRequirement === requiresOwnDescription
  ) {
    return;
  }
  state.visited.set(schema, requiresOwnDescription);

  if (isReference) {
    if (typeof reference !== "string") {
      return invalidSchema(`${path}.$ref`, "must be a string");
    }
    const target = resolveLocalReference(state.root, reference, path);
    if (typeof target !== "boolean") {
      visitSchema(target, `${path}.$ref(${reference})`, false, state);
    }
  }

  if (requiresOwnDescription) {
    const description = schema.description;
    if (typeof description !== "string" || description.trim() === "") {
      throw new SchemaError(
        "MISSING_SCHEMA_DESCRIPTION",
        `${path} must have a non-empty description`,
        { path },
      );
    }
  }

  visitNamedSchemas(schema.properties, `${path}.properties`, true, state);
  visitNamedSchemas(
    schema.patternProperties,
    `${path}.patternProperties`,
    true,
    state,
  );
  visitNamedSchemas(
    schema.dependentSchemas,
    `${path}.dependentSchemas`,
    true,
    state,
  );
  visitNamedSchemas(schema.$defs, `${path}.$defs`, false, state);
  visitNamedSchemas(schema.definitions, `${path}.definitions`, false, state);

  visitSingleSchema(
    schema.additionalProperties,
    `${path}.additionalProperties`,
    true,
    state,
  );
  visitSingleSchema(
    schema.unevaluatedProperties,
    `${path}.unevaluatedProperties`,
    true,
    state,
  );
  visitSingleSchema(schema.items, `${path}.items`, true, state);
  visitSingleSchema(schema.contains, `${path}.contains`, true, state);
  visitSingleSchema(
    schema.propertyNames,
    `${path}.propertyNames`,
    false,
    state,
  );
  visitSingleSchema(schema.not, `${path}.not`, false, state);
  visitSingleSchema(schema.if, `${path}.if`, false, state);
  visitSingleSchema(schema.then, `${path}.then`, false, state);
  visitSingleSchema(schema.else, `${path}.else`, false, state);

  visitSchemaArray(schema.prefixItems, `${path}.prefixItems`, false, state);
  visitSchemaArray(schema.oneOf, `${path}.oneOf`, true, state);
  visitSchemaArray(
    schema.anyOf,
    `${path}.anyOf`,
    !isGenericJsonValueUnion(schema),
    state,
  );
  visitSchemaArray(schema.allOf, `${path}.allOf`, false, state);
};

const isReferenceWrapper = (schema: JsonObject): boolean => {
  const fields = Object.keys(schema).filter(
    (field) => field !== "$schema" && field !== "description",
  );
  if (fields.length !== 1) return false;
  const firstField = fields[0];
  if (firstField === "$ref") return typeof schema.$ref === "string";
  const allOf = schema.allOf;
  if (firstField !== "allOf" || allOf === undefined || !isJsonArray(allOf)) {
    return false;
  }
  return allOf.every(
    (branch) => isJsonObject(branch) && isReferenceWrapper(branch),
  );
};

const isGenericJsonValueUnion = (schema: JsonObject): boolean => {
  const anyOf = schema.anyOf;
  if (anyOf === undefined || !isJsonArray(anyOf) || anyOf.length !== 6) {
    return false;
  }
  const branches = anyOf;
  const typeNames = branches.map((branch) =>
    isJsonObject(branch) && typeof branch.type === "string"
      ? branch.type
      : undefined,
  );
  if (typeNames.join(",") !== "string,number,boolean,null,array,object") {
    return false;
  }

  const arrayBranch = branches[4];
  const objectBranch = branches[5];
  return (
    isJsonObject(arrayBranch) &&
    isReferenceWrapperValue(arrayBranch.items) &&
    isJsonObject(objectBranch) &&
    isJsonObject(objectBranch.propertyNames) &&
    objectBranch.propertyNames.type === "string" &&
    isReferenceWrapperValue(objectBranch.additionalProperties)
  );
};

const isReferenceWrapperValue = (value: JsonValue | undefined): boolean =>
  isJsonObject(value) && isReferenceWrapper(value);

const visitNamedSchemas = (
  value: JsonValue | undefined,
  path: string,
  descriptionRequired: boolean,
  state: SchemaVisitState,
): void => {
  if (value === undefined) return;
  if (!isJsonObject(value)) {
    invalidSchema(path, "must be an object of schemas");
  }
  const schemas = value as JsonObject;
  for (const key of Object.keys(schemas).sort()) {
    const child = schemas[key];
    if (!isJsonObject(child)) {
      invalidSchema(`${path}.${key}`, "must be a schema object");
    }
    visitSchema(
      child as JsonObject,
      `${path}.${key}`,
      descriptionRequired,
      state,
    );
  }
};

const visitSingleSchema = (
  value: JsonValue | undefined,
  path: string,
  descriptionRequired: boolean,
  state: SchemaVisitState,
): void => {
  if (value === undefined || typeof value === "boolean") return;
  if (isJsonArray(value)) {
    visitSchemaArray(value, path, descriptionRequired, state);
    return;
  }
  if (!isJsonObject(value)) invalidSchema(path, "must be a schema object");
  visitSchema(value as JsonObject, path, descriptionRequired, state);
};

const visitSchemaArray = (
  value: JsonValue | undefined,
  path: string,
  descriptionRequired: boolean,
  state: SchemaVisitState,
): void => {
  if (value === undefined) return;
  if (!isJsonArray(value)) invalidSchema(path, "must be an array of schemas");
  (value as JsonArray).forEach((child, index) => {
    if (!isJsonObject(child)) {
      invalidSchema(`${path}[${index}]`, "must be a schema object");
    }
    visitSchema(
      child as JsonObject,
      `${path}[${index}]`,
      descriptionRequired,
      state,
    );
  });
};

const resolveLocalReference = (
  root: JsonObject,
  reference: string,
  path: string,
): JsonObject | boolean => {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) {
    throw new SchemaError(
      "UNSUPPORTED_SCHEMA_REFERENCE",
      `${path} contains a non-local JSON Schema reference`,
      { path: `${path}.$ref` },
    );
  }

  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch (error) {
    throw new SchemaError(
      "UNSUPPORTED_SCHEMA_REFERENCE",
      `${path} contains an invalid local JSON Schema reference`,
      { cause: error, path: `${path}.$ref` },
    );
  }

  let current: JsonValue = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(rawToken)) {
      throw new SchemaError(
        "UNSUPPORTED_SCHEMA_REFERENCE",
        `${path} contains an invalid JSON Pointer escape`,
        { path: `${path}.$ref` },
      );
    }
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, token)) {
        return unresolvedReference(path, reference);
      }
      current = current[token]!;
      continue;
    }
    if (isJsonArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(token)) {
      const index = Number(token);
      if (index < current.length) {
        current = current[index]!;
        continue;
      }
    }
    return unresolvedReference(path, reference);
  }

  if (typeof current === "boolean" || isJsonObject(current)) return current;
  return unresolvedReference(path, reference);
};

const unresolvedReference = (path: string, reference: string): never => {
  throw new SchemaError(
    "UNSUPPORTED_SCHEMA_REFERENCE",
    `${path} contains an unresolved local JSON Schema reference ${reference}`,
    { path: `${path}.$ref` },
  );
};

const invalidSchema = (path: string, message: string): never => {
  throw new SchemaError("INVALID_SCHEMA", `${path} ${message}`, { path });
};

export const cloneJsonValue = (value: unknown, path = "$json"): JsonValue => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (containsUnpairedSurrogate(value)) {
      throw new SchemaError(
        "INVALID_SCHEMA",
        `${path} contains an unpaired Unicode surrogate`,
        { path },
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SchemaError(
        "INVALID_SCHEMA",
        `${path} contains a non-finite number`,
        { path },
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      cloneJsonValue(child, `${path}[${index}]`),
    );
  }
  if (!isPlainObject(value)) {
    throw new SchemaError("INVALID_SCHEMA", `${path} is not a JSON value`, {
      path,
    });
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      throw new SchemaError("INVALID_SCHEMA", `${path}.${key} is undefined`, {
        path: `${path}.${key}`,
      });
    }
    result[key] = cloneJsonValue(child, `${path}.${key}`);
  }
  return result;
};

export const deepFreezeJson = <Value extends JsonValue>(
  value: Value,
): Value => {
  if (isJsonArray(value)) {
    value.forEach((child) => deepFreezeJson(child));
    return Object.freeze(value);
  }
  if (isJsonObject(value)) {
    Object.values(value).forEach((child) => deepFreezeJson(child));
    return Object.freeze(value);
  }
  return value;
};

export const isJsonObject = (value: unknown): value is JsonObject =>
  isPlainObject(value);

export const isJsonArray = (value: JsonValue): value is JsonArray =>
  Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const containsUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
};
