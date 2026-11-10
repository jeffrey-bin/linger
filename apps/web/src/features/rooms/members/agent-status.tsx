import type { TeamHubTenantAgentAvailabilitySnapshot } from "@/features/teamhub/teamhub-types";

type AgentAvailability = TeamHubTenantAgentAvailabilitySnapshot["availability"];

const dotClasses: Record<AgentAvailability["status"], string> = {
  online: "bg-[var(--app-status-success-text)]",
  error: "bg-[var(--app-status-danger-text)]",
  offline: "bg-app-subtle",
  unknown: "bg-[var(--app-status-warning-text)]",
};

function agentStatusDetail(availability: AgentAvailability) {
  const activeTaskCount = availability.active_task_count ?? 0;
  return activeTaskCount > 0
    ? `${activeTaskCount} ${activeTaskCount === 1 ? "task" : "tasks"} in progress`
    : availability.status !== "online"
      ? availability.current_activity?.summary
      : undefined;
}

/** The status as a dot alone, worn on the corner of an avatar. */
export function AgentStatusDot({
  availability,
  className = "",
}: {
  availability: AgentAvailability;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`block size-2.5 rounded-full ring-2 ring-card ${dotClasses[availability.status]} ${className}`}
    />
  );
}

export function AgentStatus({
  availability,
  showDetails = false,
}: {
  availability: AgentAvailability;
  showDetails?: boolean;
}) {
  const status = availability.status;
  const label = status === "online" ? "Online" : availability.label;
  const detail = agentStatusDetail(availability);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${dotClasses[status]}`}
      />
      <span className="min-w-0 truncate">
        <span className="font-medium text-app-body">{label}</span>
        {showDetails && detail ? (
          <span className="text-app-subtle">
            {" · "}
            {detail}
          </span>
        ) : null}
      </span>
    </span>
  );
}
