import { BotIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";

import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import { availabilityOf, type AgentAvailability } from "./agent-availability";
import { Hint } from "./computer-hint";
import { appNames } from "./computer-readiness";

/** Two rows of five avatars, the last slot showing the rest. */
const collapsedCount = 9;

type AgentStatus = AgentAvailability["status"];

const tileClassName =
  "flex w-full min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 transition-colors duration-150 hover:bg-sidebar-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

const statusOrder: Record<AgentStatus, number> = {
  error: 0,
  offline: 1,
  unknown: 2,
  online: 3,
};

/**
 * The Agents placed on one Computer, led by their avatars. Their state is the
 * TeamHub availability projection, the same one Rooms and Agent profiles read.
 */
export function AgentChips({
  agentAvailabilities,
  agents,
  onOpenAgent,
}: {
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>;
  agents: TeamHubTenantAgent[];
  onOpenAgent: (actorId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (agents.length === 0)
    return (
      <p className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
        <Icon icon={BotIcon} size={16} />
        No Agents on this computer yet. Create one from Chats.
      </p>
    );
  const sorted = [...agents].sort(
    (left, right) =>
      statusOrder[availabilityOf(agentAvailabilities, left).status] -
        statusOrder[availabilityOf(agentAvailabilities, right).status] ||
      left.actor.display_name.localeCompare(right.actor.display_name),
  );
  const visible = expanded ? sorted : sorted.slice(0, collapsedCount);
  const hidden = sorted.length - visible.length;
  return (
    <div className="grid grid-cols-5 gap-x-2 gap-y-2 pt-1">
      {visible.map((agent) => (
        <AgentChip
          agent={agent}
          availability={availabilityOf(agentAvailabilities, agent)}
          key={agent.actor.id}
          onOpen={() => onOpenAgent(agent.actor.id)}
        />
      ))}
      {hidden > 0 || expanded ? (
        <button
          className={tileClassName}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span className="flex size-12 items-center justify-center rounded-[20%] bg-muted text-sm text-muted-foreground">
            {expanded ? "–" : `+${hidden}`}
          </span>
          <span className="text-xs text-muted-foreground">
            {expanded ? "Less" : "More"}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function AgentChip({
  agent,
  availability,
  onOpen,
}: {
  agent: TeamHubTenantAgent;
  availability: AgentAvailability;
  onOpen: () => void;
}) {
  const tone = chipTone(availability);
  return (
    <Hint
      text={`${agent.actor.display_name} · ${availabilityText(agent, availability)}`}
    >
      <button className={tileClassName} onClick={onOpen} type="button">
        <span
          className={cn(
            "relative shrink-0",
            availability.status === "offline" &&
              tone !== "warning" &&
              "opacity-50 grayscale",
          )}
        >
          <ActorAvatar
            actorId={agent.actor.id}
            kind="agent"
            name={agent.actor.display_name}
            showTitle={false}
            size="card"
          />
          {tone ? (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background",
                tone === "warning"
                  ? "bg-app-warning"
                  : tone === "success"
                    ? "bg-app-success"
                    : "bg-muted-foreground/50",
              )}
            />
          ) : null}
        </span>
        <span className="line-clamp-2 w-full text-center text-xs [overflow-wrap:anywhere] text-muted-foreground">
          {agent.actor.display_name}
        </span>
      </button>
    </Hint>
  );
}

function needsSignIn(availability: AgentAvailability) {
  return (
    availability.localRuntimeStatus?.status === "authentication_required" &&
    availability.localRuntimeStatus.computer_status === "online"
  );
}

/** Amber marks something the user can fix on this page; grey is waiting. */
function chipTone(
  availability: AgentAvailability,
): "neutral" | "success" | "warning" | null {
  if (availability.status === "error" || needsSignIn(availability))
    return "warning";
  if (availability.status === "online")
    return availability.activeTaskCount > 0 ? "success" : null;
  return "neutral";
}

function availabilityText(
  agent: TeamHubTenantAgent,
  availability: AgentAvailability,
) {
  const runtimeType =
    availability.localRuntimeStatus?.runtime_type ??
    agent.runtime.placement?.runtime_type;
  const app = runtimeType ? appNames[runtimeType] : undefined;
  const reason = availability.currentActivity?.summary;
  if (availability.status === "online") {
    const tasks = availability.activeTaskCount;
    return [
      availability.label,
      app,
      tasks ? `${tasks} task${tasks === 1 ? "" : "s"} running` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (needsSignIn(availability) && app)
    return `${availability.label} · ${app} sign-in needed`;
  return reason ? `${availability.label} · ${reason}` : availability.label;
}
