import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { formatDateTime } from "@/lib/date-format";
import { useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";

import type {
  TeamHubActor,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { AgentProfileContent } from "../../members/actor-profile";
import { useRoomMessageRunStatuses } from "../../runtime-status/use-room-message-run-statuses";
import {
  agentInfoActivityEntries,
  type AgentInfoActivityEntry,
} from "./agent-info-activity";

export function AgentInfoPanelTab({
  actor,
  hidden,
  roomId,
  tenantId,
}: {
  actor?: TeamHubActor;
  hidden: boolean;
  roomId: string;
  tenantId: string;
}) {
  return (
    <div
      aria-label="Agent info"
      className={hidden ? "hidden" : "h-full min-h-0 overflow-hidden"}
      data-testid="panel-tab-agent-info"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {actor ? (
        <AgentProfileContent
          actor={actor}
          roomId={roomId}
          tenantId={tenantId}
        />
      ) : null}
    </div>
  );
}

export function AgentActivityLog({
  actorId,
  agentName,
  onView,
  roomId,
  roomMessages,
  tenantId,
}: {
  actorId: string;
  agentName: string;
  onView: (entry: AgentInfoActivityEntry) => void;
  roomId: string;
  roomMessages: readonly TeamHubMessage[];
  tenantId: string;
}) {
  const [page, setPage] = useState(0);
  const promptIds = useMemo(
    () => roomMessages.map((message) => message.id),
    [roomMessages],
  );
  const runStatuses = useRoomMessageRunStatuses({
    messageIds: promptIds,
    roomId,
    tenantId,
  });
  const entries = agentInfoActivityEntries(roomMessages, {
    actorId,
    runStatuses,
  });

  const pageCount = Math.max(1, Math.ceil(entries.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = entries.slice(currentPage * 10, (currentPage + 1) * 10);
  return (
    <section className="p-4" aria-label="Agent activity history">
      <p className="mb-3 text-xs text-app-muted">
        Recent activity in this conversation
      </p>
      {visible.length ? (
        <ul className="overflow-hidden rounded-xl border border-app-border">
          {visible.map((entry) => (
            <li
              key={entry.id}
              className="border-t border-app-border first:border-t-0"
            >
              <button
                aria-label={`View ${agentName} activity: ${entry.promptText}`}
                onClick={() => onView(entry)}
                type="button"
                className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus"
              >
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-xs leading-5 text-app-body">
                    {entry.promptText}
                  </span>
                  <time
                    dateTime={entry.createdAt}
                    className="mt-1 block text-xs text-app-muted"
                  >
                    {formatDateTime(entry.createdAt, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                </span>
                <Icon
                  className="shrink-0 text-app-muted"
                  icon={ArrowRight01Icon}
                  size={14}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-xs text-app-muted" role="status">
          No recent activity
        </p>
      )}
      {pageCount > 1 ? (
        <nav
          aria-label="Activity pages"
          className="mt-4 flex items-center justify-between text-xs"
        >
          <button
            type="button"
            className="rounded-md border border-app-border px-3 py-1.5 disabled:opacity-40"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span className="text-app-muted">
            {currentPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="rounded-md border border-app-border px-3 py-1.5 disabled:opacity-40"
            disabled={currentPage === pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}
