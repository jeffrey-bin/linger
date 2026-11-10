import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import {
  extractDocumentImages,
  DocumentImageError,
} from "@linger/document-files";

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class TeamHubFileError extends Error {
  override readonly name = "TeamHubFileError";
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

export interface TeamHubFileBase {
  readonly documentId: string;
  readonly versionId: string;
  readonly name: string;
  readonly sha256: string;
  readonly readOnly: boolean;
  readonly format?: "markdown" | "html" | "blocks";
  readonly historyEntryId?: string;
  readonly linkToken?: string;
}

export interface TeamHubWorkspaceFiles {
  normalize(filePath: string): string;
  inspect(filePath: string): Promise<{ sha256: string } | null>;
  read(
    filePath: string,
  ): Promise<Readonly<{ content: Uint8Array; sha256: string }> | null>;
  install(
    filePath: string,
    content: Uint8Array,
    expectedSHA256: string | null,
  ): Promise<void>;
}

export interface TeamHubWorkingCopyStateFiles {
  readonly key: string;
  ensure(): Promise<void>;
  read(filename: string, limit: number): Promise<Uint8Array | null>;
  write(filename: string, content: Uint8Array): Promise<void>;
}

export interface TeamHubFileBackend {
  download(
    name: string,
    format?: "markdown" | "html" | "blocks",
  ): Promise<TeamHubFileBase & { content: Uint8Array }>;
  replace(input: {
    operationId: string;
    documentId: string;
    baseVersionId: string;
    format: "html" | "blocks";
    name: string;
    content: Uint8Array;
    sha256: string;
  }): Promise<PublicationResult>;
}

type PublicationResult = TeamHubFileBase & { unchanged: boolean };

// One signed record per working-copy path holds the base it was downloaded
// from. It records file identity, never access rights: TeamHub rechecks
// authorization and CAS when it commits a replacement, and a lost response
// leaves the old base so a retry fails its CAS instead of overwriting.
export class TeamHubWorkingCopies {
  readonly #stateFiles: TeamHubWorkingCopyStateFiles;
  readonly #stateBinding: string;
  readonly #integrityKey: string;
  readonly #files: TeamHubWorkspaceFiles;
  readonly #backend: TeamHubFileBackend;

  constructor(input: {
    stateFiles: TeamHubWorkingCopyStateFiles;
    stateBinding: string;
    integrityKey: string;
    files: TeamHubWorkspaceFiles;
    backend: TeamHubFileBackend;
  }) {
    if (!input.stateBinding || input.integrityKey.length < 16)
      throw new TypeError("TeamHub working-copy state binding is invalid");
    this.#stateFiles = input.stateFiles;
    this.#stateBinding = input.stateBinding;
    this.#integrityKey = input.integrityKey;
    this.#files = input.files;
    this.#backend = input.backend;
  }

  async get(
    name: string,
    targetPath: string,
    format?: "markdown" | "html" | "blocks",
    raw = false,
  ): Promise<TeamHubFileBase> {
    const filePath = this.#files.normalize(targetPath);
    const current = await this.#files.inspect(filePath);
    const previous = await this.#readBase(filePath);
    if (current && current.sha256 !== previous?.sha256) {
      throw new TeamHubFileError(
        "file_exists",
        "Local file has changes; preserve or move it before retrying",
      );
    }
    const downloaded = await this.#backend.download(name, format);
    verifyContent(downloaded.content, downloaded.sha256);
    if (!isBase(downloaded)) throw stateError();
    let content = downloaded.content;
    if (
      !raw &&
      (format === undefined || format === "markdown") &&
      /\.(md|markdown)$/iu.test(downloaded.name)
    ) {
      const extracted = imageOperation(() =>
        extractDocumentImages({
          filePath,
          content,
          sha256: downloaded.sha256,
          sizeBytes: content.length,
        }),
      );
      await mapConcurrent([...extracted.files], async ([relative, image]) => {
        const imagePath = path.posix.join(
          path.posix.dirname(filePath),
          relative,
        );
        const existing = await this.#files.inspect(imagePath);
        if (existing && existing.sha256 !== sha(image))
          throw new TeamHubFileError(
            "file_exists",
            "Downloaded image path has local changes; preserve or move it before retrying",
          );
        if (!existing) {
          try {
            await this.#files.install(imagePath, image, null);
          } catch (error) {
            // Two files may share an extracted image. Accept only identical
            // bytes installed by the other operation, never overwrite edits.
            if (
              !(error instanceof TeamHubFileError) ||
              error.code !== "file_changed" ||
              (await this.#files.inspect(imagePath))?.sha256 !== sha(image)
            )
              throw error;
          }
        }
      });
      content = extracted.content;
    }
    const base = {
      ...baseOnly(downloaded),
      format: format ?? "markdown",
      sha256: sha(content),
    };
    await this.#files.install(filePath, content, current?.sha256 ?? null);
    const installed = await this.#files.inspect(filePath);
    if (!installed || installed.sha256 !== base.sha256) {
      throw new TeamHubFileError(
        "file_changed",
        "Downloaded file changed before its base could be recorded",
      );
    }
    await this.#writeBase(filePath, base);
    return base;
  }

  /** Replace the body of a native Document previously downloaded to targetPath. */
  async replace(
    documentId: string,
    targetPath: string,
  ): Promise<PublicationResult> {
    const filePath = this.#files.normalize(targetPath);
    const base = await this.#readBase(filePath);
    if (!documentId || !base || base.documentId !== documentId)
      throw new TeamHubFileError(
        "invalid_input",
        "Download this Document to the supplied path before replacing it",
      );
    if (
      !base.readOnly ||
      (base.format !== "html" && base.format !== "blocks") ||
      base.linkToken
    )
      throw new TeamHubFileError(
        "invalid_input",
        "Download this native Document with --format blocks before replacing its body",
      );
    let current = await this.#files.read(filePath);
    if (!current)
      throw new TeamHubFileError("not_found", "Local file does not exist");
    verifyContent(current.content, current.sha256);
    if (current.sha256 === base.sha256) return { ...base, unchanged: true };
    if (base.format === "blocks") {
      const normalized = prepareBlocksWorkingCopy(current.content);
      if (normalized) {
        await this.#files.install(filePath, normalized, current.sha256);
        current = { content: normalized, sha256: sha(normalized) };
      }
    }
    const result = await this.#backend.replace({
      // Derived from the replacement itself, so running the same command
      // again after an unknown outcome replays TeamHub's original result,
      // while an edited file is a new operation that TeamHub's CAS settles.
      operationId: `docs-replace:${sha(
        Buffer.from(
          [base.documentId, base.versionId, base.format, current.sha256].join(
            "\u0000",
          ),
        ),
      )}`,
      documentId: base.documentId,
      baseVersionId: base.versionId,
      name: base.name,
      format: base.format,
      content: current.content,
      sha256: current.sha256,
    });
    if (
      !isBase(result) ||
      result.sha256 !== current.sha256 ||
      result.readOnly !== true ||
      typeof result.unchanged !== "boolean" ||
      result.documentId !== base.documentId
    ) {
      throw new TeamHubFileError(
        "invalid_response",
        "Publication response does not match the submitted file",
      );
    }
    await this.#writeBase(filePath, {
      ...baseOnly(result),
      format: base.format,
    });
    return result;
  }

  async #readBase(filePath: string): Promise<TeamHubFileBase | undefined> {
    await this.#stateFiles.ensure();
    let content: Uint8Array | null;
    try {
      content = await this.#stateFiles.read(recordName(filePath), 1 << 20);
    } catch {
      throw stateError();
    }
    if (!content) return undefined;
    try {
      const value: unknown = JSON.parse(Buffer.from(content).toString());
      if (
        !record(value) ||
        value.version !== 1 ||
        value.binding !== this.#stateBinding ||
        value.filePath !== filePath ||
        !isBase(value.base) ||
        !digest(value.signature) ||
        !validSignature(
          value.signature,
          this.#integrityKey,
          recordBody(this.#stateBinding, filePath, value.base),
        )
      )
        throw stateError();
      return value.base;
    } catch {
      throw stateError();
    }
  }

  async #writeBase(filePath: string, base: TeamHubFileBase): Promise<void> {
    await this.#stateFiles.ensure();
    const body = recordBody(this.#stateBinding, filePath, base);
    await this.#stateFiles.write(
      recordName(filePath),
      Buffer.from(
        JSON.stringify({
          version: 1,
          binding: this.#stateBinding,
          filePath,
          base,
          signature: createHmac("sha256", this.#integrityKey)
            .update(body)
            .digest("hex"),
        }),
      ),
    );
  }
}

function verifyContent(content: Uint8Array, expected: string) {
  if (content.byteLength > MAX_FILE_BYTES)
    throw new TeamHubFileError("too_large", "File exceeds 50 MiB");
  if (createHash("sha256").update(content).digest("hex") !== expected) {
    throw new TeamHubFileError(
      "content_mismatch",
      "File content does not match its digest",
    );
  }
}
const stateError = () =>
  new TeamHubFileError(
    "state_unavailable",
    "Host working-copy state is missing or corrupt; publication stopped",
  );
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isBase = (value: unknown): value is TeamHubFileBase =>
  record(value) &&
  nonempty(value.documentId) &&
  nonempty(value.versionId) &&
  nonempty(value.name) &&
  digest(value.sha256) &&
  typeof value.readOnly === "boolean" &&
  (value.format === undefined ||
    value.format === "markdown" ||
    value.format === "html" ||
    value.format === "blocks") &&
  (value.linkToken === undefined ||
    (typeof value.linkToken === "string" &&
      /^doc_link_[A-Za-z0-9_-]{43}$/.test(value.linkToken)));
const baseOnly = (base: TeamHubFileBase): TeamHubFileBase => ({
  documentId: base.documentId,
  versionId: base.versionId,
  name: base.name,
  sha256: base.sha256,
  readOnly: base.readOnly,
  ...(base.format ? { format: base.format } : {}),
  ...(base.historyEntryId ? { historyEntryId: base.historyEntryId } : {}),
  ...(base.linkToken ? { linkToken: base.linkToken } : {}),
});
const sha = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex");
function imageOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DocumentImageError)
      throw new TeamHubFileError(error.code, error.message);
    throw error;
  }
}

const recordName = (filePath: string) =>
  `${createHash("sha256").update(filePath).digest("hex")}.json`;
const recordBody = (
  binding: string,
  filePath: string,
  base: TeamHubFileBase,
): string => JSON.stringify({ version: 1, binding, filePath, base });
function validSignature(signature: string, key: string, body: string) {
  const expected = createHmac("sha256", key).update(body).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function mapConcurrent<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
) {
  let next = 0;
  let failed = false;
  // Drain in-flight work before reporting a failure.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]!;
        try {
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}

// Only identity preparation belongs to Host. Runtime validates the native schema.
function prepareBlocksWorkingCopy(content: Uint8Array): Uint8Array | undefined {
  const invalid = () =>
    new TeamHubFileError(
      "invalid_input",
      "Use a blocks working copy with schema_version: 1 and a nonempty blocks array; every existing block keeps its ID",
    );
  if (content.byteLength > 1 << 20) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    );
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const copy = value as Record<string, unknown>;
  if (
    copy.schema_version !== 1 ||
    Object.keys(copy).some((k) => k !== "schema_version" && k !== "blocks") ||
    !Array.isArray(copy.blocks) ||
    !copy.blocks.length
  )
    throw invalid();
  const seen = new Set<string>();
  let changed = false;
  const pending: unknown[] = [...copy.blocks];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== "object" || Array.isArray(next))
      throw invalid();
    const block = next as Record<string, unknown>;
    if (block.id === undefined) {
      block.id = randomUUID();
      changed = true;
    }
    if (
      typeof block.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(block.id) ||
      seen.has(block.id)
    )
      throw invalid();
    seen.add(block.id);
    if (block.children !== undefined) {
      if (!Array.isArray(block.children)) throw invalid();
      pending.push(...block.children);
    }
  }
  if (!changed) return undefined;
  const prepared = Buffer.from(JSON.stringify(copy, null, 2) + "\n");
  if (prepared.byteLength > 1 << 20) throw invalid();
  return prepared;
}
