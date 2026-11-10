import { LaptopIcon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import { appIcons } from "./computer-app-icons";
import { useComputerConnectionStatus } from "./computer-connection-status";
import { ComputerRow, RowMark, StatusDot } from "./computer-row";
import { relativeTime } from "./computer-relative-time";
import {
  appNames,
  appOrder,
  appStatus,
  computerReadiness,
} from "./computer-readiness";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

/** Every Computer as one Chats-list style row; a row opens its detail. */
export function ComputerDirectory({
  agents,
  computers,
  onSelect,
}: {
  agents: TeamHubTenantAgent[];
  computers: LocalComputer[];
  onSelect: (computerId: string) => void;
}) {
  return (
    <ul aria-label="Local computers directory" className="grid gap-1">
      {computers.map((computer) => (
        <li key={computer.computer_id}>
          <DirectoryRow
            agents={agents.filter(
              (agent) =>
                agent.runtime.placement?.computer_id === computer.computer_id,
            )}
            computer={computer}
            onSelect={() => onSelect(computer.computer_id)}
          />
        </li>
      ))}
    </ul>
  );
}

function DirectoryRow({
  agents,
  computer,
  onSelect,
}: {
  agents: TeamHubTenantAgent[];
  computer: LocalComputer;
  onSelect: () => void;
}) {
  const displayStatus = useComputerConnectionStatus(
    computer.computer_id,
    computer.status,
  );
  const readiness = computerReadiness(computer, displayStatus);
  const offline = displayStatus !== "online";
  const subtitle =
    readiness.kind === "reconnecting" ? (
      <span className="town-shimmer-text">Reconnecting…</span>
    ) : readiness.kind === "offline" ? (
      computer.last_seen_at ? (
        `Offline · ${relativeTime(computer.last_seen_at)}`
      ) : (
        "Offline"
      )
    ) : readiness.kind === "update" ? (
      "Update required"
    ) : readiness.kind === "signIn" ? (
      `Sign in to ${appNames[readiness.app]}`
    ) : readiness.kind === "updateApp" ? (
      `Update ${appNames[readiness.app]}`
    ) : readiness.kind === "check" ? (
      `Couldn't check ${appNames[readiness.app]}`
    ) : readiness.kind === "setUp" ? (
      `Set up ${appNames[readiness.app]}`
    ) : computer.active_operations ? (
      `Ready · ${computer.active_operations} running`
    ) : (
      "Ready"
    );
  const apps = appOrder.filter(
    (app) => appStatus(computer, app) !== "not_installed",
  );
  return (
    <ComputerRow
      action={
        <span className="flex items-center gap-3">
          <span className={cn("flex gap-1", offline && "opacity-45")}>
            {apps.map((app) => (
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-md",
                  appStatus(computer, app) === "ready"
                    ? "bg-muted"
                    : "bg-[var(--app-status-warning-surface)] text-app-warning",
                )}
                key={app}
                title={appNames[app]}
              >
                <Icon icon={appIcons[app]} size={14} />
              </span>
            ))}
          </span>
          {agents.length ? (
            <span className="flex">
              {agents.slice(0, 4).map((agent, index) => (
                <span
                  className={cn(
                    "rounded-[20%] ring-2 ring-background",
                    index > 0 && "-ml-1",
                  )}
                  key={agent.actor.id}
                >
                  <ActorAvatar
                    actorId={agent.actor.id}
                    kind="agent"
                    name={agent.actor.display_name}
                    size="xxs"
                  />
                </span>
              ))}
            </span>
          ) : null}
        </span>
      }
      dimmed={offline}
      mark={
        <RowMark>
          <Icon icon={LaptopIcon} size={20} />
        </RowMark>
      }
      onClick={onSelect}
      subtitle={
        <span className="flex items-center gap-1.5">
          {readiness.kind === "reconnecting" ? null : (
            <StatusDot
              tone={
                readiness.kind === "ready"
                  ? "success"
                  : readiness.kind === "offline"
                    ? "neutral"
                    : "warning"
              }
            />
          )}
          {subtitle}
        </span>
      }
      title={computer.display_name}
    />
  );
}
