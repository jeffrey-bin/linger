import fs from "node:fs/promises";
import path from "node:path";
import { markMemoryChanged, writeTextFile } from "./fs-utils.js";
import { normalizeValidMemoryMarkdown } from "./okf-validation.js";
import { resolveMemoryOutputPath } from "./paths.js";
import type { MemoryUpdateOutput } from "./types.js";
import { validateAll } from "./validation.js";

export interface ApplyOptions {
  allowedSubjectKeys?: string[];
  allowedPathPrefixes?: string[];
  allowedDeletePathPrefixes?: string[];
}

export async function validateMemoryUpdate(
  memoryRoot: string,
  output: MemoryUpdateOutput,
  options: ApplyOptions = {},
): Promise<MemoryUpdateOutput> {
  if (output.schema_version !== 1) {
    throw new Error(
      `Unsupported daily update schema: ${JSON.stringify(output.schema_version)}`,
    );
  }
  const allowedSubjectKeys = new Set(options.allowedSubjectKeys ?? []);
  const normalizedFiles: MemoryUpdateOutput["files"] = [];
  const fileTargets = new Set<string>();
  const checks = output.files.map((file) => () => {
    assertMemoryOutputPath(file.path, allowedSubjectKeys);
    assertAllowedPathPrefix(file.path, options.allowedPathPrefixes);
    const targetPath = safeMemoryPath(memoryRoot, file.path);
    if (fileTargets.has(targetPath)) {
      throw new Error(
        `Memory output writes the same path more than once: ${file.path}`,
      );
    }
    fileTargets.add(targetPath);
    if (shouldSkipMemoryPath(file.path)) {
      normalizedFiles.push(file);
      return;
    }
    const normalizedPath = normalizeMemoryPath(file.path);
    const subjectRelativePath = normalizedPath.split("/").slice(1).join("/");
    normalizedFiles.push({
      ...file,
      content: normalizeValidMemoryMarkdown(subjectRelativePath, file.content),
    });
  });
  const deletedPaths = output.deleted_paths ?? [];
  const deletedTargets = new Set<string>();
  for (const relativePath of deletedPaths)
    checks.push(() => {
      assertMemoryOutputPath(relativePath, allowedSubjectKeys);
      assertAllowedDeletePathPrefix(
        relativePath,
        options.allowedDeletePathPrefixes,
      );
      const targetPath = safeMemoryPath(memoryRoot, relativePath);
      if (deletedTargets.has(targetPath)) {
        throw new Error(
          `Memory output deletes the same path more than once: ${relativePath}`,
        );
      }
      if (fileTargets.has(targetPath)) {
        throw new Error(
          `Memory output cannot write and delete the same path: ${relativePath}`,
        );
      }
      deletedTargets.add(targetPath);
    });
  checks.push(() => {
    for (const entry of output.memory_log_entries) {
      if (typeof entry.memory_path === "string") {
        assertAllowedPathPrefix(entry.memory_path, options.allowedPathPrefixes);
      }
    }
    groupLogEntriesBySubject(output, allowedSubjectKeys);
  });
  await validateAll(checks);
  return { ...output, files: normalizedFiles };
}

export async function applyMemoryUpdate(
  memoryRoot: string,
  output: MemoryUpdateOutput,
  options: ApplyOptions = {},
): Promise<void> {
  output = await validateMemoryUpdate(memoryRoot, output, options);
  const allowedSubjectKeys = new Set(options.allowedSubjectKeys ?? []);
  const snapshots = await captureApplySnapshots(memoryRoot, output);
  const changedSubjects = new Set<string>();
  try {
    for (const file of output.files) {
      const subjectKey = assertMemoryOutputPath(file.path, allowedSubjectKeys);
      changedSubjects.add(subjectKey);
      assertAllowedPathPrefix(file.path, options.allowedPathPrefixes);
      if (shouldSkipMemoryPath(file.path)) continue;
      await writeTextFile(safeMemoryPath(memoryRoot, file.path), file.content);
    }

    for (const relativePath of output.deleted_paths ?? []) {
      const subjectKey = assertMemoryOutputPath(
        relativePath,
        allowedSubjectKeys,
      );
      changedSubjects.add(subjectKey);
      assertAllowedDeletePathPrefix(
        relativePath,
        options.allowedDeletePathPrefixes,
      );
      await fs.rm(safeMemoryPath(memoryRoot, relativePath), { force: true });
    }
  } catch (error) {
    try {
      await restoreApplySnapshots(snapshots);
    } catch {
      // Preserve the original apply failure; the snapshot remains diagnostic.
    }
    throw error;
  } finally {
    // Runs after any restore, so the bump follows every content change.
    for (const subjectKey of changedSubjects)
      await markMemoryChanged(memoryRoot, subjectKey);
  }
}

export const applyDailyUpdate = applyMemoryUpdate;

export function safeMemoryPath(
  memoryRoot: string,
  relativePath: string,
): string {
  return resolveMemoryOutputPath(memoryRoot, relativePath);
}

function assertSubjectPath(
  relativePath: string,
  allowedSubjectKeys: Set<string>,
): string {
  const subjectKey = relativePath.split(/[\\/]/)[0];
  if (!subjectKey) {
    throw new Error(`Memory output path is empty: ${relativePath}`);
  }
  if (!allowedSubjectKeys.has(subjectKey)) {
    throw new Error(
      `Memory output path must start with a memory subject key: ${relativePath}. Expected subject: ${[...allowedSubjectKeys].join(", ")}`,
    );
  }
  return subjectKey;
}

function assertMemoryOutputPath(
  relativePath: string,
  allowedSubjectKeys: Set<string>,
): string {
  if (allowedSubjectKeys.size > 0) {
    return assertSubjectPath(relativePath, allowedSubjectKeys);
  }
  const subjectKey = relativePath.split(/[\\/]/)[0];
  if (!subjectKey) {
    throw new Error(`Memory output path is empty: ${relativePath}`);
  }
  return subjectKey;
}

function assertAllowedPathPrefix(
  relativePath: string,
  allowedPathPrefixes: readonly string[] | undefined,
): void {
  if (!allowedPathPrefixes || allowedPathPrefixes.length === 0) {
    return;
  }
  const [, ...segments] = normalizeMemoryPath(relativePath).split("/");
  const subjectRelativePath = segments.join("/");
  if (
    !allowedPathPrefixes.some((prefix) =>
      subjectRelativePath.startsWith(prefix),
    )
  ) {
    throw new Error(
      `Memory output path is outside the allowed scope: ${relativePath}`,
    );
  }
}

function assertAllowedDeletePathPrefix(
  relativePath: string,
  allowedDeletePathPrefixes: readonly string[] | undefined,
): void {
  if (allowedDeletePathPrefixes === undefined) return;
  const [, ...segments] = normalizeMemoryPath(relativePath).split("/");
  const subjectRelativePath = segments.join("/");
  if (
    !allowedDeletePathPrefixes.some((prefix) =>
      subjectRelativePath.startsWith(prefix),
    )
  ) {
    throw new Error(
      `Memory deletion is outside the allowed scope: ${relativePath}`,
    );
  }
}

function groupLogEntriesBySubject(
  output: MemoryUpdateOutput,
  allowedSubjectKeys: Set<string>,
): Map<string, Array<Record<string, unknown>>> {
  const result = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of output.memory_log_entries) {
    if (
      typeof entry.memory_path === "string" &&
      shouldSkipMemoryPath(entry.memory_path)
    ) {
      continue;
    }
    const subjectKey =
      typeof entry.memory_subject_key === "string"
        ? entry.memory_subject_key
        : typeof entry.memory_path === "string"
          ? (entry.memory_path.split(/[\\/]/)[0] ?? undefined)
          : undefined;
    if (!subjectKey) {
      throw new Error("Memory log entry is missing memory_subject_key");
    }
    if (allowedSubjectKeys.size > 0 && !allowedSubjectKeys.has(subjectKey)) {
      throw new Error(
        `Memory log entry uses an unknown subject key: ${subjectKey}`,
      );
    }
    const entries = result.get(subjectKey) ?? [];
    entries.push(entry);
    result.set(subjectKey, entries);
  }
  return result;
}

export function parseMemoryUpdateOutput(
  raw: string,
  allowedSubjectKeys: readonly string[] = [],
): MemoryUpdateOutput {
  const parsed = JSON.parse(raw) as Partial<MemoryUpdateOutput>;
  if (
    parsed.schema_version !== 1 ||
    typeof parsed.date !== "string" ||
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.memory_log_entries)
  ) {
    throw new Error("LLM output does not match the daily update shape");
  }
  for (const file of parsed.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      (file.source_refs !== undefined &&
        (!Array.isArray(file.source_refs) ||
          file.source_refs.some((entry) => typeof entry !== "string")))
    ) {
      throw new Error("LLM output contains an invalid file entry");
    }
  }
  if (
    parsed.deleted_paths !== undefined &&
    (!Array.isArray(parsed.deleted_paths) ||
      parsed.deleted_paths.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error("LLM output contains invalid deleted paths");
  }
  const output = parsed as MemoryUpdateOutput;
  if (allowedSubjectKeys.length > 0) {
    const subjects = new Set(allowedSubjectKeys);
    for (const file of output.files) assertSubjectPath(file.path, subjects);
    for (const filePath of output.deleted_paths ?? []) {
      assertSubjectPath(filePath, subjects);
    }
    for (const entry of output.memory_log_entries) {
      if (typeof entry.memory_path === "string") {
        assertSubjectPath(entry.memory_path, subjects);
      }
    }
    groupLogEntriesBySubject(output, subjects);
  }
  return output;
}

async function captureApplySnapshots(
  memoryRoot: string,
  output: MemoryUpdateOutput,
): Promise<Map<string, string | null>> {
  const paths = new Set<string>();
  for (const file of output.files) {
    paths.add(safeMemoryPath(memoryRoot, file.path));
  }
  for (const relativePath of output.deleted_paths ?? []) {
    paths.add(safeMemoryPath(memoryRoot, relativePath));
  }
  const snapshots = new Map<string, string | null>();
  for (const targetPath of paths) {
    snapshots.set(targetPath, await readOptionalTextFile(targetPath));
  }
  return snapshots;
}

async function restoreApplySnapshots(
  snapshots: Map<string, string | null>,
): Promise<void> {
  for (const [targetPath, content] of snapshots) {
    if (content === null) {
      await fs.rm(targetPath, { force: true });
    } else {
      await writeTextFile(targetPath, content);
    }
  }
}

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizeMemoryPath(relativePath: string): string {
  return path.normalize(relativePath).split(path.sep).join("/");
}

function shouldSkipMemoryPath(relativePath: string): boolean {
  const parts = path.normalize(relativePath).split(path.sep);
  if (parts.length < 4 || parts[1] !== "evidence") {
    return false;
  }
  return parts[3] === "events";
}
