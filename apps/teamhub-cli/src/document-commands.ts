import { operationHeaders, teamHubData } from "./http-client.js";
import path from "node:path";
import type {
  CommandDefinition,
  NormalizedCommandInput,
} from "./command-definition.js";
import { reportInFinalReply } from "./command-definition.js";
import {
  assertPositionals,
  jsonSource,
  markdownBodySource,
  option,
  requiredOption,
} from "./command-input.js";
import { CliError } from "./errors.js";
import { parseActorReferences } from "./command-mentions.js";
import { displayText } from "./display-text.js";

const bodyOptions = {
  "--content": {
    description:
      "Inline Markdown body; outside code, \\n, \\t and \\\\ are decoded. Exclusive with --file, which is never decoded.",
  },
  "--file": {
    description: "Read the UTF-8 body from a regular file or - for stdin.",
  },
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const inputError = (message: string) => new CliError("invalid_input", message);
function resource(value: unknown, kind: string): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw inputError(`Provide a valid ${kind} ID.`);
  return value;
}
function target(
  input: Record<string, unknown>,
  kind: "document" | "thread",
  key: string,
): NormalizedCommandInput {
  const id = resource(input[key], kind);
  return { input, target: { type: kind, id }, scope: { kind, id } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw inputError("Provide one request JSON object.");
  return value as Record<string, unknown>;
}
function parsed<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw inputError(
      "Command input does not match this command's schema. Run with --schema.",
    );
  return result.data!;
}
const duplicateReasons = {
  create:
    "This operation was already completed. The original document is returned; no new document was created.",
  reply:
    "This reply was already posted. The original comment is returned; no new comment was created.",
};
function duplicate(
  kind: keyof typeof duplicateReasons | "update" | "replace",
  result: Record<string, unknown>,
): Record<string, unknown> {
  const { replayed, ...output } = result;
  if (typeof replayed !== "boolean")
    throw new CliError(
      "invalid_response",
      "TeamHub returned no valid duplicate-request status.",
    );
  const reason =
    kind === "update" || kind === "replace"
      ? result.status === "conflicted"
        ? "This operation previously ended in a conflict. The original conflict result is returned; no changes were applied."
        : "This operation was already applied. The original revision and history are returned; no new changes were applied."
      : duplicateReasons[kind];
  return {
    ...output,
    duplicate_request: replayed,
    ...(replayed ? { reason } : {}),
  };
}
const duplicateText = (result: Record<string, unknown>) =>
  result.duplicate_request === true
    ? [`Duplicate request: yes`, `Reason: ${displayText(result.reason)}`]
    : [];
const lines = (values: (string | undefined)[]) =>
  values.filter((value) => value !== undefined).join("\n");
function editText(result: Record<string, unknown>): string {
  return lines([
    result.thread_id === undefined
      ? `Update ${displayText(result.semantic_mutation_id)}`
      : `Thread: ${displayText(result.thread_id)}`,
    `Status: ${displayText(result.status)}`,
    result.revision_id === undefined
      ? undefined
      : `Revision: ${displayText(result.revision_id)}`,
    result.history_entry_id === undefined
      ? undefined
      : `History: ${displayText(result.history_entry_id)}`,
    result.conflict_reason === undefined
      ? undefined
      : `Conflict reason: ${displayText(result.conflict_reason)}`,
    result.observation === undefined
      ? undefined
      : `Observation: ${displayText(result.observation)}`,
    ...duplicateText(result),
  ]);
}
const duplicateSchema = {
  duplicate_request: { type: "boolean" },
  reason: { type: "string", minLength: 1 },
};
function duplicateOutput(
  properties: Record<string, unknown>,
  required: string[],
): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...properties, ...duplicateSchema },
    required: [...required, "duplicate_request"],
    allOf: [
      {
        if: { properties: { duplicate_request: { const: true } } },
        then: { required: ["reason"] },
        else: { not: { required: ["reason"] } },
      },
    ],
  };
}
const string = { type: "string" };
const editOutput = duplicateOutput(
  {
    semantic_mutation_id: string,
    status: { enum: ["applied", "conflicted"] },
    revision_id: string,
    history_entry_id: string,
    conflict_reason: string,
  },
  ["semantic_mutation_id", "status"],
);
const actions = [
  "append",
  "str_replace",
  "block_insert_before",
  "block_insert_after",
  "block_replace",
  "block_delete",
  "set_title",
  "image_insert_after",
  "image_replace",
];
const actionFields: Record<string, readonly string[]> = {
  append: ["--content", "--file"],
  str_replace: ["--content", "--file", "--pattern", "--block-id"],
  block_insert_before: ["--content", "--file", "--block-id"],
  block_insert_after: ["--content", "--file", "--block-id"],
  block_replace: [
    "--content",
    "--file",
    "--block-id",
    "--start-block-id",
    "--end-block-id",
  ],
  block_delete: ["--block-id", "--start-block-id", "--end-block-id"],
  set_title: ["--title"],
  image_insert_after: ["--block-id", "--asset-id", "--caption"],
  image_replace: ["--block-id", "--asset-id", "--caption"],
};
const documentIdSchema = { type: "string", pattern: idPattern.source };
const blockIdSchema = { ...documentIdSchema, not: { const: "0" } };
const bodySchema = {
  type: "string",
  minLength: 1,
  maxLength: 262144,
  pattern: "\\S",
};
const lineSchema = (minLength: number) => ({
  type: "string",
  minLength,
  maxLength: 262144,
  pattern: minLength ? "^[^\\r\\n]+$" : "^[^\\r\\n]*$",
});
const editBranch = (
  command: string,
  properties: Record<string, unknown>,
  required: string[],
) => ({
  type: "object",
  additionalProperties: false,
  required: ["document_id", "command", ...required],
  properties: {
    document_id: documentIdSchema,
    command: { const: command },
    ...properties,
  },
});
const locators = [
  { properties: { block_id: blockIdSchema }, required: ["block_id"] },
  {
    properties: { start_block_id: blockIdSchema, end_block_id: blockIdSchema },
    required: ["start_block_id", "end_block_id"],
  },
];
const editInputSchema = {
  oneOf: [
    editBranch("append", { content: bodySchema }, ["content"]),
    editBranch(
      "str_replace",
      {
        content: lineSchema(0),
        pattern: lineSchema(1),
        block_id: blockIdSchema,
      },
      ["pattern", "content"],
    ),
    ...["block_insert_before", "block_insert_after"].map((command) =>
      editBranch(command, { content: bodySchema, block_id: blockIdSchema }, [
        "content",
        "block_id",
      ]),
    ),
    ...locators.flatMap((locator) => [
      editBranch(
        "block_replace",
        { ...locator.properties, content: bodySchema },
        [...locator.required, "content"],
      ),
      editBranch("block_delete", locator.properties, locator.required),
    ]),
    editBranch(
      "set_title",
      { title: { type: "string", minLength: 1, maxLength: 255 } },
      ["title"],
    ),
    ...["image_insert_after", "image_replace"].map((command) =>
      editBranch(
        command,
        {
          block_id: blockIdSchema,
          asset_id: blockIdSchema,
          caption: { type: "string", maxLength: 1000, pattern: "^[^\\r\\n]*$" },
        },
        ["block_id", "asset_id"],
      ),
    ),
  ],
  description:
    "One action per operation. Body flags --content/--file are exclusive; --file reads bounded UTF-8 or stdin. Operation JSON and converted block batches are bounded to 256 KiB; converted content allows at most 2048 blocks.",
};

export const documentCommandDefinitions: readonly CommandDefinition[] = [
  {
    command: ["docs", "create"],
    toolName: "create_document",
    unavailableInTask: reportInFinalReply,
    description: "Create a Native Document in the configured Room or Task.",
    readOnly: false,
    operationId: true,
    schema: true,
    defaultTarget: "room-or-task",
    usage: ["--title <text> (--content <text> | --file <path|->) [flags]"],
    options: {
      "--title": { description: "Required Document title, 1-255 characters." },
      ...bodyOptions,
    },
    examples: [
      'teamhub docs create --title "Research report" --file ./report.md',
    ],
    outputSchema: duplicateOutput(
      {
        document_id: string,
        revision_id: string,
        status: { const: "created" },
      },
      ["document_id", "revision_id", "status"],
    ),
    async normalize(args, reader) {
      assertPositionals(args, 0);
      const title = requiredOption(args, "--title");
      const markdown = await markdownBodySource(args, reader);
      if (Buffer.byteLength(markdown!) > 1048576)
        throw inputError("Document body must not exceed 1 MiB UTF-8.");
      const { createDocumentInputSchema } =
        await import("./domains/collaboration/tools/document-tools.js");
      return {
        input: parsed(createDocumentInputSchema, { title, markdown }),
      };
    },
    project: (result) => duplicate("create", result),
    render: (result) =>
      lines([
        `${result.duplicate_request ? "Already created: Document" : "Created Document"} ${displayText(result.document_id)}`,
        `Revision: ${displayText(result.revision_id)}`,
        result.duplicate_request
          ? undefined
          : `Status: ${displayText(result.status)}`,
        ...duplicateText(result),
      ]),
  },
  {
    command: ["docs", "list"],
    toolName: "list_documents",
    description:
      "List every Document your Human has; you can read, edit and manage each of them.",
    readOnly: true,
    fileRoute: "docs/ls",
    usage: ["[--shared] [--json]"],
    options: {
      "--shared": {
        description: "Only Documents someone shared with you to look at.",
        boolean: true,
      },
    },
    async normalize(args) {
      assertPositionals(args, 0);
      return {
        input:
          option(args, "--shared") === undefined
            ? {}
            : { shared_with_me: true },
      };
    },
    render(result) {
      const documents = result.documents as Record<string, unknown>[];
      return !documents.length
        ? "No Documents found."
        : documents
            .map((document) =>
              lines([
                `${displayText(document.document_id)} · ${displayText(document.name)}`,
                `Role: ${displayText(document.role)}`,
                `Editable: ${displayText(document.editable)}`,
                `Shared with you: ${displayText(document.shared_with_me)}`,
                `Version: ${displayText(document.version_id)}`,
                `Version number: ${displayText(document.version_number)}`,
                `Read only: ${displayText(document.read_only)}`,
              ]),
            )
            .join("\n\n");
    },
  },
  {
    command: ["docs", "get"],
    toolName: "get_document",
    description: "Download an authorized Document working copy or export.",
    readOnly: true,
    fileRoute: "docs/get",
    usage: ["<name-or-id-or-link> [flags]"],
    arguments: [
      "<name-or-id-or-link>  Exact name, Document ID or supported share link.",
    ],
    options: {
      "-o": { description: "Output path; exclusive with --output." },
      "--output": { description: "Output path relative to cwd." },
      "--format": { description: "markdown, blocks or html." },
      "--raw": {
        description: "Keep original bytes without extracting embedded images.",
        boolean: true,
      },
    },
    async normalize(args, reader) {
      assertPositionals(args, 1);
      const name = args.positionals[0]!;
      const isLink =
        /^doc_link_[A-Za-z0-9_-]{43}$/u.test(name) ||
        /^https?:\/\/[^\0]+#doc_link_[A-Za-z0-9_-]{43}$/u.test(name);
      if (
        !isLink &&
        (!name ||
          /[/\\\0]/u.test(name) ||
          [".", ".."].includes(name) ||
          name.startsWith("-"))
      )
        throw inputError(
          "Provide an exact Document name, ID or supported share link.",
        );
      const output = option(args, "--output");
      const shortOutput = option(args, "-o");
      if (output !== undefined && shortOutput !== undefined)
        throw new CliError("usage", "Choose --output or -o, not both.");
      const format = option(args, "--format");
      if (
        format !== undefined &&
        !["markdown", "blocks", "html"].includes(format)
      )
        throw inputError("Use markdown, blocks or html for --format.");
      const filename = output ?? shortOutput ?? (isLink ? "download" : name);
      if (
        !filename ||
        filename === "-" ||
        filename.split(/[/\\]/u).includes("..")
      )
        throw inputError("Provide a local output file path.");
      return {
        input: {
          name,
          target_path: path.resolve(reader.cwd, filename),
          ...(format === undefined ? {} : { format }),
          ...(option(args, "--raw") === undefined ? {} : { raw: true }),
        },
        ...(/^document_[A-Za-z0-9_-]+$/u.test(name)
          ? { target: { type: "document", id: name } }
          : {}),
      };
    },
    render: (result) =>
      lines([
        `Downloaded ${displayText(result.document_id)}`,
        `Version: ${displayText(result.version_id)}`,
        `Name: ${displayText(result.name)}`,
        `File: ${displayText(result.file_path)}`,
        result.save_command === undefined
          ? undefined
          : `${result.save_command_shell === "powershell" ? "Save (PowerShell)" : "Save"}: ${displayText(result.save_command)}`,
        result.save_command_bash === undefined
          ? undefined
          : `Save (Git Bash): ${displayText(result.save_command_bash)}`,
      ]),
  },
  {
    command: ["docs", "update"],
    toolName: "apply_document_semantic_mutation",
    description:
      "Edit the title, text or selected blocks of a Native Document.",
    readOnly: false,
    operationId: true,
    schema: true,
    usage: ["<document-id> --command <action> [flags]"],
    arguments: ["<document-id>  Remote Native Document ID."],
    options: {
      "--command": { description: `Required action: ${actions.join(", ")}.` },
      ...bodyOptions,
      "--pattern": {
        description: "Exact nonempty single-line text for str_replace.",
      },
      "--block-id": { description: "One real block target or anchor." },
      "--start-block-id": {
        description: "First block of a contiguous sibling range.",
      },
      "--end-block-id": {
        description: "Last block of the same sibling range.",
      },
      "--title": { description: "New title for set_title." },
      "--asset-id": {
        description:
          "Image commands: an Asset of this Document (see docs image put).",
      },
      "--caption": {
        description: "Image commands: optional one-line caption.",
      },
    },
    inputSchema: editInputSchema,
    outputSchema: editOutput,
    async normalize(args, reader) {
      assertPositionals(args, 1);
      const action = requiredOption(args, "--command");
      const allowed = actionFields[action];
      if (!allowed)
        throw inputError(`Use one edit command: ${actions.join(", ")}.`);
      if (
        Object.keys(args.options).some(
          (key) =>
            !["--command", "--json", "--operation-id", ...allowed].includes(
              key,
            ),
        )
      )
        throw new CliError(
          "usage",
          `This edit action only accepts ${allowed.join(", ")}.`,
        );
      // Reject locator combinations before reading stdin or a replacement file.
      const blockId = option(args, "--block-id"),
        startId = option(args, "--start-block-id"),
        endId = option(args, "--end-block-id");
      if (
        ["block_replace", "block_delete"].includes(action) &&
        (blockId !== undefined
          ? startId !== undefined || endId !== undefined
          : startId === undefined || endId === undefined)
      )
        throw new CliError(
          "usage",
          "Provide --block-id or both --start-block-id and --end-block-id.",
        );
      if (
        [
          "block_insert_before",
          "block_insert_after",
          "image_insert_after",
          "image_replace",
        ].includes(action) &&
        blockId === undefined
      )
        throw new CliError("usage", "Provide --block-id.");
      const input: Record<string, unknown> = {
        document_id: resource(args.positionals[0], "Document"),
        command: action,
      };
      for (const [flag, key] of [
        ["--pattern", "pattern"],
        ["--block-id", "block_id"],
        ["--start-block-id", "start_block_id"],
        ["--end-block-id", "end_block_id"],
        ["--title", "title"],
        ["--asset-id", "asset_id"],
        ["--caption", "caption"],
      ] as const) {
        const value = option(args, flag);
        if (value !== undefined) input[key] = value;
      }
      if (allowed.includes("--content"))
        input.content = await markdownBodySource(args, reader);
      const { editDocumentInputSchema } =
        await import("./domains/collaboration/tools/document-tools.js");
      return target(
        parsed(editDocumentInputSchema, input),
        "document",
        "document_id",
      );
    },
    async execute(input, context) {
      const {
        editDocumentInputSchema,
        applyDocumentSemanticMutationOutputSchema,
      } = await import("./domains/collaboration/tools/document-tools.js");
      const value = parsed(editDocumentInputSchema, input);
      const { document_id, ...action } = value;
      if (!context.operationId)
        throw new CliError(
          "invalid_input",
          "Document updates require an operation identity.",
        );
      const { agentOperationInvocationId } =
        await import("./business-routes.js");
      const invocation = agentOperationInvocationId(context.operationId);
      const result = await teamHubData(
        context.client.api.POST("/api/agent/v1/document-semantic-mutations", {
          body: {
            document_id,
            schema_version: "blocknote-semantic-v1",
            invocation_id: invocation,
            semantic_change: [
              {
                kind: "edit_document",
                parser_version: "markdown-v1",
                ...action,
              },
            ],
          },
          headers: operationHeaders(context.operationId),
        }),
      );
      const decoded =
        applyDocumentSemanticMutationOutputSchema.safeParse(result);
      if (!decoded.success)
        throw new CliError(
          "invalid_response",
          "TeamHub returned an invalid Document edit result.",
        );
      return decoded.data;
    },
    project: (result) => duplicate("update", result),
    render: editText,
  },
  {
    command: ["docs", "replace"],
    toolName: "replace_document",
    description:
      "Save a tracked Native blocks/HTML working copy using its original revision baseline.",
    readOnly: false,
    fileRoute: "docs/replace",
    usage: ["<document-id> <working-copy-path> [--json]"],
    arguments: [
      "<document-id>  Native Document matching the working-copy receipt.",
      "<working-copy-path>  Tracked blocks or HTML file; stdin is not supported.",
    ],
    options: {},
    async normalize(args, reader) {
      assertPositionals(args, 2);
      const document_id = args.positionals[0]!;
      const filename = args.positionals[1]!;
      if (!/^document_[A-Za-z0-9_-]{1,119}$/u.test(document_id))
        throw inputError("Provide a Native Document ID.");
      if (
        !filename ||
        filename === "-" ||
        filename.includes("\0") ||
        filename.split(/[/\\]/u).includes("..")
      )
        throw inputError("Provide a tracked local working-copy path.");
      return target(
        { document_id, file_path: path.resolve(reader.cwd, filename) },
        "document",
        "document_id",
      );
    },
    render: (result) =>
      lines([
        `${result.status === "unchanged" ? "Unchanged" : "Replaced"} ${displayText(result.document_id)}`,
        `Revision: ${displayText(result.revision_id)}`,
        result.history_entry_id === undefined
          ? undefined
          : `History: ${displayText(result.history_entry_id)}`,
        `Name: ${displayText(result.name)}`,
        `Unchanged: ${displayText(result.unchanged)}`,
      ]),
  },
  {
    command: ["docs", "comment", "get"],
    toolName: "get_document_comment_thread",
    description:
      "Read an authorized unresolved Comment Thread and its selection.",
    readOnly: true,
    schema: true,
    usage: ["<thread-id> [flags]"],
    options: {},
    async normalize(args) {
      assertPositionals(args, 1);
      const input = { thread_id: args.positionals[0] };
      const { getDocumentCommentThreadInputSchema } =
        await import("./domains/collaboration/tools/document-comment-tools.js");
      return target(
        parsed(getDocumentCommentThreadInputSchema, input),
        "thread",
        "thread_id",
      );
    },
    render(result) {
      const selection = record(result.selection);
      const comments = result.comments as Record<string, unknown>[];
      return lines([
        `Thread: ${displayText(result.thread_id)}`,
        `Selection: ${displayText(selection.quoted_text)}`,
        `Before: ${displayText(selection.context_before)}`,
        `After: ${displayText(selection.context_after)}`,
        "",
        `Comments: ${comments.length}`,
        ...comments.flatMap((comment) => {
          const author = record(comment.author);
          return [
            `${displayText(comment.comment_id)} · ${displayText(author.display_name)} (${displayText(author.kind)}) · ${displayText(comment.created_at)}`,
            comment.parent_comment_id === undefined
              ? ""
              : `Parent: ${displayText(comment.parent_comment_id)}`,
            (comment.segments as Record<string, unknown>[])
              .map((segment) =>
                segment.type === "reference"
                  ? `[@${displayText(segment.content)}](${displayText(segment.actor_id)})`
                  : String(segment.content),
              )
              .join(""),
          ];
        }),
      ]);
    },
  },
  {
    command: ["docs", "comment", "reply"],
    toolName: "reply_document_comment",
    description: "Reply to an authorized Document Comment Thread.",
    readOnly: false,
    operationId: true,
    schema: true,
    usage: [
      "<thread-id> (--content <text> | --file <path|->) [flags]",
      "<thread-id> (--segments <JSON> | --segments-file <path|->) [flags]",
    ],
    options: {
      ...bodyOptions,
      "--segments": {
        description: "Complete array of Comment text/reference segments.",
      },
      "--segments-file": {
        description: "Read the Comment segment array as JSON.",
      },
      "--parent-comment-id": {
        description: "Optional parent Comment in the same Thread.",
      },
    },
    outputSchema: duplicateOutput({ thread_id: string, comment_id: string }, [
      "thread_id",
      "comment_id",
    ]),
    async normalize(args, reader) {
      assertPositionals(args, 1);
      const ordinary =
        option(args, "--content") !== undefined ||
        option(args, "--file") !== undefined;
      const structured =
        option(args, "--segments") !== undefined ||
        option(args, "--segments-file") !== undefined;
      if (ordinary === structured)
        throw new CliError(
          "usage",
          "Choose one body source: --content, --file, --segments or --segments-file.",
        );
      const segments = ordinary
        ? parseActorReferences(
            (await markdownBodySource(args, reader))!,
            "comment",
          )
        : await jsonSource(args, reader, "--segments", "--segments-file");
      const parent = option(args, "--parent-comment-id");
      const input = {
        thread_id: args.positionals[0],
        segments,
        ...(parent === undefined ? {} : { parent_comment_id: parent }),
      };
      const { replyDocumentCommentInputSchema } =
        await import("./domains/collaboration/tools/document-comment-tools.js");
      return target(
        parsed(replyDocumentCommentInputSchema, input),
        "thread",
        "thread_id",
      );
    },
    project: (result) => duplicate("reply", result),
    render: (result) =>
      lines([
        `${result.duplicate_request ? "Reply already posted to" : "Replied to"} ${displayText(result.thread_id)}`,
        `Comment: ${displayText(result.comment_id)}`,
        ...duplicateText(result),
      ]),
  },
  {
    command: ["docs", "comment", "replace"],
    toolName: "replace_document_comment_text",
    description:
      "Replace the exact text selected by an authorized Comment Thread.",
    readOnly: false,
    operationId: true,
    schema: true,
    usage: ["<thread-id> (--content <text> | --file <path|->) [flags]"],
    options: bodyOptions,
    async normalize(args, reader) {
      assertPositionals(args, 1);
      const input = {
        thread_id: args.positionals[0],
        replace_str: await markdownBodySource(args, reader),
      };
      const { replaceDocumentCommentTextInputSchema } =
        await import("./domains/collaboration/tools/document-comment-tools.js");
      return target(
        parsed(replaceDocumentCommentTextInputSchema, input),
        "thread",
        "thread_id",
      );
    },
    outputSchema: duplicateOutput(
      {
        thread_id: string,
        status: { enum: ["applied", "conflicted"] },
        revision_id: string,
        history_entry_id: string,
        conflict_reason: string,
        observation: string,
      },
      ["thread_id", "status", "observation"],
    ),
    project: (result) => duplicate("replace", result),
    render: editText,
  },
];
