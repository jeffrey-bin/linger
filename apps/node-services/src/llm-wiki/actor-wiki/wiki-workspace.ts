import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { posix, resolve } from "node:path";

export const MAX_WIKI_PAGE_BYTES = 16 * 1024 * 1024;

export function isWikiPageKey(value: string): boolean {
  return (
    value.length <= 512 &&
    /^[a-z0-9][a-z0-9._/-]*\.md$/u.test(value) &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

export function isPublishableWikiMarkdownPath(value: string): boolean {
  return (
    value.endsWith(".md") &&
    !["INSTRUCTIONS.md", "_plan.md"].includes(posix.basename(value))
  );
}

export interface GeneratedWorkspaceFile {
  content: Uint8Array;
  mediaType: "text/markdown";
  relativePath: string;
}

interface TreeEntry {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export async function scanGeneratedWiki(
  directory: string,
): Promise<{ files: GeneratedWorkspaceFile[]; pageCount: number }> {
  const entries = [...(await scanTree(directory)).values()];
  if (!entries.some((entry) => entry.relativePath === "index.md")) {
    throw new Error("Wiki candidate is missing index.md");
  }
  const publishedEntries = entries.filter(({ relativePath }) =>
    isPublishableWikiMarkdownPath(relativePath),
  );
  if (publishedEntries.length > 10000) {
    throw new Error("Wiki candidate exceeds 10000 pages");
  }
  for (const entry of publishedEntries) {
    if (!isWikiPageKey(entry.relativePath)) {
      throw new Error(
        `Invalid Wiki page key: ${entry.relativePath}; use lowercase ASCII page paths`,
      );
    }
    if (entry.sizeBytes === 0 || entry.sizeBytes > MAX_WIKI_PAGE_BYTES) {
      throw new Error(`Invalid Wiki page size: ${entry.relativePath}`);
    }
  }
  const files = await Promise.all(
    publishedEntries.map(async (entry) => ({
      content: await readFile(
        resolveWorkspacePath(directory, entry.relativePath),
      ),
      mediaType: "text/markdown" as const,
      relativePath: entry.relativePath,
    })),
  );
  return { files, pageCount: publishedEntries.length };
}

export async function checkpointTree(
  directory: string,
): Promise<Map<string, string>> {
  return new Map(
    [...(await scanTree(directory)).values()].map(
      ({ relativePath, sha256 }) => [relativePath, sha256],
    ),
  );
}

async function scanTree(root: string): Promise<Map<string, TreeEntry>> {
  const files = new Map<string, TreeEntry>();
  const collisionKeys = new Set<string>();
  await mkdir(root, { recursive: true });

  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = relativeDirectory
      ? resolveWorkspacePath(root, relativeDirectory)
      : root;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const collisionKey = relativePath.toLocaleLowerCase("en-US");
      if (collisionKeys.has(collisionKey)) {
        throw new Error(`Workspace path collision: ${relativePath}`);
      }
      collisionKeys.add(collisionKey);
      const absolutePath = resolveWorkspacePath(root, relativePath);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Workspace contains a symlink: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await visit(relativePath);
      } else if (metadata.isFile()) {
        files.set(relativePath, {
          relativePath,
          sha256: await hashFile(absolutePath),
          sizeBytes: metadata.size,
        });
      } else {
        throw new Error(`Workspace contains a special file: ${relativePath}`);
      }
    }
  };

  await visit("");
  return files;
}

function resolveWorkspacePath(root: string, relativePath: string): string {
  return resolve(root, ...normalizeRelativePath(relativePath).split("/"));
}

function normalizeRelativePath(value: string): string {
  if (
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid workspace relative path: ${value}`);
  }
  return value;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
