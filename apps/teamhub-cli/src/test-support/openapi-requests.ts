import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { displayText } from "../display-text.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value as ObjectValue;
interface Located {
  value: ObjectValue;
  uri: string;
}

export function findOpenAPIPath<T extends { template: string }>(
  paths: readonly T[],
  pathname: string,
): T | undefined {
  return paths
    .toSorted(
      (left, right) =>
        left.template.split("/").filter((part) => part.startsWith("{")).length -
        right.template.split("/").filter((part) => part.startsWith("{")).length,
    )
    .find((item) => {
      const expected = item.template.split("/");
      const actual = pathname.split("/");
      return (
        expected.length === actual.length &&
        expected.every(
          (part, index) => part.startsWith("{") || part === actual[index],
        )
      );
    });
}

/** Validate HTTP exchanges using independent server contracts, not CLI schemas. */
export async function openAPIContract() {
  const documents = new Map<string, ObjectValue>();
  const extensions = new Set<string>();
  const ajv = new Ajv2020({
    strictSchema: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
    validateFormats: true,
  });
  (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
  ajv.addFormat("binary", true);
  for (const keyword of ["example", "discriminator", "xml", "externalDocs"])
    ajv.addKeyword(keyword);
  const root = new URL(
    "../../../../contracts/openapi/teamhub-agent-api/openapi.yaml",
    import.meta.url,
  ).href;
  const publicRoot = new URL(
    "../../../../contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
    import.meta.url,
  ).href;
  async function load(uri: string): Promise<void> {
    if (documents.has(uri)) return;
    const document = object(parse(await readFile(fileURLToPath(uri), "utf8")));
    documents.set(uri, document);

    async function visit(value: unknown): Promise<void> {
      if (!value || typeof value !== "object") return;
      const ref = object(value).$ref;
      if (typeof ref === "string" && !ref.startsWith("#")) {
        const next = new URL(ref, uri);
        next.hash = "";
        if (next.protocol !== "file:")
          throw new Error(`Nonlocal contract reference: ${ref}`);
        await load(next.href);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("x-") && !extensions.has(key)) {
          extensions.add(key);
          ajv.addKeyword(key);
        }
        await visit(child);
      }
    }
    await visit(document);
    ajv.addSchema({ $defs: { document: absolute(document, uri) } }, uri);
  }
  await load(root);
  await load(publicRoot);
  function resolve(located: Located): Located {
    if (typeof located.value.$ref !== "string") return located;
    const target = new URL(located.value.$ref, located.uri);
    const fragment = decodeURIComponent(target.hash.slice(1));
    target.hash = "";
    let value: unknown = documents.get(target.href);
    for (const key of fragment.split("/").slice(1))
      value = object(value)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
    if (!value)
      throw new Error(
        `Unresolved contract reference: ${target.href}#${fragment}`,
      );
    return resolve({ value: object(value), uri: target.href });
  }
  function absolute(value: unknown, uri: string): unknown {
    if (Array.isArray(value)) return value.map((child) => absolute(child, uri));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key !== "$ref" || typeof child !== "string")
          return [key, absolute(child, uri)];
        const target = new URL(child, uri);
        target.hash = `/$defs/document${target.hash.slice(1)}`;
        return [key, target.href];
      }),
    );
  }
  function validate(
    schema: ObjectValue,
    uri: string,
    value: unknown,
    label: string,
  ) {
    const check = ajv.compile(absolute(schema, uri) as ObjectValue);
    if (!check(value))
      throw new Error(
        `${label}: ${ajv.errorsText(check.errors)}\n${JSON.stringify(check.errors)}`,
      );
  }
  function wireType(schema: ObjectValue, uri: string): unknown {
    const located = resolve({ value: schema, uri });
    if (located.value.type) return located.value.type;
    if (Array.isArray(located.value.allOf))
      return located.value.allOf
        .map((child) => wireType(object(child), located.uri))
        .find((type) => type !== undefined);
    return undefined;
  }
  const paths = [root, publicRoot].flatMap((uri) =>
    Object.entries(object(documents.get(uri)!.paths)).map(
      ([template, value]) => ({
        template,
        ...resolve({ value: object(value), uri }),
      }),
    ),
  );
  function locateOperation(request: Request) {
    const url = new URL(request.url);
    const match = findOpenAPIPath(paths, url.pathname);
    if (!match)
      throw new Error(
        `Undeclared TeamHub endpoint: ${request.method} ${url.pathname}`,
      );
    const operation = object(match.value[request.method.toLowerCase()]);
    if (!operation)
      throw new Error(
        `Undeclared TeamHub method: ${request.method} ${url.pathname}`,
      );
    return { match, operation, label: String(operation.operationId) };
  }
  async function validateRequest(request: Request): Promise<string> {
    const url = new URL(request.url);
    const { match, operation, label } = locateOperation(request);
    const parameters = [
      ...((match.value.parameters as unknown[]) ?? []),
      ...((operation.parameters as unknown[]) ?? []),
    ];
    for (const raw of parameters) {
      const parameter = resolve({ value: object(raw), uri: match.uri });
      const name = String(parameter.value.name);
      let value: unknown;
      if (parameter.value.in === "query")
        value = url.searchParams.get(name) ?? undefined;
      else if (parameter.value.in === "header")
        value = request.headers.get(name) ?? undefined;
      else if (parameter.value.in === "path")
        value = decodeURIComponent(
          url.pathname.split("/")[
            match.template.split("/").indexOf(`{${name}}`)
          ]!,
        );
      else
        throw new Error(
          `Unsupported parameter location: ${displayText(parameter.value.in)}`,
        );
      if (value === undefined) {
        if (parameter.value.required)
          throw new Error(`${label}: required ${parameter.value.in} ${name}`);
        continue;
      }
      const schema = resolve({
        value: object(parameter.value.schema),
        uri: parameter.uri,
      });
      // OpenAPI primitive query/header values are serialized as text on the wire.
      if (["integer", "number"].includes(String(schema.value.type)))
        value = Number(value);
      if (schema.value.type === "boolean")
        value = value === "true" ? true : value === "false" ? false : value;
      validate(schema.value, schema.uri, value, `${label}/${name}`);
    }
    if (!operation.requestBody) {
      if (request.body) throw new Error(`${label}: unexpected request body`);
      return label;
    }
    const body = resolve({
      value: object(operation.requestBody),
      uri: match.uri,
    });
    const mediaType = request.headers.get("content-type")?.split(";")[0];
    const media = object(object(body.value.content)[mediaType ?? ""]);
    if (!media)
      throw new Error(`${label}: undeclared content type ${mediaType}`);
    let value: unknown;
    if (mediaType === "application/json") value = await request.json();
    else if (mediaType === "multipart/form-data") {
      const form = await request.formData();
      const fields: ObjectValue = {};
      const schema = resolve({ value: object(media.schema), uri: body.uri });
      const properties = object(schema.value.properties);
      for (const key of new Set(form.keys())) {
        const property = resolve({
          value: object(properties[key] ?? {}),
          uri: schema.uri,
        }).value;
        const type = wireType(property, schema.uri);
        const values = await Promise.all(
          form
            .getAll(key)
            .map(async (part) =>
              typeof part === "string"
                ? type === "object"
                  ? (JSON.parse(part) as unknown)
                  : part
                : Buffer.from(await part.arrayBuffer()).toString("latin1"),
            ),
        );
        if (type !== "array" && values.length > 1)
          throw new Error(`${label}: duplicate multipart field ${key}`);
        if (
          property.contentMediaType === "application/json" &&
          property.contentSchema
        ) {
          for (const text of values) {
            if (typeof text !== "string")
              throw new Error(`${label}/${key}: JSON content must be a string`);
            validate(
              object(property.contentSchema),
              schema.uri,
              JSON.parse(text),
              `${label}/${key}`,
            );
          }
        }
        fields[key] = type === "array" ? values : values[0];
      }
      value = fields;
    } else if (
      ["application/octet-stream", "application/zip"].includes(mediaType ?? "")
    )
      value = Buffer.from(await request.arrayBuffer()).toString("latin1");
    else throw new Error(`${label}: unsupported media type ${mediaType}`);
    validate(object(media.schema), body.uri, value, label);
    return label;
  }
  async function validateResponse(
    request: Request,
    response: Response,
  ): Promise<void> {
    const { match, operation, label } = locateOperation(request);
    const responses = object(operation.responses);
    const raw =
      responses[String(response.status)] ??
      responses[`${Math.floor(response.status / 100)}XX`] ??
      responses.default;
    const responseLabel = `${label}/response/${response.status}`;
    if (!raw) throw new Error(`${responseLabel}: undeclared response status`);
    const declared = resolve({ value: object(raw), uri: match.uri });
    if (!declared.value.content) {
      if ((await response.arrayBuffer()).byteLength)
        throw new Error(`${responseLabel}: unexpected response body`);
      return;
    }
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    const content = object(declared.value.content);
    const media = object(
      content[mediaType ?? ""] ??
        content[`${mediaType?.split("/")[0]}/*`] ??
        content["*/*"],
    );
    if (!media)
      throw new Error(
        `${responseLabel}: undeclared response content type ${mediaType}`,
      );
    if (!media.schema)
      throw new Error(`${responseLabel}: missing response schema`);
    const value: unknown = mediaType?.match(
      /^(application\/json|[^/]+\/[^/]+\+json)$/,
    )
      ? await response.json()
      : mediaType?.startsWith("text/")
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString("latin1");
    validate(object(media.schema), declared.uri, value, responseLabel);
  }
  return { validateRequest, validateResponse };
}
