import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinAgentFeatures } from "../../../../src/agent/agent-features/builtin.js";
import { createMemoryProjection } from "../../../../src/agent/agent-features/agent-memory/projection.js";
import { createAgentContextHost } from "../../../../src/agent/executor/workspace.js";
import {
  type ContextRuntimeBackendRequest,
  createContextRuntimeActivator,
  createContextViewSessions,
} from "../../../../src/agent/executor/activation.js";
import type { LocalRuntimeSettings } from "../../../../src/agent/runtime-settings.js";
import { TestContextRuntimeState } from "../../test-support/context-runtime-state.js";
import { createTestFeatureAssembly } from "../../test-support/executor-features.js";
import { createStandaloneExecutor } from "../../test-support/standalone-executor.js";

describe("Agent Memory executor composition", () => {
  it.each([false, true])(
    "delivers published files but no memory instructions to the Runtime (published=%s)",
    async (published) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "memory-shell-"));
      const contextHost = await createAgentContextHost({ rootPath: root });
      const ref = {
        kind: "meta",
        agentId: "agent-A",
        roomId: "room-C",
      } as const;
      const backend = vi.fn(
        async (
          _request: ContextRuntimeBackendRequest<LocalRuntimeSettings>,
        ) => {
          throw new Error("stop before native execution");
        },
      );
      const projection = createMemoryProjection(
        {
          read: async () => ({
            revision: published ? 1 : 0,
            summary: published ? "Orchard index" : "",
            memory: published ? "Orchard decision" : "",
            sessions: {},
            cursors: {},
          }),
          commit: vi.fn(),
        },
        contextHost,
      );
      const silentLogger = {
        child() {
          return this;
        },
        log() {},
      };
      const activator = createContextRuntimeActivator<LocalRuntimeSettings>({
        features: createBuiltinAgentFeatures({
          services: {
            logger: silentLogger,
            agentMemory: {
              agentMemory: {
                recordRun: vi.fn(async () => undefined),
                wake: vi.fn(async () => undefined),
              },
              agentMemoryProjection: projection,
            },
          },
        }),
        contextHost,
        viewSessions: createContextViewSessions(),
        resolveBackend: () => ({ activate: backend }),
        logger: silentLogger,
      });
      const shell = await createStandaloneExecutor<LocalRuntimeSettings>({
        activator,
        stateFactory: async () =>
          new TestContextRuntimeState({ databasePath: ":memory:", ref }),
        options: {
          ref,
          actorId: "actor-A",
          tenantId: "tenant",
          agent: {
            name: "A",
            instructions: "Answer questions",
            developerInstructions: "existing policy",
          },
          runtime: {
            type: "local",
            model: "test-model",
            placement: {
              type: "local",
              tenantId: "tenant",
              ownerActorId: "owner",
              computerId: "computer",
              runtimeType: "codex",
              workspaceGrantId: "grant",
              assignmentRevision: 1,
            },
          },
          resources: { skills: [], mcpServers: [] },
          features: createTestFeatureAssembly({
            ref,
            actorId: "actor-A",
          }).ports,
        },
      });
      try {
        await expect(shell.start()).rejects.toThrow(
          "stop before native execution",
        );
        expect(backend).toHaveBeenCalledOnce();
        const request = backend.mock.calls[0]![0];
        // A publication never changes the instructions; the summary reaches
        // the conversation as an input note instead.
        expect(request.agent.developerInstructions).toContain(
          "existing policy",
        );
        expect(request.agent.developerInstructions).not.toContain(
          "agent-memory/",
        );
        expect(request.agent.developerInstructions).not.toContain(
          "Orchard index",
        );
        expect(
          request.viewPlan.mappings.filter(
            (m) =>
              m.kind === "memory" &&
              m.targetPath === "/workspace/agent-memory" &&
              m.access === "read_only",
          ),
        ).toHaveLength(published ? 1 : 0);
      } finally {
        await shell.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
