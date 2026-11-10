import path from "node:path";

import { packageRoot } from "../paths.js";

export const promptRoot = path.join(packageRoot, "prompts", "memory");

export function agentWorkspaceRoot(dataRoot: string, agentId: string): string {
  assertSafeAgentId(agentId);
  return path.join(path.resolve(dataRoot), agentId);
}

export function agentMemoryRoot(dataRoot: string, agentId: string): string {
  return path.join(agentWorkspaceRoot(dataRoot, agentId), "memory");
}

export function memoryFilePath(
  dataRoot: string,
  agentId: string,
  ...segments: string[]
): string {
  const relative = path.join(...segments);
  const root =
    relative.split(path.sep)[0] === "evidence"
      ? path.join(agentWorkspaceRoot(dataRoot, agentId), "memory-state")
      : agentMemoryRoot(dataRoot, agentId);
  return path.join(root, relative);
}

export function resolveMemoryOutputPath(
  dataRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Memory output path must be relative: ${relativePath}`);
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const [agentId, ...segments] = normalized.split("/");
  if (
    !agentId ||
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Memory output path is invalid: ${relativePath}`);
  }
  if (
    !["me", "timeline", "knowledge", "evidence"].includes(segments[0]!) &&
    segments.join("/") !== "README.md"
  ) {
    throw new Error(`Memory output path is invalid: ${relativePath}`);
  }
  return memoryFilePath(dataRoot, agentId, ...segments);
}

export function logicalMemoryPath(
  dataRoot: string,
  agentId: string,
  filePath: string,
): string {
  const state = path.join(
    agentWorkspaceRoot(dataRoot, agentId),
    "memory-state",
  );
  const memoryRoot = filePath.startsWith(
    path.join(state, "evidence") + path.sep,
  )
    ? state
    : agentMemoryRoot(dataRoot, agentId);
  const relative = path.relative(memoryRoot, filePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`File is outside Agent memory: ${filePath}`);
  }
  return `${agentId}/${relative.split(path.sep).join("/")}`;
}

export function assertSafeAgentId(agentId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(agentId)) {
    throw new Error(`Unsafe Agent ID: ${agentId}`);
  }
  return agentId;
}
