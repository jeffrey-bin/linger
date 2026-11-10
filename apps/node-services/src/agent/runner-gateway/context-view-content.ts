import { createHmac, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { SharedTaskScope } from "@linger/wire-contracts/runner-gateway/types";
import { mediaTypeForExtension } from "@linger/document-files/media-type";
import { sha256Hex } from "@linger/service-kit/node";

import type { RuntimeViewPlan } from "../executor/workspace.js";
import { sharedTaskScopeWire } from "./shared-task-scope.js";

const RUNTIME_WORKSPACE = "/workspace";
const MAX_FILE_COUNT = 10_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const SOURCE_DIGEST_CACHE_LIMIT = 200_000;
// A source modified this close to its recorded read may change again within
// timestamp granularity, so its digest is never trusted without a reread.
const RACY_SOURCE_WINDOW_NS = 2_000_000_000n;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

// The shapes of the ContextViewManifest definition in
// contracts/runner-gateway/envelope.schema.json. The manifest is served over
// HTTP rather than sent in an envelope, so the envelope type generator does not
// emit it; tests validate these values against that definition.
export interface ContextViewFile {
  readonly relative_path: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly executable?: true;
}

export interface ContextViewMapping {
  readonly kind: "inbox_view" | "memory" | "playground";
  readonly target_path: string;
  readonly access: "read_only" | "read_write";
  readonly files: readonly ContextViewFile[];
}

export interface ContextViewSkill {
  readonly package_name: string;
  readonly manifest_id: string;
  readonly package_sha256: string;
}

export interface ContextViewManifest {
  readonly version: 1;
  readonly execution_context_key: string;
  readonly runtime_instance_id: string;
  readonly shared_task_scope?: SharedTaskScope;
  readonly mappings: readonly ContextViewMapping[];
  readonly skills: readonly ContextViewSkill[];
}

/** A Context View published for one Computer until released. */
export interface ContextViewSnapshot {
  readonly viewDigest: string;
  release(): void;
}

export interface ContextViewSnapshotInput {
  readonly computerId: string;
  readonly plan: RuntimeViewPlan;
  readonly runtimeInstanceId: string;
  readonly skills: readonly ContextViewSkill[];
  readonly signal: AbortSignal;
}

/**
 * Serves Context View content to the Computer that runs the Context. A View is
 * named by the SHA-256 of its manifest bytes; the Computer fetches the manifest
 * and only the files it lacks, and verifies every file it writes. Files are
 * read from their source when requested, so a source that changed since the
 * snapshot is refused and the next snapshot names the new content.
 */
export interface ContextViewContent {
  snapshot(input: ContextViewSnapshotInput): Promise<ContextViewSnapshot>;
  /** Base URL handed to a Computer for the life of one connection. */
  contentUrl(computerId: string, connectionEpoch: number): string;
  handle(
    token: string,
    kind: string,
    id: string,
    request: Request,
  ): Promise<Response>;
}

interface PublishedFile {
  readonly sourcePath: string;
  readonly sizeBytes: number;
}

interface PublishedView {
  readonly manifest: Uint8Array;
  readonly files: ReadonlyMap<string, PublishedFile>;
  holders: number;
}

interface SourceDigest {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
  readonly executable: boolean;
}

export function createContextViewContent(options: {
  readonly publicOrigin: string;
  readonly signingKey: string;
  /** Content is served only on the Computer's current connection. */
  readonly isCurrentConnection: (
    computerId: string,
    connectionEpoch: number,
  ) => boolean;
}): ContextViewContent {
  const publicOrigin = new URL(options.publicOrigin).origin;
  if (Buffer.byteLength(options.signingKey) < 32)
    throw new TypeError(
      "Context content signing key must be at least 32 bytes",
    );
  const published = new Map<string, Map<string, PublishedView>>();
  const digests = new Map<string, SourceDigest>();

  const sign = (payload: string): string =>
    createHmac("sha256", options.signingKey)
      .update(`context-content\n${payload}`)
      .digest("base64url");

  const authorize = (
    token: string,
  ): { readonly computerId: string } | undefined => {
    if (!TOKEN.test(token)) return undefined;
    const [payload = "", signature = ""] = token.split(".");
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return undefined;
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (
      typeof claims !== "object" ||
      claims === null ||
      typeof (claims as { c?: unknown }).c !== "string" ||
      !Number.isSafeInteger((claims as { e?: unknown }).e)
    )
      return undefined;
    const { c: computerId, e: connectionEpoch } = claims as {
      c: string;
      e: number;
    };
    return options.isCurrentConnection(computerId, connectionEpoch)
      ? { computerId }
      : undefined;
  };

  const digestFile = async (
    sourcePath: string,
    relativePath: string,
  ): Promise<SourceDigest> => {
    const before = await lstat(sourcePath, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
      throw new Error(`Context View file is invalid: ${relativePath}`);
    const cached = digests.get(sourcePath);
    if (
      cached &&
      sameSource(cached, before) &&
      BigInt(Date.now()) * 1_000_000n - latestChangeNs(before) >=
        RACY_SOURCE_WINDOW_NS
    )
      return cached;
    const content = await readStable(sourcePath, relativePath);
    const digest: SourceDigest = {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: sha256Hex(content.bytes),
      executable: (Number(content.stats.mode) & 0o111) !== 0,
    };
    if (sameSource(digest, content.stats)) {
      if (digests.size >= SOURCE_DIGEST_CACHE_LIMIT) digests.clear();
      digests.set(sourcePath, digest);
    }
    return digest;
  };

  return {
    async snapshot(input) {
      const files = new Map<string, PublishedFile>();
      const claimed = new Map<string, string>();
      const budget = { fileCount: 0, totalBytes: 0 };
      const targets = input.plan.mappings.map((mapping) =>
        relativeRuntimeTarget(mapping.targetPath),
      );
      const mappings: ContextViewMapping[] = [];
      for (const mapping of input.plan.mappings) {
        input.signal.throwIfAborted();
        const targetPath = relativeRuntimeTarget(mapping.targetPath);
        const nested = targets.flatMap((candidate) =>
          candidate.startsWith(`${targetPath}/`)
            ? [candidate.slice(targetPath.length + 1)]
            : [],
        );
        const mappingFiles: ContextViewFile[] = [];
        for await (const source of walkDirectory({
          root: await realDirectory(mapping.sourcePath),
          relativeRoot: "",
          skip: nested,
          fileLinkRoots: mapping.fileLinkRootPaths
            ? await Promise.all(
                mapping.fileLinkRootPaths.map((root) => realpath(root)),
              )
            : undefined,
          signal: input.signal,
        })) {
          const digest = await digestFile(
            source.sourcePath,
            source.relativePath,
          );
          const joined = path.posix.join(targetPath, source.relativePath);
          const existing = claimed.get(joined);
          if (existing !== undefined) {
            if (existing !== digest.sha256)
              throw new Error("Context View maps multiple files to one path");
            continue;
          }
          claimed.set(joined, digest.sha256);
          budget.fileCount += 1;
          budget.totalBytes += Number(digest.size);
          if (
            budget.fileCount > MAX_FILE_COUNT ||
            budget.totalBytes > MAX_TOTAL_BYTES
          )
            throw new Error("Context View exceeds its file limits");
          files.set(digest.sha256, {
            sourcePath: source.sourcePath,
            sizeBytes: Number(digest.size),
          });
          mappingFiles.push({
            relative_path: source.relativePath,
            media_type:
              mediaTypeForExtension(
                path.posix.extname(source.relativePath).slice(1),
              ) ?? "application/octet-stream",
            size_bytes: Number(digest.size),
            sha256: digest.sha256,
            ...(digest.executable ? { executable: true } : {}),
          });
        }
        mappingFiles.sort((left, right) =>
          left.relative_path < right.relative_path ? -1 : 1,
        );
        mappings.push({
          kind: mapping.kind,
          target_path: targetPath,
          access: mapping.access,
          files: mappingFiles,
        });
      }
      const manifest: ContextViewManifest = {
        version: 1,
        execution_context_key: input.plan.contextKey,
        runtime_instance_id: input.runtimeInstanceId,
        ...sharedTaskScopeWire(input.plan.sharedTaskScope),
        mappings,
        skills: [...input.skills].sort((left, right) =>
          left.package_name < right.package_name ? -1 : 1,
        ),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      const viewDigest = sha256Hex(bytes);
      input.signal.throwIfAborted();
      let views = published.get(input.computerId);
      if (!views) {
        views = new Map();
        published.set(input.computerId, views);
      }
      const view = views.get(viewDigest) ?? {
        manifest: bytes,
        files,
        holders: 0,
      };
      view.holders += 1;
      views.set(viewDigest, view);
      let released = false;
      return Object.freeze({
        viewDigest,
        release() {
          if (released) return;
          released = true;
          view.holders -= 1;
          if (view.holders > 0) return;
          const current = published.get(input.computerId);
          if (current?.get(viewDigest) !== view) return;
          current.delete(viewDigest);
          if (current.size === 0) published.delete(input.computerId);
        },
      });
    },
    contentUrl(computerId, connectionEpoch) {
      const payload = Buffer.from(
        JSON.stringify({ c: computerId, e: connectionEpoch }),
      ).toString("base64url");
      return `${publicOrigin}/v1/context-content/${payload}.${sign(payload)}`;
    },
    async handle(token, kind, id, request) {
      if (request.method !== "GET") return notFound();
      const principal = authorize(token);
      if (!principal || !SHA256.test(id)) return notFound();
      const views = published.get(principal.computerId);
      if (kind === "views") {
        const view = views?.get(id);
        if (!view) return notFound();
        return new Response(new Uint8Array(view.manifest), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
      if (kind !== "files") return notFound();
      let file: PublishedFile | undefined;
      for (const view of views?.values() ?? []) {
        file = view.files.get(id);
        if (file) break;
      }
      if (!file) return notFound();
      let bytes: Buffer;
      try {
        bytes = (await readStable(file.sourcePath, id)).bytes;
      } catch {
        return changed();
      }
      // The source changed after the snapshot; the next one names its content.
      if (bytes.byteLength !== file.sizeBytes || sha256Hex(bytes) !== id)
        return changed();
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    },
  };
}

interface SourceFile {
  readonly relativePath: string;
  readonly sourcePath: string;
}

async function* walkDirectory(options: {
  readonly root: string;
  readonly relativeRoot: string;
  readonly skip: readonly string[];
  readonly fileLinkRoots?: readonly string[];
  readonly signal: AbortSignal;
}): AsyncGenerator<SourceFile> {
  const directory = options.relativeRoot
    ? path.join(options.root, ...options.relativeRoot.split("/"))
    : options.root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    options.signal.throwIfAborted();
    const relativePath = options.relativeRoot
      ? `${options.relativeRoot}/${entry.name}`
      : entry.name;
    if (
      options.skip.some(
        (prefix) =>
          relativePath === prefix || relativePath.startsWith(`${prefix}/`),
      )
    )
      continue;
    const absolutePath = path.join(directory, entry.name);
    let sourcePath = absolutePath;
    let metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      if (!options.fileLinkRoots)
        throw new TypeError(
          `Context View source contains a symlink: ${relativePath}`,
        );
      sourcePath = await realpath(absolutePath);
      metadata = await lstat(sourcePath);
      if (
        !options.fileLinkRoots.some((root) => isWithin(root, sourcePath)) ||
        !metadata.isFile()
      )
        throw new TypeError(
          `Context View source contains an invalid file link: ${relativePath}`,
        );
    }
    if (metadata.isDirectory()) {
      yield* walkDirectory({ ...options, relativeRoot: relativePath });
      continue;
    }
    if (!metadata.isFile())
      throw new TypeError(
        `Context View source contains a non-file: ${relativePath}`,
      );
    yield { relativePath, sourcePath };
  }
}

async function readStable(
  sourcePath: string,
  label: string,
): Promise<{ readonly bytes: Buffer; readonly stats: BigIntStats }> {
  const handle = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
      throw new Error(`Context View file is invalid: ${label}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameSourceStats(before, after) ||
      BigInt(bytes.byteLength) !== after.size
    )
      throw new Error(`Context View source changed while reading: ${label}`);
    return { bytes, stats: after };
  } finally {
    await handle.close();
  }
}

async function realDirectory(sourcePath: string): Promise<string> {
  const root = await realpath(sourcePath);
  const metadata = await lstat(root);
  if (!metadata.isDirectory())
    throw new TypeError("Context View source must resolve to a real directory");
  return root;
}

function relativeRuntimeTarget(targetPath: string): string {
  const relative = path.posix.relative(RUNTIME_WORKSPACE, targetPath);
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative))
    throw new TypeError(
      `Context View target is outside the workspace: ${targetPath}`,
    );
  return relative;
}

function sameSource(
  digest: Pick<SourceDigest, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
  stats: BigIntStats,
): boolean {
  return (
    digest.dev === stats.dev &&
    digest.ino === stats.ino &&
    digest.size === stats.size &&
    digest.mtimeNs === stats.mtimeNs &&
    digest.ctimeNs === stats.ctimeNs
  );
}

function sameSourceStats(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function latestChangeNs(stats: BigIntStats): bigint {
  return stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

function changed(): Response {
  return new Response(null, {
    status: 409,
    headers: { "cache-control": "no-store" },
  });
}
