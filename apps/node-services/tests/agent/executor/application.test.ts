import { describe, expect, it, vi } from "vitest";
import {
  allowsPresencePreparation,
  supportsRoomContextPreparation,
} from "../../../src/agent/executor/application.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";

describe("Room preparation Runtime eligibility", () => {
  const local: LocalRuntimeSettings = {
    type: "local",
    placement: {
      type: "local",
      computerId: "computer-ready",
      tenantId: "tenant-1",
      ownerActorId: "owner-1",
      runtimeType: "codex",
      workspaceGrantId: "grant-1",
      assignmentRevision: 1,
    },
  };

  it("prepares Local Codex only when its connected daemon guarantees durable empty sessions", () => {
    expect(supportsRoomContextPreparation(local)).toBe(false);
    expect(supportsRoomContextPreparation(local, {})).toBe(false);
    const supportsDurableCodexSession = vi.fn(() => false);
    expect(
      supportsRoomContextPreparation(local, { supportsDurableCodexSession }),
    ).toBe(false);
    supportsDurableCodexSession.mockReturnValue(true);
    expect(
      supportsRoomContextPreparation(local, { supportsDurableCodexSession }),
    ).toBe(true);
    expect(supportsDurableCodexSession).toHaveBeenLastCalledWith(
      "computer-ready",
    );
    expect(
      supportsRoomContextPreparation(
        { ...local, placement: { ...local.placement, runtimeType: "claude" } },
        { supportsDurableCodexSession },
      ),
    ).toBe(false);
  });

  it("allows presence activation only for Meta Contexts on an execution-ready Computer", () => {
    const meta = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-1",
    } as const;
    const claude = {
      ...local,
      placement: { ...local.placement, runtimeType: "claude" as const },
    };
    const isLocalComputerExecutionReady = vi.fn(() => true);
    const gateway = { isLocalComputerExecutionReady };

    expect(
      allowsPresencePreparation({ ref: meta, runtime: claude }, gateway),
    ).toBe(true);
    expect(isLocalComputerExecutionReady).toHaveBeenLastCalledWith(
      "computer-ready",
    );
    // A non-Meta Context is never pre-activated.
    expect(
      allowsPresencePreparation(
        {
          ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" },
          runtime: claude,
        },
        gateway,
      ),
    ).toBe(false);
    // Codex defers its thread to the first run.start like every Runtime.
    expect(
      allowsPresencePreparation({ ref: meta, runtime: local }, gateway),
    ).toBe(true);
    // An offline Computer, or a gateway without the readiness check, is never woken.
    isLocalComputerExecutionReady.mockReturnValue(false);
    expect(
      allowsPresencePreparation({ ref: meta, runtime: claude }, gateway),
    ).toBe(false);
    expect(allowsPresencePreparation({ ref: meta, runtime: claude })).toBe(
      false,
    );
  });
});
