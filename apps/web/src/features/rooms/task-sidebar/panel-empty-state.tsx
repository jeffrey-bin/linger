import {
  ArrowUpRight01Icon,
  File01Icon,
  HierarchyIcon,
  LayoutLeftIcon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "../members/actor-avatar";
import type { PanelCreateChoice } from "./panel-create-items";

export function PanelEmptyState({
  agent,
  documentCount,
  onCreate,
  onOpenAgentInfo,
}: {
  agent?: TeamHubActorRef;
  documentCount: number;
  onCreate: (choice: PanelCreateChoice) => void;
  onOpenAgentInfo: () => void;
}) {
  const rowClassName =
    "flex w-full items-center gap-3 rounded-xl bg-card p-3 text-left shadow-outline transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div
      className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-card px-5 py-10"
      data-testid="panel-launcher"
    >
      <div className="mx-auto max-w-sm">
        <div className="mb-6">
          <span
            className="mb-4 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <Icon icon={LayoutLeftIcon} size={20} />
          </span>
          <h2 className="text-base font-semibold text-foreground">
            Conversation details
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {agent
              ? "Agent settings, routines, activity, and shared documents — alongside your chat."
              : "Shared documents and message threads — alongside your chat."}
          </p>
        </div>
        <div className="space-y-2">
          {agent ? (
            <button
              aria-label="Agent info"
              className={rowClassName}
              onClick={onOpenAgentInfo}
              type="button"
            >
              <ActorAvatar
                actorId={agent.id}
                kind="agent"
                name={agent.display_name}
                size="nav"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  Agent info
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {agent.display_name} · Settings & activity
                </span>
              </span>
              <Icon
                className="shrink-0 text-muted-foreground"
                icon={ArrowUpRight01Icon}
                size={14}
              />
            </button>
          ) : null}
          <button
            aria-label="Documents"
            className={rowClassName}
            onClick={() => onCreate("file")}
            type="button"
          >
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-bluebell-500 text-white"
            >
              <Icon icon={File01Icon} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">
                Documents
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {documentCount > 0
                  ? `${documentCount} shared ${documentCount === 1 ? "document" : "documents"}`
                  : "Browse files shared in this conversation"}
              </span>
            </span>
            <Icon
              className="shrink-0 text-muted-foreground"
              icon={ArrowUpRight01Icon}
              size={14}
            />
          </button>
          <button
            aria-label="Collaboration"
            className={rowClassName}
            onClick={() => onCreate("collaboration")}
            type="button"
          >
            <span
              aria-hidden
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-lavender-500 text-white"
            >
              <Icon icon={HierarchyIcon} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">
                Collaboration
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Agent responsibilities and relationships
              </span>
            </span>
            <Icon
              className="shrink-0 text-muted-foreground"
              icon={ArrowUpRight01Icon}
              size={14}
            />
          </button>
        </div>
        <p className="mt-6 border-t border-border/60 pt-4 text-xs text-muted-foreground">
          Open a message thread, document, or routine to view it here. Your chat
          stays in place.
        </p>
      </div>
    </div>
  );
}
