import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentContextHost,
  RuntimeViewMapping,
} from "../../executor/workspace.js";
import type { MemoryClient } from "./client.js";

// Generation files live on shared storage, so writes overlap to hide round trips.
const WRITE_CONCURRENCY = 8;

export interface AgentMemoryProjection {
  /** Both are absent before the first publication. */
  prepare(
    agentId: string,
    signal: AbortSignal,
  ): Promise<{ mapping?: RuntimeViewMapping; summary?: string }>;
}

export function createMemoryProjection(
  client: MemoryClient,
  host: Pick<AgentContextHost, "ensureAgentRoots">,
): AgentMemoryProjection {
  return {
    async prepare(agentId, signal) {
      const document = await client.read(agentId, signal);
      // Before the first publication there is nothing to read or describe.
      if (!document.summary && !document.memory) return {};
      const files: Record<string, string> = {
        "summary.md": document.summary,
        "MEMORY.md": document.memory,
      };
      for (const [key, session] of Object.entries(document.sessions)) {
        if (!/^[a-f0-9]{64}$/u.test(key))
          throw new Error("Invalid memory session key");
        files[`session_summaries/${key}.md`] = session.summary;
      }
      const revision = createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex");
      const roots = await host.ensureAgentRoots(agentId);
      const generations = path.join(
        roots.agentRoot,
        "agent-memory",
        "generations",
      );
      const target = path.join(generations, revision);
      // A generation is only created by renaming a complete draft and only
      // deleted after renaming it away, so an existing directory is complete.
      if (!(await isGenerationDirectory(target))) {
        const draft = path.join(generations, `.draft-${randomUUID()}`);
        await mkdir(path.join(draft, "session_summaries"), {
          recursive: true,
          mode: 0o700,
        });
        try {
          await writeGenerationFiles(draft, files);
          try {
            await rename(draft, target);
          } catch (error) {
            if (
              !error ||
              typeof error !== "object" ||
              !("code" in error) ||
              !["EEXIST", "ENOTEMPTY"].includes(String(error.code))
            )
              throw error;
          }
        } finally {
          await rm(draft, { recursive: true, force: true });
        }
        // Cleanup never fails an activation; the next publication retries it.
        await pruneGenerations(generations, revision).catch(() => undefined);
      }
      signal.throwIfAborted();
      return {
        mapping: {
          kind: "memory",
          sourcePath: target,
          targetPath: "/workspace/agent-memory",
          access: "read_only",
        },
        summary: document.summary,
      };
    },
  };
}

// A Context copies a generation when it maps it, so only the current one and
// the newest other, which a concurrent activation may still be copying, stay.
// A generation is renamed to trash before deletion, so a deletion cut short
// never leaves a partial directory under a revision name.
const pruneGenerations = async (
  generations: string,
  current: string,
): Promise<void> => {
  const entries = (await readdir(generations, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  const older = await Promise.all(
    entries
      .filter((entry) => /^[a-f0-9]{64}$/u.test(entry.name))
      .filter((entry) => entry.name !== current)
      .map(async ({ name }) => ({
        name,
        modifiedMs: (await lstat(path.join(generations, name))).mtimeMs,
      })),
  );
  older.sort((left, right) => right.modifiedMs - left.modifiedMs);
  const trash = entries
    .filter((entry) => entry.name.startsWith(".trash-"))
    .map((entry) => entry.name);
  for (const { name } of older.slice(1)) {
    const renamed = `.trash-${randomUUID()}`;
    await rename(path.join(generations, name), path.join(generations, renamed));
    trash.push(renamed);
  }
  for (const name of trash)
    await rm(path.join(generations, name), { recursive: true, force: true });
};

const isGenerationDirectory = async (target: string): Promise<boolean> => {
  try {
    const metadata = await lstat(target);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};

// Waits for every started write before returning, so the caller can remove the draft safely.
const writeGenerationFiles = async (
  draft: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  const entries = Object.entries(files);
  let nextIndex = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < entries.length) {
      const [name, content] = entries[nextIndex++]!;
      try {
        await writeFile(path.join(draft, name), content, { mode: 0o400 });
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
};
