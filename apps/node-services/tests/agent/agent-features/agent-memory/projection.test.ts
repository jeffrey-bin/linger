import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryProjection } from "../../../../src/agent/agent-features/agent-memory/projection.js";
import type { MemoryDocument } from "../../../../src/agent/agent-features/agent-memory/client.js";
import type { AgentContextHost } from "../../../../src/agent/executor/workspace.js";

describe("Agent memory projection", () => {
  it("says and projects nothing before the first publication", async () => {
    const ensureAgentRoots = vi.fn();
    const projection = createMemoryProjection(
      {
        read: async () => ({
          revision: 0,
          summary: "",
          memory: "",
          sessions: {},
          cursors: {},
        }),
        commit: vi.fn(),
      },
      { ensureAgentRoots },
    );
    const result = await projection.prepare("A", new AbortController().signal);
    expect(result).toEqual({});
    expect(ensureAgentRoots).not.toHaveBeenCalled();
  });

  it("publishes independent immutable generations and converges concurrent preparations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    let memory = "original decision";
    const key = "a".repeat(64);
    const projection = createMemoryProjection(
      {
        read: async (agentId): Promise<MemoryDocument> => ({
          revision: 1,
          summary: `${agentId} index`,
          memory,
          sessions: {
            [key]: {
              context_key: "source",
              thread_id: "thread",
              through: 1,
              updated_revision: 1,
              summary: "source evidence",
              raw_memory: "candidate",
            },
          },
          cursors: {},
        }),
        commit: async () => {
          throw new Error("projection must not mutate authority");
        },
      },
      {
        ensureAgentRoots: async (id) => ({ agentRoot: path.join(root, id) }),
      } as Pick<AgentContextHost, "ensureAgentRoots">,
    );
    try {
      const signal = new AbortController().signal;
      const [first, same] = await Promise.all([
        projection.prepare("A", signal),
        projection.prepare("A", signal),
      ]);
      expect(first).toEqual(same);
      expect(first.mapping).toMatchObject({
        access: "read_only",
        targetPath: "/workspace/agent-memory",
      });
      expect(first.summary).toBe("A index");
      expect(
        await readFile(
          path.join(
            first.mapping!.sourcePath,
            "session_summaries",
            `${key}.md`,
          ),
          "utf8",
        ),
      ).toBe("source evidence");
      memory = "corrected decision";
      const next = await projection.prepare("A", signal);
      const other = await projection.prepare("B", signal);
      expect(next.mapping!.sourcePath).not.toBe(first.mapping!.sourcePath);
      expect(other.mapping!.sourcePath).toContain(path.join(root, "B"));
      expect(
        await readFile(
          path.join(first.mapping!.sourcePath, "MEMORY.md"),
          "utf8",
        ),
      ).toBe("original decision");
      expect(
        await readFile(
          path.join(next.mapping!.sourcePath, "MEMORY.md"),
          "utf8",
        ),
      ).toBe("corrected decision");
      expect(
        (
          await readdir(path.join(root, "A", "agent-memory", "generations"))
        ).some((name) => name.startsWith(".draft-")),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("generation reuse and writes", () => {
    const sessionKey = (index: number) => index.toString(16).padStart(64, "0");
    const documentWith = (
      memory: string,
      sessionCount = 0,
    ): MemoryDocument => ({
      revision: 1,
      summary: "index",
      memory,
      sessions: Object.fromEntries(
        Array.from({ length: sessionCount }, (_, index) => [
          sessionKey(index + 1),
          {
            context_key: "source",
            thread_id: "thread",
            through: 1,
            updated_revision: 1,
            summary: `session ${index + 1}`,
            raw_memory: "candidate",
          },
        ]),
      ),
      cursors: {},
    });
    const projectionFor = (root: string, document: () => MemoryDocument) =>
      createMemoryProjection(
        {
          read: async () => document(),
          commit: async () => {
            throw new Error("projection must not mutate authority");
          },
        },
        {
          ensureAgentRoots: async (id) => ({
            agentRoot: path.join(root, id),
          }),
        } as Pick<AgentContextHost, "ensureAgentRoots">,
      );
    const generationsOf = (root: string) =>
      path.join(root, "A", "agent-memory", "generations");
    const signal = () => new AbortController().signal;

    it("reuses an existing generation without writing or creating a draft", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        const projection = projectionFor(root, () => documentWith("stable", 3));
        const first = await projection.prepare("A", signal());
        const target = first.mapping!.sourcePath;
        const before = await lstat(target);
        const filesBefore = await readdir(
          path.join(target, "session_summaries"),
        );
        const mtimesBefore = await Promise.all(
          [
            path.join(target, "MEMORY.md"),
            ...filesBefore.map((name) =>
              path.join(target, "session_summaries", name),
            ),
          ].map(async (file) => (await lstat(file)).mtimeMs),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));

        const second = await projection.prepare("A", signal());
        expect(second).toEqual(first);
        const after = await lstat(target);
        expect(after.ino).toBe(before.ino);
        expect(
          (await readdir(generationsOf(root))).filter((name) =>
            name.startsWith(".draft-"),
          ),
        ).toEqual([]);
        const mtimesAfter = await Promise.all(
          [
            path.join(target, "MEMORY.md"),
            ...filesBefore.map((name) =>
              path.join(target, "session_summaries", name),
            ),
          ].map(async (file) => (await lstat(file)).mtimeMs),
        );
        expect(mtimesAfter).toEqual(mtimesBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("publishes a changed document as a new generation with exact contents", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        let memory = "before";
        const projection = projectionFor(root, () => documentWith(memory, 2));
        const first = await projection.prepare("A", signal());
        memory = "after";
        const next = await projection.prepare("A", signal());
        expect(next.mapping!.sourcePath).not.toBe(first.mapping!.sourcePath);
        expect(
          await readFile(
            path.join(next.mapping!.sourcePath, "MEMORY.md"),
            "utf8",
          ),
        ).toBe("after");
        expect(
          await readFile(
            path.join(next.mapping!.sourcePath, "summary.md"),
            "utf8",
          ),
        ).toBe("index");
        expect(
          (
            await readdir(
              path.join(next.mapping!.sourcePath, "session_summaries"),
            )
          ).sort(),
        ).toEqual([`${sessionKey(1)}.md`, `${sessionKey(2)}.md`]);
        expect(
          await readFile(
            path.join(
              next.mapping!.sourcePath,
              "session_summaries",
              `${sessionKey(2)}.md`,
            ),
            "utf8",
          ),
        ).toBe("session 2");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("converges two concurrent preparations of a new document on one complete generation", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        const projection = projectionFor(root, () => documentWith("fresh", 4));
        const [first, second] = await Promise.all([
          projection.prepare("A", signal()),
          projection.prepare("A", signal()),
        ]);
        expect(second).toEqual(first);
        expect((await readdir(generationsOf(root))).sort()).toEqual([
          first.mapping!.sourcePath.split(path.sep).at(-1),
        ]);
        expect(
          await readFile(
            path.join(first.mapping!.sourcePath, "MEMORY.md"),
            "utf8",
          ),
        ).toBe("fresh");
        expect(
          (
            await readdir(
              path.join(first.mapping!.sourcePath, "session_summaries"),
            )
          ).length,
        ).toBe(4);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("keeps only the current generation and the newest older one", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        let memory = "first";
        const projection = projectionFor(root, () => documentWith(memory, 1));
        const prepared: string[] = [];
        for (const next of ["first", "second", "third", "fourth"]) {
          memory = next;
          const result = await projection.prepare("A", signal());
          prepared.push(result.mapping!.sourcePath.split(path.sep).at(-1)!);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // A deletion cut short leaves trash, never a partial generation.
        await mkdir(path.join(generationsOf(root), ".trash-left"));
        const inFlight = path.join(generationsOf(root), ".draft-in-flight");
        await mkdir(inFlight);
        memory = "fifth";
        const current = await projection.prepare("A", signal());
        expect((await readdir(generationsOf(root))).sort()).toEqual(
          [
            ".draft-in-flight",
            prepared[3]!,
            current.mapping!.sourcePath.split(path.sep).at(-1)!,
          ].sort(),
        );
        expect(
          await readFile(
            path.join(current.mapping!.sourcePath, "MEMORY.md"),
            "utf8",
          ),
        ).toBe("fifth");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("does not reuse a symlink at the generation path", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        const memory = "linked";
        const revision = createHash("sha256")
          .update(
            JSON.stringify({ "summary.md": "index", "MEMORY.md": memory }),
          )
          .digest("hex");
        const elsewhere = path.join(root, "elsewhere");
        await mkdir(elsewhere);
        await mkdir(generationsOf(root), { recursive: true });
        await symlink(elsewhere, path.join(generationsOf(root), revision));
        const projection = projectionFor(root, () => documentWith(memory));
        await expect(projection.prepare("A", signal())).rejects.toThrow();
        expect(await readdir(elsewhere)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("writes every session summary of a large generation", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
      try {
        const projection = projectionFor(root, () => documentWith("many", 50));
        const result = await projection.prepare("A", signal());
        const sessions = path.join(
          result.mapping!.sourcePath,
          "session_summaries",
        );
        const names = (await readdir(sessions)).sort();
        expect(names).toHaveLength(50);
        for (let index = 1; index <= 50; index++) {
          expect(
            await readFile(
              path.join(sessions, `${sessionKey(index)}.md`),
              "utf8",
            ),
          ).toBe(`session ${index}`);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
