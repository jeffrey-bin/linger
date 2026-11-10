import { createHash } from "node:crypto";
import path from "node:path";
import type { CommandDefinition } from "./command-definition.js";
import { assertPositionals, option } from "./command-input.js";
import {
  choice,
  pageInput,
  pageSchema,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  connectorDefinition,
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import {
  assertNewOutput,
  saveConnectorDownload,
  validateLocalFiles,
} from "./connector-files.js";
import { ConnectorError as CliError } from "./errors.js";
import { displayText } from "./display-text.js";
const descriptions = {
  list: "List one folder level; defaults to the root.",
  mkdir:
    "Create a folder under an existing parent; errors on a name collision.",
  search: "Search accessible files with ordinary keywords.",
  read: "Read metadata for a file or folder.",
  upload: "Upload one local regular file as a new remote file.",
  download:
    "Download a file or explicitly export a supported format without overwriting local files.",
};
type Action = keyof typeof descriptions;
const pages = {
  "--limit": value("1–100 items per page; default 20."),
  "--cursor": value(
    "Cursor from the previous page; keep the same account and filters.",
  ),
};
export const driveCommandDefinitions: CommandDefinition[] = (
  Object.keys(descriptions) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["gdrive", action],
    description: descriptions[action],
    readOnly: !["mkdir", "upload"].includes(action),
    options: {
      ...(["list", "search"].includes(action) ? pages : {}),
      ...(["list", "mkdir", "upload"].includes(action)
        ? {
            "--folder": value(
              "Existing parent folder ID; defaults to the root.",
            ),
          }
        : {}),
      ...(action === "search"
        ? {
            "--query": value(
              "Ordinary filename keywords, not a query language.",
            ),
          }
        : {}),
      ...(["mkdir", "upload"].includes(action)
        ? {
            "--name": value(
              action === "mkdir"
                ? "Single-level folder name; paths are rejected."
                : "Remote file name; defaults to the local basename.",
            ),
          }
        : {}),
      ...(action === "upload"
        ? { "--file": value("Local regular file; stdin is rejected.") }
        : {}),
      ...(action === "download"
        ? {
            "--output": value("Local file path; does not overwrite."),
            "--format": value(
              "Native Workspace documents require pdf/docx/xlsx/pptx/csv/txt.",
            ),
          }
        : {}),
    },
    usage: [
      `teamhub gdrive ${action}${["read", "download"].includes(action) ? " <file-id>" : ""}${action === "mkdir" ? " --name <name>" : action === "upload" ? " --file <path> --folder <id>" : action === "download" ? " --output <path> [--format <format>]" : action === "search" ? " --query <text>" : ""} [flags]`,
    ],
    examples:
      action === "list"
        ? ["teamhub gdrive list"]
        : action === "mkdir"
          ? ["teamhub gdrive mkdir --name 'project-files'"]
          : action === "search"
            ? ["teamhub gdrive search --query 'project proposal'"]
            : action === "upload"
              ? [
                  "teamhub gdrive upload --file ./proposal.pdf --folder folder_example",
                ]
              : action === "download"
                ? [
                    "teamhub gdrive download file_example --output ./proposal.pdf",
                  ]
                : ["teamhub gdrive read file_example"],
    inputSchema: schema({
      ...(["list", "search"].includes(action) ? pageSchema : {}),
      ...(["read", "download"].includes(action)
        ? { fileId: stringSchema }
        : {}),
      ...(["list", "mkdir", "upload"].includes(action)
        ? { folderId: stringSchema }
        : {}),
      ...(action === "search" ? { query: stringSchema } : {}),
      ...(["mkdir", "upload"].includes(action) ? { name: stringSchema } : {}),
      ...(action === "upload" ? { file: stringSchema } : {}),
      ...(action === "download"
        ? { output: stringSchema, format: stringSchema }
        : {}),
    }),
    sourceFiles: (input) => (input.file ? [displayText(input.file)] : []),
    normalize: async (args, reader) => {
      const input: Json = {};
      assertPositionals(args, ["read", "download"].includes(action) ? 1 : 0);
      if (["list", "search"].includes(action))
        Object.assign(input, pageInput(args));
      if (["read", "download"].includes(action))
        input.fileId = fileId(text(args.positionals[0], "file ID"));
      if (option(args, "--folder") !== undefined)
        input.folderId = fileId(text(option(args, "--folder"), "--folder"));
      if (action === "mkdir")
        input.name = singleName(text(option(args, "--name"), "--name", 255));
      if (action === "search")
        input.query = text(option(args, "--query"), "--query", 2000);
      if (action === "upload") {
        const [filename] = await validateLocalFiles(
          [text(option(args, "--file"), "--file", 4096)],
          reader.cwd,
        );
        input.file = filename;
        input.name = singleName(
          option(args, "--name") ?? path.basename(filename!),
        );
      }
      if (action === "download") {
        input.output = await assertNewOutput(
          text(option(args, "--output"), "--output", 4096),
          reader.cwd,
        );
        const format = choice(
          option(args, "--format"),
          ["pdf", "docx", "xlsx", "pptx", "csv", "txt"],
          "--format",
        );
        if (format) input.format = format;
      }
      return { input };
    },
    bindings: () =>
      action === "list" || action === "search"
        ? ["GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_GET_FILE_METADATA"]
        : action === "mkdir"
          ? [
              "GOOGLEDRIVE_FIND_FILE",
              "GOOGLEDRIVE_GET_FILE_METADATA",
              "GOOGLEDRIVE_CREATE_FOLDER",
            ]
          : action === "upload"
            ? ["GOOGLEDRIVE_RESUMABLE_UPLOAD", "GOOGLEDRIVE_GET_FILE_METADATA"]
            : action === "download"
              ? [
                  "GOOGLEDRIVE_GET_FILE_METADATA",
                  "GOOGLEDRIVE_DOWNLOAD_FILE",
                  "GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE",
                ]
              : ["GOOGLEDRIVE_GET_FILE_METADATA"],
    execute: (input, runtime) => executeGDrive(action, input, runtime),
  }),
);
function fileId(value: string): string {
  if (
    value.includes("/") ||
    value.includes("\\") ||
    !/^[a-zA-Z0-9_-]+$/u.test(value)
  )
    usage("Use a file/folder ID, not a path or URL.");
  return value;
}
function singleName(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    /[/\\\r\n\p{Cc}]/u.test(value) ||
    !value.trim() ||
    [...value].length > 255
  )
    usage(
      "Provide a valid single filename; paths and reserved names are not accepted.",
    );
  return value;
}
const driveFields =
  "id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed,driveId,md5Checksum,capabilities,version";
function gFile(raw: Json): Json {
  if (raw.trashed === true)
    throw new CliError("not_found", "The item is in trash.");
  const size = raw.size === undefined ? undefined : Number(raw.size);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
    throw new CliError("incomplete_response", "The file size is invalid.");
  return optionalFields({
    fileId: requiredString(raw.id, "file ID"),
    name: requiredString(raw.name, "filename"),
    mimeType: requiredString(raw.mimeType, "MIME type"),
    kind:
      raw.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
    sizeBytes: size,
    parentIds: raw.parents,
    modifiedAt: raw.modifiedTime,
    url: raw.webViewLink ?? raw.display_url,
    driveId: raw.driveId,
  });
}
async function gMeta(id: unknown, runtime: ConnectorRuntime): Promise<Json> {
  const raw = await runtime.call("GOOGLEDRIVE_GET_FILE_METADATA", {
    fileId: id,
    fields: driveFields,
    supportsAllDrives: true,
  });
  gFile(raw);
  if (id !== "root" && raw.id !== id)
    throw new CliError(
      "incomplete_response",
      "The Drive item identity does not match.",
    );
  return raw;
}
async function gParent(input: Json, runtime: ConnectorRuntime): Promise<Json> {
  const parent = await gMeta(input.folderId ?? "root", runtime);
  if (parent.mimeType !== "application/vnd.google-apps.folder")
    throw new CliError("invalid_input", "The selected parent is not a folder.");
  return parent;
}
const driveQuote = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
function gPage(raw: Json): { files: Json[]; token: unknown } {
  if (
    !Array.isArray(raw.files) ||
    raw.incompleteSearch === true ||
    raw.pagetoken_dropped === true
  )
    throw new CliError("incomplete_response", "Drive search is incomplete.");
  return { files: raw.files.map((x) => record(x)), token: raw.nextPageToken };
}
async function executeGDrive(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "read")
    return { file: gFile(await gMeta(input.fileId, runtime)) };
  const fp = {
    account: runtime.account.connection_id,
    app: "gdrive",
    action,
    folder: input.folderId ?? "root",
    query: input.query ?? "",
    limit: input.limit,
  };
  const state = cursor(input.cursor, fp);
  if (action === "list" || action === "search") {
    const parent =
      action === "list" ? await gParent(input, runtime) : undefined;
    const q =
      action === "search"
        ? `trashed = false and name contains '${driveQuote(String(input.query))}'`
        : "trashed = false";
    const raw = await runtime.call(
      "GOOGLEDRIVE_FIND_FILE",
      optionalFields({
        q,
        folder_id: parent?.id,
        pageSize: input.limit,
        pageToken: state.token,
        fields: `nextPageToken,incompleteSearch,files(${driveFields})`,
        orderBy: "modifiedTime desc",
        corpora: "user",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const page = gPage(raw);
    if (
      parent &&
      page.files.some(
        (x) => !Array.isArray(x.parents) || !x.parents.includes(parent.id),
      )
    )
      throw new CliError(
        "incomplete_response",
        "The directory list contains an unverified parent.",
      );
    return optionalFields({
      folder: parent ? gFile(parent) : undefined,
      files: page.files.map(gFile),
      hasMore: Boolean(page.token),
      nextCursor: page.token
        ? nextCursor({ token: page.token }, fp)
        : undefined,
    });
  }
  if (action === "mkdir") {
    const parent = await gParent(input, runtime);
    if (parent.driveId === parent.id)
      throw new CliError(
        "unsupported_combination",
        "Creating folders at a shared drive root is not supported by this binding.",
      );
    let token: unknown;
    const seen = new Set<unknown>();
    for (let page = 0; page < 100; page++) {
      const found = gPage(
        await runtime.call(
          "GOOGLEDRIVE_FIND_FILE",
          optionalFields({
            folder_id: parent.id,
            q: `trashed = false and name = '${driveQuote(String(input.name))}'`,
            pageSize: 100,
            pageToken: token,
            fields: `nextPageToken,incompleteSearch,files(${driveFields})`,
            corpora: "user",
          }),
        ),
      );
      if (found.files.length)
        throw new CliError(
          "conflict",
          "The parent already contains an item with this name; list the directory first.",
        );
      token = found.token;
      if (!token) break;
      if (seen.has(token) || page === 99)
        throw new CliError(
          "incomplete_response",
          "The duplicate-name check did not finish.",
        );
      seen.add(token);
    }
    const created = await runtime.call(
      "GOOGLEDRIVE_CREATE_FOLDER",
      optionalFields({
        name: input.name,
        parent_id: input.folderId ? parent.id : undefined,
      }),
      true,
    );
    const verified = await gMeta(
      requiredString(created.id, "new folder ID"),
      runtime,
    );
    if (
      verified.name !== input.name ||
      verified.mimeType !== "application/vnd.google-apps.folder" ||
      !Array.isArray(verified.parents) ||
      !verified.parents.includes(parent.id)
    )
      throw new CliError(
        "outcome_unknown",
        "The created folder identity or parent was not confirmed.",
      );
    return {
      result: { action: "created", acknowledged: true, ...gFile(verified) },
    };
  }
  if (action === "upload") {
    const parent = await gParent(input, runtime);
    const file = runtime.files[0]!;
    const staged = {
      ...(await runtime.stageFile(file, "GOOGLEDRIVE_RESUMABLE_UPLOAD")),
      name: input.name,
    };
    const uploaded = await runtime.call(
      "GOOGLEDRIVE_RESUMABLE_UPLOAD",
      {
        file_to_upload: staged,
        metadata: { name: input.name, parents: [parent.id] },
        chunkSize: 2097152,
      },
      true,
    );
    const actual = await gMeta(
      requiredString(record(uploaded.file).id, "uploaded file ID"),
      runtime,
    );
    if (
      actual.name !== input.name ||
      Number(actual.size) !== file.sizeBytes ||
      actual.md5Checksum !== file.md5 ||
      !Array.isArray(actual.parents) ||
      !actual.parents.includes(parent.id)
    )
      throw new CliError(
        "outcome_unknown",
        "The uploaded file content or parent was not confirmed.",
      );
    return {
      result: {
        action: "uploaded",
        acknowledged: true,
        ...gFile(actual),
        sha256: file.sha256,
      },
    };
  }
  const meta = await gMeta(input.fileId, runtime);
  if (meta.mimeType === "application/vnd.google-apps.folder")
    throw new CliError(
      "unsupported_combination",
      "Download one file, not a folder.",
    );
  const native = String(meta.mimeType).startsWith(
    "application/vnd.google-apps.",
  );
  let raw: Json;
  if (native) {
    if (!input.format)
      usage("Google Workspace documents require an explicit --format.");
    const source = String(meta.mimeType).split(".").at(-1);
    const allowed: Record<string, string[]> = {
      document: ["pdf", "docx", "txt"],
      spreadsheet: ["pdf", "xlsx", "csv"],
      presentation: ["pdf", "pptx", "txt"],
      drawing: ["pdf"],
    };
    if (!allowed[source!]?.includes(String(input.format)))
      throw new CliError(
        "unsupported_combination",
        "This export format is not supported for the source document type.",
      );
    const mime: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      csv: "text/csv",
      txt: "text/plain",
    };
    raw = await runtime.call("GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE", {
      fileId: input.fileId,
      mimeType: mime[String(input.format)],
    });
    if (raw.file_id !== input.fileId)
      throw new CliError(
        "incomplete_response",
        "The exported file identity was not confirmed.",
      );
    return {
      file: {
        ...gFile(meta),
        ...(await saveConnectorDownload(
          record(raw.file).s3url,
          String(input.output),
          runtime.context,
        )),
        format: input.format,
      },
    };
  }
  if (input.format)
    usage("--format only applies to native Google Workspace documents.");
  raw = await runtime.call("GOOGLEDRIVE_DOWNLOAD_FILE", {
    fileId: input.fileId,
  });
  if (raw.id !== input.fileId || raw.export_applied === true)
    throw new CliError(
      "incomplete_response",
      "The original binary file was not confirmed.",
    );
  return {
    file: {
      ...gFile(meta),
      ...(await saveConnectorDownload(
        record(raw.downloaded_file_content).s3url,
        String(input.output),
        runtime.context,
        (bytes) => {
          if (meta.size !== undefined && bytes.length !== Number(meta.size))
            throw new CliError(
              "incomplete_response",
              "The download size does not match the file metadata.",
            );
          if (
            typeof meta.md5Checksum === "string" &&
            createHash("md5").update(bytes).digest("hex") !== meta.md5Checksum
          )
            throw new CliError(
              "incomplete_response",
              "The downloaded file checksum does not match.",
            );
        },
      )),
    },
  };
}
