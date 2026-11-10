import { Select, SelectItem } from "@/components/ui/select";
import type { AgentMoveTargetOption } from "@/features/rooms/members/agent-move-target";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";

import type { AgentMoveProgress } from "./use-move-agents-then-remove";

export const DELETE_AGENT_CHOICE = "delete";

export function RemoveComputerAgentRow({
  agent,
  disabled,
  hint,
  onChange,
  options,
  progress,
  value,
}: {
  agent: TeamHubTenantAgent;
  disabled: boolean;
  hint: string;
  onChange: (value: string) => void;
  options: readonly AgentMoveTargetOption[];
  progress?: AgentMoveProgress;
  value: string;
}) {
  const name = agent.actor.display_name;
  const anotherMe = agent.agent_type === "anotherme";
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <span className="truncate">{name}</span>
        {anotherMe ? (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
            Another Me
          </span>
        ) : null}
      </p>
      <Select
        aria-label={`Target for ${name}`}
        className="ui-field-control w-full"
        disabled={disabled}
        onValueChange={onChange}
        placeholder="Choose a target"
        value={value}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {anotherMe ? null : (
          <SelectItem value={DELETE_AGENT_CHOICE}>
            Delete this Agent instead
          </SelectItem>
        )}
      </Select>
      <p className="text-xs text-app-muted">{hint}</p>
      {progress?.state === "failed" ? (
        <p className="text-xs text-app-danger" role="alert">
          Failed: {progress.message}
        </p>
      ) : progress ? (
        <p className="text-xs text-app-subtle" role="status">
          {progressLabel[progress.state]}
        </p>
      ) : null}
    </li>
  );
}

const progressLabel = {
  deleted: "Deleted",
  deleting: "Deleting…",
  moved: "Moved",
  moving: "Moving…",
} as const;
