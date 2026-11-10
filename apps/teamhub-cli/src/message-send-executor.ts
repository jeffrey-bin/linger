import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  bundleDocumentImages,
  inferFileMetadata,
} from "@linger/document-files";
import { readExactHostFile } from "./files/host-file-reader.js";
import { isExcludedPublicationEntry } from "./files/publication-filter.js";
import { agentOperationInvocationId } from "./business-routes.js";
import type { CommandExecutionContext } from "./command-definition.js";
import { CliError } from "./errors.js";
import { readJson } from "./http-client.js";

type Json = Record<string, unknown>;
interface Upload {
  upload_id: string;
  filename: string;
  representation_format: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
}
interface Metadata {
  invocation_id: string;
  inbox_id: string;
  source_message_id?: string;
  continues?: true;
  card_title?: string;
  card_kind?: "profile";
  segments: Json[];
  uploads: Upload[];
}
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string) => new CliError("invalid_input", message);
const maxFile = 50 * 1024 * 1024;
function publicPath(value: string) {
  if (value.split(/[\\/]/u).some(isExcludedPublicationEntry))
    throw invalid(
      "Resources cannot read private state or installed dependencies.",
    );
}
async function regular(source: string, signal: AbortSignal, max = maxFile) {
  publicPath(source);
  // Runtime workspace roots (for example playground) are projected directories.
  // Resolve only the parent: the leaf must still be a real file, and both the
  // supplied and resolved paths must exclude private state. The reader pins
  // every canonical component and the file identity throughout the read.
  const parent = await realpath(path.dirname(source));
  source = path.join(parent, path.basename(source));
  publicPath(source);
  const root = path.parse(source).root;
  const info = await lstat(source);
  if (!info.isFile() || info.nlink !== 1)
    throw invalid("Resources must be regular files without aliases.");
  return readExactHostFile(
    root,
    path.relative(root, source).split(path.sep).join("/"),
    max,
    signal,
  );
}

function utf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("Text resources must contain valid UTF-8.");
  }
}
async function prepare(
  input: Json,
  context: CommandExecutionContext,
  operationId: string,
  // File snapshots are Buffers, which a Blob accepts without copying.
  contents: Map<string, Uint8Array<ArrayBuffer>>,
  signal: AbortSignal,
): Promise<Metadata> {
  const canonicalCwd = await realpath(context.cwd);
  const inputInbox = String(input.inbox_id);
  const inbox =
    inputInbox.startsWith("thread:") ||
    inputInbox.startsWith("task:") ||
    inputInbox.startsWith("room:")
      ? inputInbox
      : `room:${inputInbox}`;
  const metadata: Metadata = {
    invocation_id: agentOperationInvocationId(operationId),
    inbox_id: inbox,
    segments: [],
    uploads: [],
    ...(typeof input.source_message_id === "string"
      ? { source_message_id: input.source_message_id }
      : {}),
    ...(input.continues === true ? { continues: true } : {}),
    ...(typeof input.card_title === "string"
      ? { card_title: input.card_title }
      : {}),
    ...(input.card_kind === "profile" ? { card_kind: "profile" as const } : {}),
  };
  let total = 0;
  let fragmentBytes = 0;
  const upload = async (
    source: string,
    segment: Json,
    raw = false,
  ): Promise<string> => {
    let snapshot = await regular(source, signal);
    const filename = path.basename(source);
    const format = inferFileMetadata(filename);
    if (
      segment.mode === "document" &&
      format.representation_format !== "markdown"
    )
      throw invalid("mode=document requires a Markdown file.");
    if (segment.type === "fragment") {
      if (snapshot.sizeBytes > 2 * 1024 * 1024)
        throw invalid("Fragments exceed the combined 2 MiB limit.");
      const text = utf8(snapshot.content);
      if (!text.trim()) throw invalid("Fragment content must not be blank.");
      fragmentBytes += snapshot.sizeBytes;
    } else if (
      !raw &&
      segment.type === "document" &&
      segment.mode !== "file" &&
      format.representation_format === "markdown"
    ) {
      utf8(snapshot.content);
      snapshot = await bundleDocumentImages(
        { ...snapshot, filePath: `./playground/${filename}` },
        async (relative, readSignal) => ({
          ...(await regular(
            path.resolve(
              path.dirname(source),
              relative.slice("./playground/".length),
            ),
            readSignal,
          )),
          filePath: relative,
        }),
        signal,
      );
    }
    if (snapshot.sizeBytes > maxFile)
      throw invalid("A resource exceeds 50 MiB.");
    total += snapshot.sizeBytes;
    if (total > 512 * 1024 * 1024) throw invalid("New uploads exceed 512 MiB.");
    if (fragmentBytes > 2 * 1024 * 1024)
      throw invalid("Fragments exceed the combined 2 MiB limit.");
    const upload_id = `upload_${metadata.uploads.length}`;
    metadata.uploads.push({
      upload_id,
      filename,
      ...format,
      size_bytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    });
    contents.set(upload_id, snapshot.content as Uint8Array<ArrayBuffer>);
    return upload_id;
  };
  for (const value of input.message_segments as Json[]) {
    signal.throwIfAborted();
    const segment = { ...value };
    const source = segment["content-path"];
    delete segment["content-path"];
    if (typeof source !== "string") {
      if (segment.type === "fragment") {
        fragmentBytes += Buffer.byteLength(String(segment.content));
        if (fragmentBytes > 2 * 1024 * 1024)
          throw invalid("Fragments exceed the combined 2 MiB limit.");
      }
      metadata.segments.push(segment);
      continue;
    }
    const absolute = path.resolve(canonicalCwd, source);
    publicPath(absolute);
    if (segment.mode === "tree") {
      if (context.target?.type === "task")
        throw invalid("Task targets do not support directory trees.");
      const rootInfo = await lstat(absolute);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw invalid("Tree resources require a local directory.");
      publicPath(await realpath(absolute));
      const root_name = path.basename(absolute);
      if (isExcludedPublicationEntry(root_name))
        throw invalid("Private directories cannot be published.");
      const entries: Json[] = [];
      let count = 0;
      const walk = async (relative: string, depth: number): Promise<void> => {
        if (depth > 32)
          throw invalid("Directory trees exceed the depth limit.");
        const current = path.join(absolute, relative);
        const before = await lstat(current);
        for (const item of (
          await readdir(current, { withFileTypes: true })
        ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
          if (isExcludedPublicationEntry(item.name)) continue;
          const child = relative ? `${relative}/${item.name}` : item.name;
          const full = path.join(absolute, child);
          const info = await lstat(full);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
            throw invalid(
              "Directory trees cannot contain symlinks or special files.",
            );
          if (entries.length >= 10000)
            throw invalid("Directory trees exceed 10000 entries.");
          if (info.isDirectory()) {
            entries.push({ kind: "directory", relative_path: child });
            await walk(child, depth + 1);
          } else {
            count++;
            if (count > 64) throw invalid("Directory trees exceed 64 files.");
            entries.push({
              kind: "file",
              relative_path: child,
              upload_id: await upload(full, segment, true),
            });
          }
        }
        const after = await lstat(current);
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw invalid(
            "Resource directory changed while preparing the message.",
          );
      };
      await walk("", 1);
      if (!count)
        throw invalid("Directory trees must contain at least one file.");
      metadata.segments.push({ ...segment, root_name, entries });
    } else {
      const upload_id = await upload(absolute, segment);
      metadata.segments.push({ ...segment, upload_id });
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > 5 * 1024 * 1024)
    throw invalid("Prepared message metadata exceeds 5 MiB.");
  return metadata;
}
function validateResult(value: unknown, metadata?: Metadata): Json {
  const failure = () =>
    new CliError(
      "invalid_response",
      "TeamHub returned an incomplete or inconsistent message receipt.",
    );
  const keys = (value: Json, allowed: string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  const id = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
  const nonblank = (value: unknown): value is string =>
    typeof value === "string" && Boolean(value.trim());
  const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    !record(value) ||
    !keys(value, [
      "accepted",
      "target",
      "inbox_id",
      "task_id",
      "message_id",
      "resources",
      "duplicate_request",
      "reason",
    ]) ||
    value.accepted !== true ||
    !record(value.target) ||
    !keys(value.target, ["type", "id"]) ||
    !["room", "thread", "task"].includes(String(value.target.type)) ||
    !nonblank(value.target.id) ||
    !id(value.message_id) ||
    !Array.isArray(value.resources) ||
    typeof value.duplicate_request !== "boolean" ||
    (value.duplicate_request === true && !nonblank(value.reason)) ||
    (value.reason !== undefined && !nonblank(value.reason))
  )
    throw failure();
  if (metadata) {
    const actual = metadata.inbox_id.startsWith("room:")
      ? metadata.inbox_id.slice(5)
      : metadata.inbox_id;
    const expectedType = metadata.inbox_id.startsWith("thread:")
      ? "thread"
      : metadata.inbox_id.startsWith("task:")
        ? "task"
        : "room";
    const expectedID =
      expectedType === "room" ? actual : actual.slice(expectedType.length + 1);
    if (value.target.type !== expectedType || value.target.id !== expectedID)
      throw failure();
    const expected = metadata.segments.flatMap((segment, index) =>
      segment.type === "text" || segment.type === "reference" ? [] : [index],
    );
    if (
      JSON.stringify(
        value.resources.map((resource) =>
          record(resource) ? resource.segment_index : undefined,
        ),
      ) !== JSON.stringify(expected)
    )
      throw failure();
  }
  for (const entry of value.resources) {
    if (
      !record(entry) ||
      !integer(entry.segment_index) ||
      !["published", "reused"].includes(String(entry.status))
    )
      throw failure();
    const input = metadata?.segments[entry.segment_index];
    if (entry.kind === "document") {
      if (
        !keys(entry, [
          "kind",
          "segment_index",
          "status",
          "document_id",
          "version_id",
          "revision_id",
          "name",
        ]) ||
        !id(entry.document_id) ||
        !nonblank(entry.name) ||
        (!id(entry.version_id) && !id(entry.revision_id)) ||
        (entry.version_id !== undefined && !id(entry.version_id)) ||
        (entry.revision_id !== undefined && !id(entry.revision_id)) ||
        input?.mode === "tree"
      )
        throw failure();
    } else if (entry.kind === "tree") {
      if (
        !keys(entry, [
          "kind",
          "segment_index",
          "status",
          "publication_group_id",
          "root_placement_path",
          "file_count",
          "directory_count",
          "total_bytes",
          "documents",
          "entry_document_id",
          "entry_document_version_id",
        ]) ||
        !id(entry.publication_group_id) ||
        !nonblank(entry.root_placement_path) ||
        !integer(entry.file_count) ||
        !integer(entry.directory_count) ||
        !integer(entry.total_bytes) ||
        !Array.isArray(entry.documents) ||
        entry.documents.length !== entry.file_count ||
        (entry.entry_document_id === undefined) !==
          (entry.entry_document_version_id === undefined) ||
        (entry.entry_document_id !== undefined &&
          (!id(entry.entry_document_id) ||
            !id(entry.entry_document_version_id)))
      )
        throw failure();
      const paths = new Set<string>();
      for (const document of entry.documents) {
        if (
          !record(document) ||
          !keys(document, [
            "relative_path",
            "document_id",
            "document_version_id",
          ]) ||
          !nonblank(document.relative_path) ||
          paths.has(document.relative_path) ||
          !id(document.document_id) ||
          !id(document.document_version_id)
        )
          throw failure();
        paths.add(document.relative_path);
      }
      if (input) {
        if (input.mode !== "tree" || !Array.isArray(input.entries))
          throw failure();
        const entries = input.entries as Json[];
        const files = entries.filter((item) => item.kind === "file");
        const total = files.reduce(
          (sum, item) =>
            sum +
            metadata.uploads.find(
              (upload) => upload.upload_id === item.upload_id,
            )!.size_bytes,
          0,
        );
        if (
          entry.directory_count !==
            1 + entries.filter((item) => item.kind === "directory").length ||
          entry.total_bytes !== total ||
          JSON.stringify(
            entry.documents.map((item) => (item as Json).relative_path),
          ) !== JSON.stringify(files.map((item) => item.relative_path))
        )
          throw failure();
      }
      if (
        entry.entry_document_id !== undefined &&
        !entry.documents.some(
          (item) =>
            record(item) &&
            item.document_id === entry.entry_document_id &&
            item.document_version_id === entry.entry_document_version_id,
        )
      )
        throw failure();
    } else throw failure();
  }
  return value;
}
export async function executeMessageSend(
  input: Json,
  context: CommandExecutionContext,
): Promise<Json> {
  const operationId = context.operationId;
  if (!operationId)
    throw new CliError(
      "invalid_input",
      "A message send needs an operation ID.",
    );
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const metadata = await prepare(
    input,
    context,
    operationId,
    contents,
    new AbortController().signal,
  );
  const body = new FormData();
  body.append("metadata", JSON.stringify(metadata));
  for (const upload of metadata.uploads)
    body.append(
      "file",
      new Blob([contents.get(upload.upload_id)!]),
      upload.upload_id,
    );
  const response = await context.client.request(
    "/api/agent/v1/messages/commit",
    {
      method: "POST",
      headers: { "x-teamhub-operation-id": operationId },
      body,
    },
  );
  return validateResult(await readJson(response), metadata);
}
