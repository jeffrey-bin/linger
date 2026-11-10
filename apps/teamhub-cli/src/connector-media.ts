import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  CommandArguments,
  CommandExecutionContext,
} from "./command-definition.js";
import { values } from "./command-input.js";
import { fetchConnectorFile, saveConnectorBytes } from "./connector-files.js";
import { usage } from "./connector-input.js";
import {
  optionalFields,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import {
  array,
  id,
  object,
  pageOutput,
  rootSchema,
  str,
} from "./connector-schemas.js";
import { CliError, ConnectorError } from "./errors.js";

// Shared by the generative media connectors (fal, Higgsfield): model
// parameters given as flags, continuing a provider job, and saving its
// result files.

export interface GenerationProvider {
  outputSchema: Json;
  bindings(input: Json): readonly string[];
  bindingSchema?(slug: string, schema: Json): Json;
  execute(input: Json, runtime: ConnectorRuntime): Promise<Json>;
}

export const generationPrices = rootSchema(
  {
    models: array(
      object(
        {
          modelId: id,
          name: str,
          outputType: { enum: ["image", "video"] },
          description: str,
          price: object(
            {
              unitPrice: { type: "number", minimum: 0 },
              unit: str,
              currency: str,
            },
            ["unitPrice"],
          ),
          inputs: array({ type: "object", additionalProperties: true }),
          outputs: array({ type: "object", additionalProperties: true }),
          parameters: array({ type: "object", additionalProperties: true }),
          medias: array({ type: "object", additionalProperties: true }),
          aspectRatios: array({}),
          durations: array({}),
          durationRange: { type: "object", additionalProperties: true },
          supportsUnlimited: { type: "boolean" },
          docsUrl: str,
        },
        ["modelId", "outputType"],
      ),
    ),
    ...pageOutput,
    pricingStatus: { enum: ["available", "partial", "unavailable"] },
    warning: str,
  },
  ["models", "hasMore", "pricingStatus"],
);

/**
 * A continuation selects the same account, never repeats submission, and
 * saves to the requested --output once the job has finished.
 */
export function generationResume(
  input: Json,
  runtime: ConnectorRuntime,
  ids: readonly string[],
): string {
  const quote = (value: unknown) =>
    `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
    `teamhub ${input.type as string}-gen --provider ${input.provider as string} --model ${input.model as string}`,
    ...ids.map((id) => `--job ${quote(id)}`),
    ...(input.output === undefined ? [] : [`--output ${quote(input.output)}`]),
    `--account ${quote(runtime.account.connection_id)}`,
  ].join(" ");
}

/** Free text such as a prompt: line breaks allowed, NUL and blank refused. */
export function prose(value: string | undefined, label: string): string {
  if (
    value === undefined ||
    !value.trim() ||
    value.length > 100000 ||
    value.includes("\u0000")
  )
    usage(`${label} requires nonblank text of at most 100,000 characters.`);
  return value as string;
}

/**
 * Each `--set field=value` sets one top-level field. A value that parses as
 * JSON keeps that type, so `--set count=2` is a number and `--set seed=x` a
 * string.
 */
export function fieldValues(args: CommandArguments): Json {
  const fields: Json = {};
  for (const item of values(args, "--set")) {
    const at = item.indexOf("=");
    const field = at > 0 ? item.slice(0, at) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(field))
      usage("--set takes field=value with a plain field name.");
    if (Object.hasOwn(fields, field))
      usage(`--set sets ${field} more than once.`);
    const raw = item.slice(at + 1);
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON: the value is the text itself.
    }
    fields[field] = parsed;
  }
  return fields;
}

const savedFile = object(
  {
    url: id,
    path: id,
    sizeBytes: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    warning: str,
  },
  ["url", "path", "sizeBytes", "sha256"],
);
export const savedFiles = array(savedFile);

export interface RemoteFile {
  url: string;
  /** File name without extension when several results share a directory. */
  label: string;
  contentType?: string;
}

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "model/gltf-binary": "glb",
};

function extension(url: string, contentType: string): string {
  const fromPath = /\.([A-Za-z0-9]{1,8})$/u.exec(new URL(url).pathname)?.[1];
  return (extensions[contentType] ?? fromPath ?? "bin")
    .toLowerCase()
    .replace(/^jpeg$/u, "jpg");
}

/**
 * The caller names a single output file. The bytes are kept as delivered, so
 * a name whose extension disagrees with them is reported rather than fixed.
 */
function extensionWarning(output: string, type: string): string | undefined {
  const named = path
    .extname(output)
    .slice(1)
    .toLowerCase()
    .replace(/^jpeg$/u, "jpg");
  if (type === "bin" || named === type) return undefined;
  return `The file holds ${type} data but ${named ? `is named .${named}` : "has no extension"}; rename it to end in .${type} before opening or sharing it.`;
}

/**
 * Saves one result to the new file `output`, or several to the new
 * directory `output`. Files already saved stay when a later one fails.
 */
export async function saveRemoteFiles(
  files: readonly RemoteFile[],
  output: string,
  context: CommandExecutionContext,
): Promise<Json[]> {
  if (files.length > 1)
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
      .then(() => mkdir(output, { mode: 0o700 }))
      .catch(() => {
        throw new ConnectorError(
          "invalid_path",
          "The output directory could not be created; choose a new path.",
        );
      });
  const saved: Json[] = [];
  for (const file of files) {
    try {
      const { bytes, contentType } = await fetchConnectorFile(
        file.url,
        context,
      );
      const type = extension(file.url, contentType || (file.contentType ?? ""));
      const target =
        files.length === 1
          ? output
          : path.join(
              output,
              `${file.label.replace(/[^A-Za-z0-9._-]/gu, "-")}.${type}`,
            );
      saved.push(
        optionalFields({
          url: file.url,
          ...(await saveConnectorBytes(bytes, target, context)),
          warning:
            files.length === 1 ? extensionWarning(output, type) : undefined,
        }),
      );
    } catch (error) {
      if (!saved.length) throw error;
      throw new ConnectorError(
        "file_transfer_failed",
        "Some result files were saved; use --job with a new --output path to retry the download.",
        {
          ...(error instanceof CliError ? error.details : {}),
          partial_receipts: [...saved, { url: file.url, status: "failed" }],
        },
      );
    }
  }
  return saved;
}
