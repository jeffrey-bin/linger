import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encodeExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import {
  createAgentContextHost,
  type AgentContextHost,
  type RuntimeViewMapping,
} from "../../../src/agent/executor/workspace.js";
import type {
  AgentLogFields,
  AgentLogger,
} from "../../../src/agent/observability/agent-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentContextHost", () => {
  it("does not follow an Agent root symlink", async () => {
    const { host, rootPath } = await createHost();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-outside-"));
    temporaryDirectories.push(outside);
    await symlink(outside, path.join(rootPath, "agent-1"));
    await expect(host.ensureAgentRoots("agent-1")).rejects.toThrow(
      "real directory",
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("prepares Room and Task views directly from refs and keeps user work", async () => {
    const { host, rootPath } = await createHost();
    const roots = await host.ensureAgentRoots("agent-1");
    await writeFile(
      path.join(roots.metaPlaygroundRoot, "user.txt"),
      "keep user work",
    );
    const restored = await createAgentContextHost({ rootPath });
    for (const ref of [
      {
        kind: "meta" as const,
        agentId: "agent-1",
        roomId: "room-never-projected",
      },
      {
        kind: "alter_ego" as const,
        agentId: "agent-1",
        taskId: "task-never-projected",
      },
    ]) {
      const plan = await restored.prepareRuntimeView(ref);
      expect(plan.mappings.some(({ kind }) => kind === "inbox_view")).toBe(
        false,
      );
      await restored.releaseRuntimeView(ref);
    }
    await expect(
      readFile(path.join(roots.metaPlaygroundRoot, "user.txt"), "utf8"),
    ).resolves.toBe("keep user work");
  });

  it("refreshes the read-only latest Document in one stable comment Context root", async () => {
    const { host, rootPath } = await createHost();
    const documentId = "document-1";
    const ref = { kind: "document" as const, agentId: "agent-1", documentId };
    const runtimeInstanceKey = encodeExecutionContextRef(ref);
    const stage = (
      targetHost: AgentContextHost,
      content: string,
      commentsMarkdown: string,
    ) => {
      const bytes = Buffer.from(content, "utf8");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return targetHost.stageDocumentProjection({
        agentId: "agent-1",
        runtimeInstanceKey,
        documentComment: {
          commentsMarkdown,
          currentDocument: {
            bytes: new Uint8Array(bytes),
            documentId,
            filename: "current.md",
            mediaType: "text/markdown",
            sha256,
          },
        },
      });
    };

    await (await stage(host, "original\n", "first comments\n")).activate();
    const plan = await host.prepareRuntimeView(ref);
    expect(plan.playgroundRootPath).toBeDefined();
    const documents = plan.mappings.find(
      ({ kind }) => kind === "inbox_view",
    )!.sourcePath;
    expect(
      plan.mappings.find(({ kind }) => kind === "playground"),
    ).toMatchObject({ targetPath: "/workspace/playground" });
    const inbox = documents;
    const currentPath = path.join(documents, "current.md");
    await expect(readFile(currentPath, "utf8")).resolves.toBe("original\n");
    await expect(
      readFile(path.join(inbox, "comments.md"), "utf8"),
    ).resolves.toBe("first comments\n");

    const restartedHost = await createAgentContextHost({ rootPath });
    await (
      await stage(restartedHost, "refreshed latest\n", "refreshed comments\n")
    ).activate();
    const refreshedPlan = await restartedHost.prepareRuntimeView(ref);
    expect(
      refreshedPlan.mappings.find(({ kind }) => kind === "inbox_view")!
        .sourcePath,
    ).toBe(documents);
    await expect(readFile(currentPath, "utf8")).resolves.toBe(
      "refreshed latest\n",
    );
    await expect(
      readFile(path.join(inbox, "comments.md"), "utf8"),
    ).resolves.toBe("refreshed comments\n");

    await (
      await stage(restartedHost, "next revision\n", "next comments\n")
    ).activate();
    await expect(readFile(currentPath, "utf8")).resolves.toBe(
      "next revision\n",
    );
    await expect(readdir(documents)).resolves.toEqual([
      "comments.md",
      "current.md",
    ]);
    await expect(
      stat(path.join(rootPath, "agent-1", "playground", "document")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepares deterministic Runtime views without exposing Host state", async () => {
    const { host, rootPath } = await createHost();

    const metaPlan = await host.prepareRuntimeView({
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    });
    expect(metaPlan.contextKey).toBe('["meta","agent-1","room","room-1"]');
    expect(metaPlan.mappings.map(mappingIdentity)).toEqual([
      "playground:read_write:/workspace/playground",
    ]);

    const alterRef = {
      kind: "alter_ego" as const,
      agentId: "agent-1",
      taskId: "task-a",
    };
    const alterPlan = await host.prepareRuntimeView(alterRef);
    expect(alterPlan.contextKey).toBe('["alter_ego","agent-1","task-a"]');
    expect(alterPlan.mappings.map(mappingIdentity)).toEqual([
      "playground:read_write:/workspace/playground",
    ]);
    expect(
      alterPlan.mappings.some((mapping) =>
        mapping.targetPath.includes("task-b/meta"),
      ),
    ).toBe(false);
    for (const mapping of [...metaPlan.mappings, ...alterPlan.mappings]) {
      await expectDirectory(mapping.sourcePath);
    }

    const restored = await createAgentContextHost({ rootPath });
    const restoredPlan = await restored.prepareRuntimeView(alterRef);
    expect(
      restoredPlan.mappings.find((mapping) => mapping.kind === "playground"),
    ).toEqual(
      alterPlan.mappings.find((mapping) => mapping.kind === "playground"),
    );
  });

  it("mounts Memory only once Memory has published it", async () => {
    const { host } = await createHost();
    const ref = {
      kind: "meta" as const,
      agentId: "agent-1",
      roomId: "room-knowledge-root",
    };
    const roots = await host.ensureAgentRoots("agent-1");
    // An ordinary Agent gets no Memory directory.
    await expect(readdir(roots.agentRoot)).resolves.not.toEqual(
      expect.arrayContaining(["memory"]),
    );
    // An unpublished directory stays unmounted.
    await mkdir(path.join(roots.agentRoot, "memory"));
    expect(
      (await host.prepareRuntimeView(ref)).mappings.map(mappingIdentity),
    ).toEqual(["playground:read_write:/workspace/playground"]);

    // Memory writes this marker for an Another Me after its projection.
    await writeFile(path.join(roots.agentRoot, "memory.revision"), "r1\n");
    const published = await host.prepareRuntimeView(ref);
    expect(published.mappings.map(mappingIdentity)).toEqual([
      "memory:read_only:/workspace/memory",
      "playground:read_write:/workspace/playground",
    ]);
    expect(
      published.mappings.find((mapping) => mapping.kind === "memory"),
    ).toMatchObject({
      sourcePath: path.join(roots.agentRoot, "memory"),
    });
  });

  it("uses the shared latest root without publishing a host Runtime View", async () => {
    const { host } = await createHost();
    const ref = { kind: "meta" as const, agentId: "agent-1", roomId: "room-1" };
    const plan = await host.prepareRuntimeView(ref);

    expect(plan.mappings.some(({ kind }) => kind === "inbox_view")).toBe(false);
    await host.releaseRuntimeView(ref);
  });

  it("logs projection and Runtime view metadata without Message content", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "agent-context-host-log-"),
    );
    temporaryDirectories.push(rootPath);
    const entries: CapturedLogEntry[] = [];
    const host = await createAgentContextHost({
      logger: capturingLogger(entries),
      rootPath,
    });

    await host.prepareRuntimeView({
      agentId: "agent-logs",
      kind: "meta",
      roomId: "room-1",
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "context_host.runtime_view_prepared",
          fields: expect.objectContaining({
            agentId: "agent-logs",
            contextKey: '["meta","agent-logs","room","room-1"]',
            contextKind: "meta",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain(rootPath);
  });
});

const createHost = async (): Promise<{
  readonly host: AgentContextHost;
  readonly rootPath: string;
}> => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "agent-context-host-"));
  temporaryDirectories.push(rootPath);
  const host = await createAgentContextHost({ rootPath });
  return {
    host,
    rootPath,
  };
};

const mappingIdentity = (mapping: RuntimeViewMapping): string =>
  `${mapping.kind}:${mapping.access}:${mapping.targetPath}`;

const expectDirectory = async (directoryPath: string): Promise<void> => {
  expect((await stat(directoryPath)).isDirectory()).toBe(true);
};

interface CapturedLogEntry {
  readonly event: string;
  readonly fields: AgentLogFields;
  readonly level: string;
}

const capturingLogger = (
  entries: CapturedLogEntry[],
  context: AgentLogFields = {},
): AgentLogger => ({
  child(additionalContext) {
    return capturingLogger(entries, { ...context, ...additionalContext });
  },
  log(level, event, fields = {}) {
    entries.push({ event, fields: { ...fields, ...context }, level });
  },
});
