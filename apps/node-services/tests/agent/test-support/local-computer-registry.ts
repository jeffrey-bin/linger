import type { RuntimeDiagnostics } from "@linger/wire-contracts/runner-gateway/types";

import type { LocalRuntimeType } from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  runtimeRegistrationId,
  type LocalComputerOwner,
  type LocalComputerRegistry,
  type RunnerPlacement,
} from "../../../src/agent/runner-gateway/local-computer-registry.js";

/** What the Gateway recorded for a Computer, as TeamHub would store it. */
export interface TestRecordedLocalComputer {
  readonly computerId: string;
  displayName: string;
  readonly owner: LocalComputerOwner;
  status: "online" | "offline" | "upgrade_required";
  platform?: string;
  capacity?: number;
  runtimes: readonly LocalRuntimeType[];
  runtimeDiagnostics: RuntimeDiagnostics | [];
  workspaceGrants: readonly object[];
  lastSeenAt?: string;
  daemonVersion?: string;
  recommendedVersion?: string;
  activeOperations?: number;
  daemonId?: string;
}

/**
 * Plays TeamHub's Computer and registration rows: Computers are enrolled,
 * Agents are placed on them, and a connection reads the placements back.
 */
export interface TestLocalComputerRegistry extends LocalComputerRegistry {
  enroll(
    input: LocalComputerOwner & {
      readonly computerId: string;
      readonly displayName?: string;
      readonly generation?: number;
    },
  ): void;
  place(computerId: string, placement: RunnerPlacement): void;
  unplace(agentId: string): void;
  recorded(computerId: string): TestRecordedLocalComputer | undefined;
  list(owner: LocalComputerOwner): readonly TestRecordedLocalComputer[];
}

const registries = new Map<string, TestLocalComputerRegistry>();

/** The same authorityKey returns the same rows, as a restarted process would read. */
export function createTestLocalComputerRegistry(
  options: { readonly authorityKey?: string } = {},
): TestLocalComputerRegistry {
  const retained =
    options.authorityKey === undefined
      ? undefined
      : registries.get(options.authorityKey);
  if (retained) return retained;
  const computers = new Map<
    string,
    TestRecordedLocalComputer & { generation: number; removed?: boolean }
  >();
  const placements = new Map<
    string,
    { computerId: string; placement: RunnerPlacement }
  >();
  const owns = (
    computer: TestRecordedLocalComputer,
    owner: LocalComputerOwner,
  ): boolean =>
    computer.owner.tenantId === owner.tenantId &&
    computer.owner.ownerActorId === owner.ownerActorId;
  const registry: TestLocalComputerRegistry = {
    enroll({ computerId, displayName, generation, ...owner }) {
      computers.set(computerId, {
        computerId,
        displayName: displayName ?? computerId,
        owner,
        status: "offline",
        runtimes: [],
        runtimeDiagnostics: [],
        workspaceGrants: [],
        generation: generation ?? 0,
      });
    },
    place(computerId, placement) {
      placements.set(placement.agentId, { computerId, placement });
    },
    unplace(agentId) {
      placements.delete(agentId);
    },
    recorded: (computerId) => computers.get(computerId),
    list: (owner) =>
      [...computers.values()]
        .filter((computer) => !computer.removed && owns(computer, owner))
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
    async credentialGeneration(computerId, owner) {
      const computer = computers.get(computerId);
      return computer && !computer.removed && owns(computer, owner)
        ? computer.generation
        : null;
    },
    async connect({ computerId, owner, hello, status, recommendedVersion }) {
      const previous = computers.get(computerId);
      computers.set(computerId, {
        computerId,
        displayName: hello.display_name ?? previous?.displayName ?? computerId,
        owner,
        status,
        platform: hello.platform,
        ...(hello.capacity === undefined ? {} : { capacity: hello.capacity }),
        runtimes: [...hello.runtimes],
        runtimeDiagnostics: structuredClone(hello.runtime_diagnostics),
        workspaceGrants: structuredClone(hello.workspace_grants),
        lastSeenAt: hello.sent_at,
        daemonVersion: hello.daemon_version,
        daemonId: hello.daemon_identity.daemon_id,
        ...((recommendedVersion ?? previous?.recommendedVersion)
          ? {
              recommendedVersion:
                recommendedVersion ?? previous?.recommendedVersion,
            }
          : {}),
        generation: previous?.generation ?? 0,
      });
      return [...placements.values()]
        .filter((entry) => entry.computerId === computerId)
        .map(({ placement }) => structuredClone(placement));
    },
    async touch(computerId, touch) {
      const computer = computers.get(computerId);
      if (!computer || computer.removed) return;
      computer.status = touch.status;
      computer.lastSeenAt = touch.seenAt;
      if (touch.status !== "online") computer.activeOperations = 0;
      else if (touch.activeOperations !== undefined)
        computer.activeOperations = touch.activeOperations;
      if (touch.runtimes) computer.runtimes = [...touch.runtimes];
      if (touch.runtimeDiagnostics)
        computer.runtimeDiagnostics = structuredClone(touch.runtimeDiagnostics);
      if (touch.daemonVersion) computer.daemonVersion = touch.daemonVersion;
      if (touch.recommendedVersion)
        computer.recommendedVersion = touch.recommendedVersion;
    },
    async remove({ computerId, ...owner }) {
      const computer = computers.get(computerId);
      if (!computer || !owns(computer, owner)) return "not-found";
      if (computer.removed) return "already-removed";
      if (
        [...placements.values()].some(
          (entry) => entry.computerId === computerId,
        )
      )
        return "has-agents";
      computer.removed = true;
      computer.status = "offline";
      return "removed";
    },
  };
  if (options.authorityKey !== undefined)
    registries.set(options.authorityKey, registry);
  return registry;
}

/** A placement as TeamHub returns it for an Agent on the test Computer. */
export const testRunnerPlacement = (
  overrides: Partial<RunnerPlacement> = {},
): RunnerPlacement => ({
  agentId: "agent-reviewer",
  tenantId: "tenant-acme",
  ownerActorId: "actor-alice",
  runtimeType: "codex",
  model: "codex-default",
  workspaceGrantId: "grant-repo",
  assignmentRevision: 1,
  ...overrides,
});

/** The Registration the Gateway names for the test owner's Runtime. */
export const testRegistrationId = (
  runtimeType: LocalRuntimeType,
  owner: LocalComputerOwner = {
    tenantId: "tenant-acme",
    ownerActorId: "actor-alice",
  },
): string => runtimeRegistrationId(owner, runtimeType);
