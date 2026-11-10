import {
  File01Icon,
  PencilEdit01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";

import { Icon } from "@/components/ui/icon";

import type {
  TeamHubActorRef,
  TeamHubDocument,
} from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "../members/actor-avatar";
import { RoomAvatar } from "../members/room-avatar";
import { cn } from "@/lib/cn";

type InfoView = "agents" | "files";

export function RoomInfoPanel({
  documents,
  hidden = false,
  members,
  onOpenDocument,
  onOpenRoomSettings,
  roomName,
}: {
  documents: TeamHubDocument[];
  hidden?: boolean;
  members: TeamHubActorRef[];
  onOpenDocument?: (document: TeamHubDocument) => void;
  onOpenRoomSettings?: () => void;
  roomName: string;
}) {
  const [view, setView] = useState<InfoView>("agents");

  return (
    <div
      className={
        hidden
          ? "hidden"
          : "@container/sidebar workspace-scrollbar h-full overflow-y-auto bg-card"
      }
      data-testid="panel-room-info"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="mx-auto w-full max-w-[760px] px-3 pb-8 @min-[380px]/sidebar:px-4">
        <header className="flex min-h-[218px] flex-col items-center justify-center pb-3 text-center @min-[500px]/sidebar:min-h-[238px]">
          <RoomAvatar members={members} size="lg" />
          <div className="mt-4 flex max-w-full items-center gap-1.5">
            <h1 className="truncate text-xl text-foreground">{roomName}</h1>
            {onOpenRoomSettings ? (
              <button
                aria-label="Edit Room"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={onOpenRoomSettings}
                title="Edit Room"
                type="button"
              >
                <Icon icon={PencilEdit01Icon} size={14} />
              </button>
            ) : null}
          </div>
          <div
            aria-label={`${members.length} ${members.length === 1 ? "member" : "members"}`}
            className="mt-5 flex h-7 items-center justify-center rounded-full bg-muted px-2.5"
          >
            <div className="flex items-center pl-1">
              {members.slice(0, 7).map((member, index) => (
                <span
                  className={cn(
                    "rounded-full ring-1 ring-card",
                    index ? "-ml-1" : false,
                  )}
                  key={member.id}
                >
                  <ActorAvatar
                    actorId={member.id}
                    kind={member.kind}
                    name={member.display_name}
                    size="micro"
                  />
                </span>
              ))}
            </div>
            <span className="ml-1.5 text-2xs tabular-nums text-muted-foreground">
              {members.length}
            </span>
          </div>
        </header>

        <div
          aria-label="Room info sections"
          className="mt-6 flex items-center gap-1"
          role="tablist"
        >
          {(["agents", "files"] as const).map((item) => {
            const selected = item === view;
            return (
              <button
                aria-selected={selected}
                className={cn(
                  "h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-sm font-medium capitalize transition-colors duration-150",
                  selected
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
                key={item}
                onClick={() => setView(item)}
                role="tab"
                type="button"
              >
                {item}
              </button>
            );
          })}
        </div>

        <div className="pt-2">
          {view === "agents" ? (
            members.length ? (
              <div className="space-y-1">
                {members.map((member) => (
                  <div
                    className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-300 hover:bg-muted/70"
                    key={member.id}
                  >
                    <ActorAvatar
                      actorId={member.id}
                      kind={member.kind}
                      name={member.display_name}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {member.display_name}
                    </span>
                    <span className="text-xs capitalize text-muted-foreground">
                      {member.kind}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyInfo label="No members" />
            )
          ) : documents.length ? (
            <div className="space-y-1">
              {documents.map((document) => (
                <button
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-300 hover:bg-muted/70"
                  key={document.id}
                  onClick={() => onOpenDocument?.(document)}
                  type="button"
                >
                  <Icon
                    className="text-muted-foreground"
                    icon={File01Icon}
                    size={14}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {document.title}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyInfo label="No Room files" />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyInfo({ label }: { label: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-border px-3 text-center text-sm text-muted-foreground">
      <Icon className="mr-2" icon={UserGroupIcon} size={14} />
      {label}
    </div>
  );
}
