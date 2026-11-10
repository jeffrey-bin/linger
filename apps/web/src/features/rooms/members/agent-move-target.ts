import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import { reasoningEffortLabel } from "./use-agent-model-selection";

export type LocalComputer = TeamHubLocalComputerPage["items"][number];
type LocalComputerRuntime = LocalComputer["runtimes"][number];
type AgentModel = LocalComputerRuntime["models"][number];

export const runtimeLabels: Record<TeamHubLocalRuntimeType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

/** The full placement plus model an Agent moves to on another Local Computer. */
export interface AgentMoveTarget {
  computerId: string;
  model: string;
  reasoningEffort?: TeamHubAgentReasoningEffort;
  runtimeType: TeamHubLocalRuntimeType;
  workspaceGrantId: string;
}

export interface AgentMoveTargetOption {
  label: string;
  target: AgentMoveTarget;
  value: string;
}

/** The PATCH `runtime` that places the Agent on the target. */
export function agentRuntimeUpdate(
  target: AgentMoveTarget,
): NonNullable<TeamHubTenantAgentUpdateInput["runtime"]> {
  return {
    model: target.model,
    placement: {
      computer_id: target.computerId,
      runtime_type: target.runtimeType,
      type: "local",
      workspace_grant_id: target.workspaceGrantId,
    },
    ...(target.reasoningEffort
      ? { reasoning_effort: target.reasoningEffort }
      : {}),
  };
}

/** The first writable workspace; a Computer without one is not a valid target. */
export function findWritableGrant(computer: LocalComputer) {
  return computer.workspace_grants.find(
    (grant) => grant.mode === "workspace-write",
  );
}

/** Shown when an Agent is placed on a Computer that is not connected. */
export const OFFLINE_COMPUTER_HINT =
  "This computer is offline. The Agent starts working once it connects.";

/** An offline Computer is a valid target: the Agent runs there once it
 * connects, with the Runtimes it last reported. */
export function isMoveTargetComputer(computer: LocalComputer) {
  return !computer.upgrade_required && Boolean(findWritableGrant(computer));
}

export function findReadyRuntime(
  computer: LocalComputer,
  type: TeamHubLocalRuntimeType | undefined,
) {
  const runtime = computer.runtimes.find((item) => item.type === type);
  return runtime?.status === "ready" ? runtime : undefined;
}

/** Keeps the preferred effort when the model allows it, else the model's
 * default, else the first allowed effort. */
export function resolveReasoningEffort(
  model: AgentModel | undefined,
  preferred: TeamHubAgentReasoningEffort | undefined,
) {
  const allowed = model?.allowed_reasoning_effort ?? [];
  if (preferred && allowed.includes(preferred)) return preferred;
  const fallback = model?.default_reasoning_effort;
  if (fallback && allowed.includes(fallback)) return fallback;
  return allowed[0];
}

/** Keeps the Agent's model when the Runtime offers it, otherwise the Runtime's
 * first model. The current reasoning effort carries over only on the same
 * Runtime type. */
export function resolveModelOnRuntime(
  agent: TeamHubTenantAgent,
  runtime: LocalComputerRuntime,
) {
  const model =
    runtime.models.find((item) => item.id === agent.runtime.model) ??
    runtime.models[0];
  const sameRuntime = runtime.type === agent.runtime.placement?.runtime_type;
  return {
    model: model?.id ?? "",
    reasoningEffort: resolveReasoningEffort(
      model,
      sameRuntime ? agent.runtime.reasoning_effort : undefined,
    ),
  };
}

export function resolveMoveTarget(
  agent: TeamHubTenantAgent,
  computer: LocalComputer,
  runtimeType: TeamHubLocalRuntimeType | undefined,
): AgentMoveTarget | undefined {
  const grant = findWritableGrant(computer);
  const runtime = findReadyRuntime(computer, runtimeType);
  if (!grant || !runtime || !isMoveTargetComputer(computer)) return undefined;
  const { model, reasoningEffort } = resolveModelOnRuntime(agent, runtime);
  if (!model) return undefined;
  return {
    computerId: computer.computer_id,
    model,
    reasoningEffort,
    runtimeType: runtime.type,
    workspaceGrantId: grant.grant_id,
  };
}

/** Other Computers the Agent may move to. */
export function moveTargetComputers(
  agent: TeamHubTenantAgent,
  computers: readonly LocalComputer[],
) {
  return computers.filter(
    (computer) =>
      computer.computer_id !== agent.runtime.placement?.computer_id &&
      isMoveTargetComputer(computer),
  );
}

export function moveTargetValue(target: {
  computerId: string;
  runtimeType: TeamHubLocalRuntimeType;
}) {
  return `${target.computerId}:${target.runtimeType}`;
}

/** Every other Computer × its ready Runtimes, as Select options. */
export function moveTargetOptions(
  agent: TeamHubTenantAgent,
  computers: readonly LocalComputer[],
): AgentMoveTargetOption[] {
  return moveTargetComputers(agent, computers).flatMap((computer) =>
    computer.runtimes.flatMap((runtime) => {
      const target = resolveMoveTarget(agent, computer, runtime.type);
      return target
        ? [
            {
              label: `${computer.display_name} · ${runtimeLabels[runtime.type]}`,
              target,
              value: moveTargetValue(target),
            },
          ]
        : [];
    }),
  );
}

/** Rule 1: the first other Computer where the current Runtime is ready,
 * online ones first. Rule 2: none, so the user chooses a Runtime explicitly. */
export function defaultMoveTarget(
  agent: TeamHubTenantAgent,
  computers: readonly LocalComputer[],
) {
  const type = agent.runtime.placement?.runtime_type;
  const candidates = moveTargetComputers(agent, computers);
  for (const computer of [
    ...candidates.filter(({ status }) => status === "online"),
    ...candidates.filter(({ status }) => status !== "online"),
  ]) {
    const target = resolveMoveTarget(agent, computer, type);
    if (target) return target;
  }
  return undefined;
}

export function describeMoveTarget(
  agent: TeamHubTenantAgent,
  target: AgentMoveTarget,
  computer: LocalComputer | undefined,
) {
  const runtime = computer?.runtimes.find(
    (item) => item.type === target.runtimeType,
  );
  const modelLabel =
    runtime?.models.find((item) => item.id === target.model)?.label ??
    target.model;
  const summary = [
    runtimeLabels[target.runtimeType],
    modelLabel,
    target.reasoningEffort
      ? reasoningEffortLabel(target.reasoningEffort)
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sameRuntime =
    target.runtimeType === agent.runtime.placement?.runtime_type;
  const sameModel = target.model === agent.runtime.model;
  const kept =
    sameRuntime &&
    sameModel &&
    target.reasoningEffort === agent.runtime.reasoning_effort;
  const previousEffort = agent.runtime.reasoning_effort;
  const effortChanged =
    sameRuntime &&
    sameModel &&
    previousEffort !== undefined &&
    target.reasoningEffort !== previousEffort;
  // Only a fallback within the same Runtime needs the missing model named;
  // a reasoning change on the same model is named so it is not silent.
  return `${kept ? "Keeps" : "Uses"} ${summary}.${
    sameRuntime && !sameModel
      ? ` ${agent.runtime.model} isn't available there.`
      : ""
  }${
    effortChanged
      ? ` Reasoning was ${reasoningEffortLabel(previousEffort)}.`
      : ""
  }`;
}

export function describeMissingDefault(
  agent: TeamHubTenantAgent,
  candidates: readonly LocalComputer[],
) {
  const name = runtimeLabels[agent.runtime.placement?.runtime_type ?? "codex"];
  const where =
    candidates.length === 1
      ? candidates[0]!.display_name
      : "any other computer";
  return `${name} isn't ready on ${where}. Choose another Runtime.`;
}
