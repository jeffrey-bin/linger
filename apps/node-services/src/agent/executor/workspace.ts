import {
  type ExecutionContextKey,
  type ExecutionContextRef,
  type SharedTaskScope,
  encodeExecutionContextRef,
} from "./context-ref.js";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createAgentLogger,
  type AgentLogger,
} from "../observability/agent-log.js";
import { isNodeError } from "@linger/service-kit";
import type { DocumentInputContent } from "./teamhub-context-resolvers.js";

export interface AgentContextRoots {
  readonly agentRoot: string;
  readonly documentProjectionRoot: string;
  readonly playgroundRoot: string;
  readonly metaPlaygroundRoot: string;
  readonly alterEgoPlaygroundRoot: string;
}

export type RuntimeViewMappingKind = "inbox_view" | "memory" | "playground";

export interface RuntimeViewMapping {
  readonly kind: RuntimeViewMappingKind;
  readonly sourcePath: string;
  readonly fileLinkRootPaths?: readonly string[];
  readonly targetPath: string;
  readonly access: "read_only" | "read_write";
}

export interface RuntimeViewPlan {
  readonly ref: ExecutionContextRef;
  readonly contextKey: ExecutionContextKey;
  readonly playgroundRootPath?: string;
  readonly mappings: readonly RuntimeViewMapping[];
  /** The Runner links `playground/<taskId>` to this shared Task directory. */
  readonly sharedTaskScope?: SharedTaskScope;
}

export interface StagedDocumentProjection {
  readonly mapping: RuntimeViewMapping;
  activate(): Promise<RuntimeViewMapping>;
  discard(): Promise<void>;
  release(): Promise<void>;
}

export interface AgentContextHost {
  ensureAgentRoots(agentId: string): Promise<AgentContextRoots>;
  stageDocumentProjection(input: {
    readonly agentId: string;
    readonly runtimeInstanceKey: string;
    readonly documentComment: {
      readonly commentsMarkdown: string;
      readonly currentDocument: DocumentInputContent;
    };
  }): Promise<StagedDocumentProjection>;
  prepareRuntimeView(
    ref: ExecutionContextRef,
    sharedTaskScope?: SharedTaskScope,
  ): Promise<RuntimeViewPlan>;
  releaseRuntimeView(ref: ExecutionContextRef): Promise<void>;
}

const RUNTIME_WORKSPACE = "/workspace";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DOCUMENT_AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export interface CreateAgentContextHostOptions {
  readonly logger?: AgentLogger;
  readonly rootPath: string;
}

export const createAgentContextHost = async (
  options: CreateAgentContextHostOptions,
): Promise<AgentContextHost> => {
  if (options.rootPath.trim() === "") {
    throw new Error("Agent Context root path is required");
  }
  await mkdir(path.resolve(options.rootPath), { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(path.resolve(options.rootPath));
  return new FileSystemAgentContextHost(
    canonicalRoot,
    options.logger ?? createAgentLogger({ component: "context-host" }),
  );
};

class FileSystemAgentContextHost implements AgentContextHost {
  private readonly roots = new Map<string, AgentContextRoots>();
  private readonly agentTails = new Map<string, Promise<void>>();

  constructor(
    private readonly contextRoot: string,
    private readonly logger: AgentLogger,
  ) {}

  async ensureAgentRoots(agentId: string): Promise<AgentContextRoots> {
    assertSafeId(agentId, "agentId");
    const cached = this.roots.get(agentId);
    if (cached) return cached;

    return this.withTail(this.agentTails, agentId, async () => {
      const existing = this.roots.get(agentId);
      if (existing) return existing;

      const agentRoot = await ensureOwnedDirectory(
        this.contextRoot,
        path.join(this.contextRoot, agentId),
      );
      const documentProjectionRoot = await ensureOwnedDirectory(
        agentRoot,
        path.join(agentRoot, "document-projections"),
      );
      const playgroundRoot = await ensureOwnedDirectory(
        agentRoot,
        path.join(agentRoot, "playground"),
      );
      const sharedPlaygroundRoot = await ensureOwnedDirectory(
        playgroundRoot,
        path.join(playgroundRoot, "shared"),
      );
      const result: AgentContextRoots = {
        agentRoot,
        documentProjectionRoot,
        playgroundRoot,
        metaPlaygroundRoot: sharedPlaygroundRoot,
        alterEgoPlaygroundRoot: sharedPlaygroundRoot,
      };
      this.roots.set(agentId, result);
      return result;
    });
  }

  async stageDocumentProjection(input: {
    readonly agentId: string;
    readonly runtimeInstanceKey: string;
    readonly documentComment: Parameters<
      AgentContextHost["stageDocumentProjection"]
    >[0]["documentComment"];
  }): Promise<StagedDocumentProjection> {
    assertSafeId(input.agentId, "agentId");
    if (
      input.runtimeInstanceKey.trim() === "" ||
      input.runtimeInstanceKey.length > 1024
    ) {
      throw new TypeError("Document projection authority is invalid");
    }
    const { commentsMarkdown, currentDocument } = input.documentComment;
    assertDocumentAuthorityId(
      currentDocument.documentId,
      "currentDocument.documentId",
    );
    if (
      commentsMarkdown.length < 1 ||
      commentsMarkdown.length > 4 * 1024 * 1024 ||
      !validDocumentFilename(currentDocument.filename) ||
      currentDocument.mediaType !== "text/markdown" ||
      !(currentDocument.bytes instanceof Uint8Array) ||
      !SHA256.test(currentDocument.sha256) ||
      createHash("sha256").update(currentDocument.bytes).digest("hex") !==
        currentDocument.sha256
    ) {
      throw new TypeError("Document Comment projection is invalid");
    }
    if (path.extname(currentDocument.filename).toLowerCase() !== ".md") {
      throw new Error(
        "Current Document projection filename must use the .md extension",
      );
    }
    const currentDocumentBytes = new Uint8Array(currentDocument.bytes);

    const roots = await this.ensureAgentRoots(input.agentId);
    const viewId = createHash("sha256")
      .update(input.runtimeInstanceKey)
      .digest("hex");
    const viewRoot = await ensureOwnedDirectory(
      roots.documentProjectionRoot,
      path.join(roots.documentProjectionRoot, viewId),
    );
    const stateRoot = await ensureOwnedDirectory(
      viewRoot,
      path.join(viewRoot, "state-root"),
    );
    const scopeRoot = await ensureOwnedDirectory(
      stateRoot,
      path.join(stateRoot, currentDocument.documentId),
    );
    const mapping: RuntimeViewMapping = Object.freeze({
      kind: "inbox_view",
      sourcePath: scopeRoot,
      targetPath: path.posix.join(
        RUNTIME_WORKSPACE,
        currentDocument.documentId,
      ),
      access: "read_only",
    });
    let released = false;
    const activate = (): Promise<RuntimeViewMapping> =>
      this.withTail(this.agentTails, input.agentId, async () => {
        if (released) throw new Error("Document projection stage is released");
        await atomicWriteFile(
          path.join(scopeRoot, currentDocument.filename),
          currentDocumentBytes,
        );
        await atomicWriteFile(
          path.join(scopeRoot, "comments.md"),
          commentsMarkdown,
        );
        for (const entry of await readdir(scopeRoot, { withFileTypes: true })) {
          if (
            entry.name === currentDocument.filename ||
            entry.name === "comments.md"
          ) {
            continue;
          }
          await rm(path.join(scopeRoot, entry.name), {
            recursive: true,
            force: true,
          });
        }
        return mapping;
      });
    const release = (): Promise<void> =>
      this.withTail(this.agentTails, input.agentId, async () => {
        released = true;
      });
    return Object.freeze({ mapping, activate, discard: release, release });
  }

  async prepareRuntimeView(
    ref: ExecutionContextRef,
    sharedTaskScope?: SharedTaskScope,
  ): Promise<RuntimeViewPlan> {
    assertSafeId(ref.agentId, "agentId");
    const contextKey = encodeExecutionContextRef(ref);
    const logger = this.logger.child({
      agentId: ref.agentId,
      contextKey,
      contextKind: ref.kind,
    });
    const startedAt = Date.now();
    const roots = await this.ensureAgentRoots(ref.agentId);
    try {
      const plan = await this.withTail(
        this.agentTails,
        ref.agentId,
        async () => {
          // Memory writes this projection only for an Another Me.
          const memoryMarker = path.join(roots.agentRoot, "memory.revision");
          const memoryRoot = await publishedProjection(
            roots.agentRoot,
            memoryMarker,
          );
          const mappings: RuntimeViewMapping[] = [];
          if (ref.kind === "document") {
            const viewId = createHash("sha256")
              .update(contextKey)
              .digest("hex");
            const sourcePath = path.join(
              roots.documentProjectionRoot,
              viewId,
              "state-root",
              ref.documentId,
            );
            const metadata = await lstat(path.join(sourcePath, "comments.md"));
            if (!metadata.isFile() || metadata.isSymbolicLink())
              throw new Error("Document Comment has no canonical projection");
            mappings.push({
              kind: "inbox_view",
              sourcePath,
              fileLinkRootPaths: [roots.agentRoot],
              targetPath: path.posix.join(RUNTIME_WORKSPACE, ref.documentId),
              access: "read_only",
            });
          }
          if (memoryRoot) {
            mappings.push({
              kind: "memory",
              sourcePath: memoryRoot,
              targetPath: path.posix.join(RUNTIME_WORKSPACE, "memory"),
              access: "read_only",
            });
          }
          const playgroundSourcePath = roots.metaPlaygroundRoot;
          // A shared Task directory is linked by the Runner; its files never
          // pass through this snapshot.
          const scopeId =
            ref.kind === "alter_ego"
              ? sharedTaskScope
                ? null
                : ref.taskId
              : ref.kind === "document"
                ? ref.documentId
                : ref.roomId;
          if (scopeId) {
            await ensureOwnedDirectory(
              playgroundSourcePath,
              path.join(playgroundSourcePath, scopeId),
            );
          }
          mappings.push({
            kind: "playground",
            sourcePath: playgroundSourcePath,
            targetPath: path.posix.join(RUNTIME_WORKSPACE, "playground"),
            access: "read_write",
          });

          return {
            ref,
            contextKey,
            playgroundRootPath: roots.metaPlaygroundRoot,
            mappings,
            ...(sharedTaskScope ? { sharedTaskScope } : {}),
          };
        },
      );
      logger.log("info", "context_host.runtime_view_prepared", {
        durationMs: Date.now() - startedAt,
        mappingCount: plan.mappings.length,
      });
      return plan;
    } catch (error) {
      logger.log("error", "context_host.runtime_view_failed", {
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  async releaseRuntimeView(ref: ExecutionContextRef): Promise<void> {
    assertSafeId(ref.agentId, "agentId");
    await this.ensureAgentRoots(ref.agentId);
  }

  private async withTail<T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  }
}

const assertSafeId = (value: string, name: string): void => {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${name} must be a canonical path-safe opaque ID`);
  }
};

const ensureOwnedDirectory = async (
  canonicalParent: string,
  candidate: string,
): Promise<string> => {
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  return ownedDirectory(canonicalParent, candidate);
};

/** The canonical path of a real directory inside its parent. */
const ownedDirectory = async (
  canonicalParent: string,
  candidate: string,
): Promise<string> => {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Agent Context path must be a real directory");
  }
  const canonical = await realpath(candidate);
  const relative = path.relative(canonicalParent, canonical);
  if (relative === "" && canonical !== canonicalParent) {
    throw new Error("Agent Context directory identity is invalid");
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent Context directory resolved outside its root");
  }
  return canonical;
};

/** The Memory projection directory once Memory has published it: its marker exists. */
const publishedProjection = async (
  agentRoot: string,
  markerPath: string,
): Promise<string | undefined> => {
  try {
    await lstat(markerPath);
    return await ownedDirectory(agentRoot, path.join(agentRoot, "memory"));
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
};

const assertDocumentAuthorityId = (value: string, label: string): void => {
  if (!DOCUMENT_AUTHORITY_ID.test(value)) {
    throw new TypeError(`${label} must be a canonical Document authority ID`);
  }
};

const validDocumentFilename = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 255 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("\u0000") &&
  !value.includes("/") &&
  !value.includes("\\");

const atomicWriteFile = async (
  destination: string,
  content: string | Uint8Array,
): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};
