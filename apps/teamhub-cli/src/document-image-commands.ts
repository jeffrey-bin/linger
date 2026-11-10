import { operationHeaders, teamHubData } from "./http-client.js";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CommandDefinition,
  CommandExecutionContext,
} from "./command-definition.js";
import { assertPositionals, option } from "./command-input.js";
import { CliError } from "./errors.js";
import { displayText } from "./display-text.js";

// Images and files in a Native Document: upload a local image and place it
// after a block or in place of an image block, save an image block's
// original, or place a local file as a file block (an email canvas sends it
// as an attachment).
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const maxImageBytes = 10 << 20;
const maxFileBytes = 15 << 20;
const inputError = (message: string) => new CliError("invalid_input", message);

function id(value: unknown, kind: string): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw inputError(`Provide a valid ${kind} ID.`);
  return value;
}

// Offline schemas of the normalized command input and the command result.
const idSchema = { type: "string", pattern: idPattern.source };
const localPath = {
  type: "string",
  minLength: 1,
  description: "Absolute local path resolved against cwd.",
};
const putInputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "document_id",
    "command",
    "block_id",
    "file",
    "filename",
    "sha256",
  ],
  properties: {
    document_id: idSchema,
    command: { enum: ["image_insert_after", "image_replace"] },
    block_id: idSchema,
    caption: { type: "string", maxLength: 1000, pattern: "^[^\\r\\n]*$" },
    file: {
      ...localPath,
      description: "PNG, JPEG, GIF or WebP file of 1 byte to 10 MiB.",
    },
    filename: { type: "string", minLength: 1, maxLength: 255 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  description:
    "--after selects image_insert_after and --replace selects image_replace; exactly one is required.",
};
const putOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document_id", "asset_id", "status"],
  properties: {
    document_id: idSchema,
    asset_id: idSchema,
    status: { enum: ["applied", "conflicted"] },
    revision_id: { type: "string" },
    conflict_reason: { type: "string" },
  },
};
const getInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document_id", "block_id"],
  properties: {
    document_id: idSchema,
    block_id: idSchema,
    output: {
      ...localPath,
      description:
        "Absolute local path resolved against cwd; defaults to the image's file name. Never overwrites.",
    },
  },
};
const getOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document_id", "block_id", "asset_id", "path", "size_bytes"],
  properties: {
    document_id: idSchema,
    block_id: idSchema,
    asset_id: idSchema,
    path: localPath,
    size_bytes: { type: "integer", minimum: 1 },
  },
};

const filePutInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document_id", "block_id", "file", "filename", "sha256"],
  properties: {
    document_id: idSchema,
    block_id: idSchema,
    file: {
      ...localPath,
      description:
        "PDF, Office (docx, xlsx, pptx), ZIP, CSV, Markdown, text or image file of 1 byte to 15 MiB.",
    },
    filename: { type: "string", minLength: 1, maxLength: 255 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};

/** Uploads a local file as an Asset of the Document and returns its ID. */
async function uploadAsset(
  context: CommandExecutionContext,
  documentId: string,
  filename: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const uploaded = (await (
    await context.client.request(
      `/api/agent/v1/files/${documentId}/assets?${new URLSearchParams({
        filename,
        operation_id: context.operationId!,
      }).toString()}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-teamhub-operation-id": context.operationId!,
        },
        body: bytes,
      },
    )
  ).json()) as { asset_id?: unknown };
  return id(uploaded.asset_id, "Asset");
}

/** Finds an image block anywhere in a blocks export and returns its Asset. */
function imageAsset(blocks: unknown, blockId: string): string {
  const pending = Array.isArray(blocks) ? [...blocks] : [];
  while (pending.length) {
    const block = pending.shift() as {
      id?: unknown;
      type?: unknown;
      props?: { url?: unknown };
      children?: unknown;
    };
    if (block?.id === blockId) {
      const url = block.type === "image" ? block.props?.url : undefined;
      const match =
        typeof url === "string" ? /^document-asset:(.+)$/u.exec(url) : null;
      if (!match || !idPattern.test(match[1]!))
        throw inputError(`Block ${blockId} is not an image of this Document.`);
      return match[1]!;
    }
    if (Array.isArray(block?.children)) pending.push(...block.children);
  }
  throw new CliError("not_found", `Block ${blockId} was not found.`);
}

export const documentImageCommandDefinitions: readonly CommandDefinition[] = [
  {
    command: ["docs", "image", "put"],
    toolName: "put_document_image",
    description:
      "Place a local image in a Native Document after a block or in place of an image.",
    readOnly: false,
    operationId: true,
    usage: [
      "<document-id> <image-path> (--after <block-id> | --replace <block-id>) [--caption <text>]",
    ],
    arguments: [
      "<document-id>  Native Document you can edit.",
      "<image-path>  PNG, JPEG, GIF or WebP file, at most 10 MiB.",
    ],
    options: {
      "--after": { description: "Insert the image after this block." },
      "--replace": { description: "Replace this image block." },
      "--caption": { description: "Optional one-line caption." },
    },
    examples: [
      "teamhub docs image put document_example ./card-blue.png --replace block_card",
    ],
    notes: [
      "Uploads the image, then edits the Document; repeating with the same operation ID does it once.",
      "The previous image stays available for about a day; put its Asset back with docs update --command image_replace to undo.",
    ],
    inputSchema: putInputSchema,
    outputSchema: putOutputSchema,
    async normalize(args, reader) {
      assertPositionals(args, 2);
      const after = option(args, "--after");
      const replace = option(args, "--replace");
      if ((after === undefined) === (replace === undefined))
        throw new CliError(
          "usage",
          "Provide exactly one of --after or --replace.",
        );
      const caption = option(args, "--caption");
      if (
        caption !== undefined &&
        (caption.length > 1000 || /[\r\n]/u.test(caption))
      )
        throw inputError(
          "Caption must be one line of at most 1000 characters.",
        );
      const file = path.resolve(reader.cwd, args.positionals[1]!);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) throw inputError("Provide a regular image file.");
      if (info.size < 1 || info.size > maxImageBytes)
        throw inputError("Image must be 1 byte to 10 MiB.");
      const bytes = await readFile(file);
      const documentId = id(args.positionals[0], "Document");
      return {
        input: {
          document_id: documentId,
          command: after === undefined ? "image_replace" : "image_insert_after",
          block_id: id(after ?? replace, "block"),
          ...(caption === undefined ? {} : { caption }),
          file,
          filename: path.basename(file),
          // Identifies the bytes so a retry with the same file replays.
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        target: { type: "document", id: documentId },
        scope: { kind: "document", id: documentId },
      };
    },
    async execute(input, context) {
      if (!context.operationId)
        throw inputError("Image placement requires an operation identity.");
      const bytes = await readFile(String(input.file));
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
        throw inputError("The image file changed; run the command again.");
      const documentId = String(input.document_id);
      const assetId = await uploadAsset(
        context,
        documentId,
        String(input.filename),
        bytes,
      );
      const { agentOperationInvocationId } =
        await import("./business-routes.js");
      const edit = await teamHubData(
        context.client.api.POST("/api/agent/v1/document-semantic-mutations", {
          body: {
            document_id: documentId,
            schema_version: "blocknote-semantic-v1",
            invocation_id: agentOperationInvocationId(context.operationId),
            semantic_change: [
              {
                kind: "edit_document",
                parser_version: "markdown-v1",
                command: input.command as
                  | "image_insert_after"
                  | "image_replace",
                block_id: input.block_id as string,
                asset_id: assetId,
                ...(input.caption === undefined
                  ? {}
                  : { caption: input.caption as string }),
              },
            ],
          },
          headers: operationHeaders(context.operationId),
        }),
      );
      return {
        document_id: documentId,
        asset_id: assetId,
        status: edit.status,
        ...(edit.revision_id === undefined
          ? {}
          : { revision_id: edit.revision_id }),
        ...(edit.conflict_reason === undefined
          ? {}
          : { conflict_reason: edit.conflict_reason }),
      };
    },
    render: (result) =>
      [
        `${result.status === "applied" ? "Placed" : "Not placed"} image Asset ${displayText(result.asset_id)} in ${displayText(result.document_id)}`,
        `Status: ${displayText(result.status)}`,
        result.revision_id === undefined
          ? undefined
          : `Revision: ${displayText(result.revision_id)}`,
        result.conflict_reason === undefined
          ? undefined
          : `Conflict reason: ${displayText(result.conflict_reason)}; read the Document again and retry.`,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
  },
  {
    command: ["docs", "image", "get"],
    toolName: "get_document_image",
    description:
      "Save the original image of an image block in a Native Document.",
    readOnly: true,
    usage: ["<document-id> <block-id> [-o <path>]"],
    arguments: [
      "<document-id>  Native Document you can read.",
      "<block-id>  Image block, from docs get --format blocks.",
    ],
    options: {
      "-o": {
        description:
          "Local path; default is the image's file name. Never overwrites.",
      },
      "--output": { description: "Same as -o." },
    },
    examples: [
      "teamhub docs image get document_example block_card -o ./card.png",
    ],
    inputSchema: getInputSchema,
    outputSchema: getOutputSchema,
    async normalize(args, reader) {
      assertPositionals(args, 2);
      const output = option(args, "-o") ?? option(args, "--output");
      const documentId = id(args.positionals[0], "Document");
      return {
        input: {
          document_id: documentId,
          block_id: id(args.positionals[1], "block"),
          ...(output === undefined
            ? {}
            : { output: path.resolve(reader.cwd, output) }),
        },
        target: { type: "document", id: documentId },
        scope: { kind: "document", id: documentId },
      };
    },
    async execute(input, context) {
      const documentId = String(input.document_id);
      const exported = (await (
        await context.client.request(
          `/api/agent/v1/files/${documentId}/content?format=blocks`,
        )
      ).json()) as { blocks?: unknown };
      const assetId = imageAsset(exported.blocks, String(input.block_id));
      const response = await context.client.request(
        `/api/agent/v1/files/${documentId}/assets/${assetId}/content`,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      const encoded = response.headers.get("x-document-filename") ?? "";
      const named = path.basename(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      const output =
        typeof input.output === "string"
          ? input.output
          : path.resolve(
              context.cwd,
              named && named !== "." ? named : `${assetId}.img`,
            );
      // Never overwrite a local file.
      await writeFile(output, bytes, { flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          throw error.code === "EEXIST"
            ? inputError(
                `${output} already exists; choose another path with -o.`,
              )
            : error;
        },
      );
      return {
        document_id: documentId,
        block_id: input.block_id,
        asset_id: assetId,
        path: output,
        size_bytes: bytes.length,
      };
    },
    render: (result) =>
      `Saved image Asset ${displayText(result.asset_id)} of block ${displayText(result.block_id)} to ${displayText(result.path)} (${displayText(result.size_bytes)} bytes)`,
  },
  {
    command: ["docs", "file", "put"],
    toolName: "put_document_file",
    description:
      "Place a local file in a Native Document as a file block after a block; an email canvas sends it as an attachment.",
    readOnly: false,
    operationId: true,
    usage: ["<document-id> <file-path> --after <block-id>"],
    arguments: [
      "<document-id>  Native Document you can edit.",
      "<file-path>  PDF, Office (docx, xlsx, pptx), ZIP, CSV, Markdown, text or image file, at most 15 MiB.",
    ],
    options: {
      "--after": { description: "Insert the file block after this block." },
    },
    examples: [
      "teamhub docs file put document_example ./proposal.pdf --after block_signature",
    ],
    notes: [
      "Uploads the file, then edits the Document; repeating with the same operation ID does it once.",
      "The file's type comes from its content; an unsupported file is refused.",
    ],
    inputSchema: filePutInputSchema,
    outputSchema: putOutputSchema,
    async normalize(args, reader) {
      assertPositionals(args, 2);
      const after = option(args, "--after");
      if (after === undefined)
        throw new CliError("usage", "Provide --after <block-id>.");
      const file = path.resolve(reader.cwd, args.positionals[1]!);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) throw inputError("Provide a regular file.");
      if (info.size < 1 || info.size > maxFileBytes)
        throw inputError("File must be 1 byte to 15 MiB.");
      const bytes = await readFile(file);
      const documentId = id(args.positionals[0], "Document");
      return {
        input: {
          document_id: documentId,
          block_id: id(after, "block"),
          file,
          filename: path.basename(file),
          // Identifies the bytes so a retry with the same file replays.
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        target: { type: "document", id: documentId },
        scope: { kind: "document", id: documentId },
      };
    },
    async execute(input, context) {
      if (!context.operationId)
        throw inputError("File placement requires an operation identity.");
      const bytes = await readFile(String(input.file));
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
        throw inputError("The file changed; run the command again.");
      const documentId = String(input.document_id);
      const filename = String(input.filename);
      const assetId = await uploadAsset(context, documentId, filename, bytes);
      const { agentOperationInvocationId } =
        await import("./business-routes.js");
      const edit = await teamHubData(
        context.client.api.POST("/api/agent/v1/document-semantic-mutations", {
          body: {
            document_id: documentId,
            schema_version: "blocknote-semantic-v1",
            invocation_id: agentOperationInvocationId(context.operationId),
            semantic_change: [
              {
                kind: "edit_document",
                parser_version: "markdown-v1",
                command: "file_insert_after",
                block_id: input.block_id as string,
                asset_id: assetId,
                name: filename,
              },
            ],
          },
          headers: operationHeaders(context.operationId),
        }),
      );
      return {
        document_id: documentId,
        asset_id: assetId,
        status: edit.status,
        ...(edit.revision_id === undefined
          ? {}
          : { revision_id: edit.revision_id }),
        ...(edit.conflict_reason === undefined
          ? {}
          : { conflict_reason: edit.conflict_reason }),
      };
    },
    render: (result) =>
      [
        `${result.status === "applied" ? "Placed" : "Not placed"} file Asset ${displayText(result.asset_id)} in ${displayText(result.document_id)}`,
        `Status: ${displayText(result.status)}`,
        result.revision_id === undefined
          ? undefined
          : `Revision: ${displayText(result.revision_id)}`,
        result.conflict_reason === undefined
          ? undefined
          : `Conflict reason: ${displayText(result.conflict_reason)}; read the Document again and retry.`,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
  },
];
