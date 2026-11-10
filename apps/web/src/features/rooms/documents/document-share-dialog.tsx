import { useQuery } from "@tanstack/react-query";
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  RefreshIcon,
  UserAdd01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { writeClipboardText } from "@/lib/clipboard";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import { DocumentLinkSharing } from "./document-link-sharing";
import type { TeamHubDocumentShareViewV2 } from "@/features/teamhub/teamhub-types";

const roles = ["viewer", "editor", "manager"] as const;
type DirectRole = (typeof roles)[number];

export function DocumentShareDialog({
  client,
  documentId,
  onClose,
  ownerActorId,
  tenantId,
}: {
  client: TeamHubClient;
  documentId: string;
  onClose: () => void;
  ownerActorId: string;
  tenantId: string;
}) {
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [view, setView] = useState<"share" | "manage">("share");
  const share = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/documents/{documentId}/collaborators", {
          params: { path: { documentId } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "document-share", documentId],
  });
  const actors = useQuery({
    enabled: share.data !== undefined,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/actors", {
          params: { path: { tenantId }, query: { limit: 100 } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "document-share-actors"],
    staleTime: 60_000,
  });
  const existingActorIds = useMemo(
    () =>
      new Set(
        share.data?.sources.flatMap((item) =>
          item.source.source_kind === "direct" &&
          item.source.status === "active" &&
          item.source.target?.kind === "agent"
            ? [item.source.target.id]
            : [],
        ) ?? [],
      ),
    [share.data],
  );
  const availableActors =
    actors.data?.items.filter(
      (actor) =>
        actor.kind === "agent" &&
        actor.id !== ownerActorId &&
        !existingActorIds.has(actor.id),
    ) ?? [];

  async function copyCanonicalLink() {
    if (!share.data?.general_access?.canonical_url) return;
    setActionError(null);
    try {
      await writeClipboardText(
        new URL(
          share.data.general_access.canonical_url,
          window.location.origin,
        ).toString(),
      );
    } catch {
      setActionError("The Document link could not be copied.");
    }
  }

  async function inviteCollaborators(
    targetIds: string[],
    inviteRole: DirectRole,
  ) {
    if (!targetIds.length || pendingSourceId) return;
    setActionError(null);
    setPendingSourceId("invite");
    try {
      await Promise.all(
        targetIds.map((targetId) =>
          teamHubData(
            client.api.POST("/v0/documents/{documentId}/collaborators", {
              params: { path: { documentId } },
              body: { role: inviteRole, target_actor_id: targetId },
            }),
          ),
        ),
      );
      await share.refetch();
    } catch {
      setActionError(
        "Some collaborators could not be invited. Refresh and try again.",
      );
    } finally {
      setPendingSourceId(null);
    }
  }

  async function removeFromRoom(roomId: string, version: number) {
    if (pendingSourceId) return;
    setActionError(null);
    setPendingSourceId(`room:${roomId}`);
    try {
      await teamHubData(
        client.api.POST(
          "/v0/documents/{documentId}/room-bindings/{roomId}/remove",
          {
            params: { path: { documentId, roomId } },
            body: { expected_version: version },
          },
        ),
      );
      await share.refetch();
    } catch {
      setActionError(
        "The Document could not be removed from this Room. Refresh and try again.",
      );
      throw new Error("Remove from Room failed");
    } finally {
      setPendingSourceId(null);
    }
  }

  async function updateCollaborator(
    sourceId: string,
    version: number,
    role: DirectRole,
  ) {
    if (pendingSourceId) return;
    setActionError(null);
    setPendingSourceId(sourceId);
    try {
      await teamHubData(
        client.api.PATCH(
          "/v0/documents/{documentId}/collaborators/{sourceId}",
          {
            params: { path: { documentId, sourceId } },
            body: { expected_version: version, role },
          },
        ),
      );
      await share.refetch();
    } catch {
      setActionError("The collaborator permission could not be updated.");
    } finally {
      setPendingSourceId(null);
    }
  }

  async function removeCollaborator(sourceId: string, version: number) {
    if (pendingSourceId) return;
    setActionError(null);
    setPendingSourceId(sourceId);
    try {
      await teamHubData(
        client.api.POST(
          "/v0/documents/{documentId}/collaborators/{sourceId}/revoke",
          {
            params: { path: { documentId, sourceId } },
            body: { expected_version: version },
          },
        ),
      );
      await share.refetch();
    } catch {
      setActionError("The collaborator could not be removed.");
    } finally {
      setPendingSourceId(null);
    }
  }

  return (
    <ModalDialog
      ariaLabel="Share Document"
      className="flex flex-col overflow-hidden"
      closeOnBackdrop
      onClose={onClose}
      size="lg"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-app-border px-4 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {view === "manage" ? (
                <Button
                  aria-label="Back to share"
                  onClick={() => setView("share")}
                  size="compactIcon"
                  tone="ghost"
                >
                  <Icon icon={ArrowLeft01Icon} />
                </Button>
              ) : null}
              <h2 className="text-base font-semibold text-app-ink">
                {view === "manage" ? "Manage collaborators" : "Share"}
              </h2>
            </div>
            {share.data ? (
              <p className="mt-0.5 text-xs text-app-muted">
                Your access: {roleLabel(share.data.caller_content_role)}
              </p>
            ) : null}
          </div>
        </header>

        <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {share.isPending ? (
            <ShareLoading />
          ) : share.error ? (
            <div
              className="flex min-h-48 flex-col items-center justify-center gap-3 text-center"
              role="alert"
            >
              <Icon icon={Alert02Icon} size={20} className="text-app-danger" />
              <p className="max-w-sm text-sm text-app-body">
                Sharing settings are unavailable.
              </p>
              <Button onClick={() => void share.refetch()} tone="secondary">
                <Icon icon={RefreshIcon} size={14} /> Retry
              </Button>
            </div>
          ) : share.data ? (
            view === "manage" ? (
              <ManageCollaborators
                actionError={actionError}
                actors={actors.data?.items ?? []}
                onRemove={removeCollaborator}
                onRemoveFromRoom={removeFromRoom}
                onUpdate={updateCollaborator}
                pendingSourceId={pendingSourceId}
                share={share.data}
              />
            ) : (
              <ShareContent
                actionError={actionError}
                actorsError={actors.error}
                actorsPending={actors.isPending}
                availableActors={availableActors}
                onInvite={inviteCollaborators}
                onManage={() => setView("manage")}
                onCopyLink={() => void copyCanonicalLink()}
                onRefresh={() => {
                  setActionError(null);
                  void share.refetch();
                }}
                onRemoveFromRoom={removeFromRoom}
                onRetryActors={() => void actors.refetch()}
                pendingSourceId={pendingSourceId}
                share={share.data}
              />
            )
          ) : null}
          {view === "share" &&
          share.data &&
          ["owner", "manager"].includes(share.data.caller_content_role) ? (
            <DocumentLinkSharing
              key={documentId}
              client={client}
              documentId={documentId}
            />
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}

function ShareContent({
  actionError,
  actorsError,
  actorsPending,
  availableActors,
  onInvite,
  onManage,
  onCopyLink,
  onRefresh,
  onRemoveFromRoom,
  onRetryActors,
  pendingSourceId,
  share,
}: {
  [key: string]: unknown;
  actionError: string | null;
  actorsError: Error | null;
  actorsPending: boolean;
  availableActors: {
    display_name: string;
    id: string;
    kind: "human" | "agent";
  }[];
  onInvite: (targetIds: string[], role: DirectRole) => Promise<void>;
  onManage: () => void;
  onCopyLink: () => void;
  onRefresh: () => void;
  onRemoveFromRoom: (roomId: string, version: number) => Promise<void>;
  onRetryActors: () => void;
  pendingSourceId: string | null;
  share: TeamHubDocumentShareViewV2;
}) {
  const direct = share.sources.filter((item) => sourceGroup(item) === "direct");
  const rooms = share.sources.filter(
    (item) =>
      item.source.source_kind === "context" &&
      item.source.status === "active" &&
      item.source.provenance.binding_kind === "room" &&
      item.source.provenance.context_id,
  );
  const collaboratorActors = direct.flatMap((item) => {
    const target = item.source.target;
    if (target?.kind !== "agent") {
      return [];
    }
    return [{ id: target.id, kind: target.kind, name: item.label }];
  });
  return (
    <div className="space-y-7">
      {actionError ? (
        <div
          className="flex items-start justify-between gap-3 rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-hover)] px-3 py-2 text-sm text-app-danger"
          role="alert"
        >
          <span>{actionError}</span>
          <Button onClick={onRefresh} size="compact" tone="secondary">
            Refresh
          </Button>
        </div>
      ) : null}
      {pendingSourceId ? (
        <p
          aria-label="Share change status"
          className="text-sm text-app-muted"
          role="status"
        >
          Saving access...
        </p>
      ) : null}
      <section aria-labelledby="invite-collaborators-heading">
        <div className="flex items-center justify-between gap-3">
          <h3
            className="text-base font-semibold text-app-ink"
            id="invite-collaborators-heading"
          >
            Invite collaborators
          </h3>
          <CollaboratorAvatarButton
            actors={collaboratorActors}
            count={direct.length + rooms.length}
            onClick={onManage}
          />
        </div>
        <InviteCollaboratorsField
          actorsError={actorsError}
          actorsPending={actorsPending}
          availableActors={availableActors}
          disabled={!share.can_manage_collaborators || pendingSourceId !== null}
          onInvite={onInvite}
          onRetry={onRetryActors}
        />
      </section>
      {rooms.length ? (
        <RoomBindingSection
          disabled={!share.can_manage_collaborators || pendingSourceId !== null}
          onRemove={onRemoveFromRoom}
          rooms={rooms}
        />
      ) : null}
      <CopyLinkSection onCopyLink={onCopyLink} />
    </div>
  );
}

function CollaboratorAvatarButton({
  actors,
  count,
  onClick,
}: {
  actors: { id: string; kind: "human" | "agent"; name: string }[];
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`Manage ${count} active collaborators`}
      className="flex min-h-9 items-center rounded-full px-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      type="button"
    >
      <span className="flex -space-x-1.5">
        {actors.slice(0, 4).map((actor) => (
          <span className="rounded-full ring-2 ring-app-surface" key={actor.id}>
            <ActorAvatar
              actorId={actor.id}
              kind={actor.kind}
              name={actor.name}
              size="xs"
            />
          </span>
        ))}
        {count > actors.length || actors.length === 0 ? (
          <span className="flex size-7 items-center justify-center rounded-full bg-app-sidebar text-app-muted ring-2 ring-app-surface">
            <Icon icon={UserGroupIcon} size={14} />
          </span>
        ) : null}
      </span>
      <span className="ml-2 text-xs font-medium text-app-muted">
        {count} active
      </span>
    </button>
  );
}

function ManageCollaborators({
  actionError,
  actors,
  onRemove,
  onRemoveFromRoom,
  onUpdate,
  pendingSourceId,
  share,
}: {
  actionError: string | null;
  actors: { display_name: string; id: string; kind: "human" | "agent" }[];
  onRemove: (sourceId: string, version: number) => Promise<void>;
  onRemoveFromRoom: (roomId: string, version: number) => Promise<void>;
  onUpdate: (
    sourceId: string,
    version: number,
    role: DirectRole,
  ) => Promise<void>;
  pendingSourceId: string | null;
  share: TeamHubDocumentShareViewV2;
}) {
  const [removeTarget, setRemoveTarget] = useState<
    TeamHubDocumentShareViewV2["sources"][number] | null
  >(null);
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const direct = share.sources.filter(
    (item) => sourceGroup(item) === "direct" && item.source.status === "active",
  );
  const rooms = share.sources.filter(
    (item) =>
      item.source.source_kind === "context" &&
      item.source.status === "active" &&
      item.source.provenance.binding_kind === "room" &&
      item.source.provenance.context_id,
  );
  const disabled = !share.can_manage_collaborators || pendingSourceId !== null;

  return (
    <div className="space-y-6">
      {actionError ? (
        <p
          className="rounded-lg bg-[var(--app-danger-hover)] px-3 py-2 text-sm text-app-danger"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}
      <section aria-labelledby="direct-collaborators-heading">
        <h3
          className="text-sm font-medium text-app-muted"
          id="direct-collaborators-heading"
        >
          Agents with direct access
        </h3>
        {direct.length ? (
          <div className="mt-2 divide-y divide-app-border">
            {direct.map((item) => {
              const target = item.source.target;
              if (target?.kind !== "agent") {
                return null;
              }
              const actor = actorById.get(target.id);
              return (
                <div
                  className="flex min-h-16 items-center gap-3 py-2"
                  key={item.source.source_id}
                >
                  <ActorAvatar
                    actorId={target.id}
                    kind={target.kind}
                    name={actor?.display_name ?? item.label}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-app-ink">
                      {actor?.display_name ?? item.label}
                    </p>
                    <p className="text-xs text-app-muted">Agent</p>
                  </div>
                  <Select
                    aria-label={`${item.label} permission`}
                    className="w-auto"
                    disabled={disabled}
                    onValueChange={(role) => {
                      if (role === "remove") {
                        setRemoveTarget(item);
                        return;
                      }
                      void onUpdate(
                        item.source.source_id,
                        item.source.source_version,
                        role as DirectRole,
                      );
                    }}
                    value={item.source.role}
                  >
                    {roles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabel(role)}
                      </SelectItem>
                    ))}
                    <SelectItem value="remove">Remove access</SelectItem>
                  </Select>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-sm text-app-muted">
            No direct collaborators yet.
          </p>
        )}
      </section>
      {rooms.length ? (
        <RoomBindingSection
          disabled={disabled}
          onRemove={onRemoveFromRoom}
          rooms={rooms}
        />
      ) : null}
      {removeTarget ? (
        <ModalDialog
          closeOnBackdrop
          onClose={() => setRemoveTarget(null)}
          size="sm"
          title={`Remove ${removeTarget.label}?`}
          footer={
            <>
              <Button onClick={() => setRemoveTarget(null)} tone="ghost">
                Cancel
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  void onRemove(
                    removeTarget.source.source_id,
                    removeTarget.source.source_version,
                  ).then(() => setRemoveTarget(null));
                }}
                tone="danger"
              >
                Remove access
              </Button>
            </>
          }
        >
          <p className="px-5 py-4 text-sm text-app-muted">
            Their direct access will be removed. Access from a Room, Task, or
            Wiki is not affected.
          </p>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function RoomBindingSection({
  disabled,
  onRemove,
  rooms,
}: {
  disabled: boolean;
  onRemove: (roomId: string, version: number) => Promise<void>;
  rooms: TeamHubDocumentShareViewV2["sources"];
}) {
  const [selected, setSelected] = useState<
    TeamHubDocumentShareViewV2["sources"][number] | null
  >(null);
  return (
    <section
      aria-labelledby="shared-rooms-heading"
      className="border-t border-app-border pt-5"
    >
      <h3
        className="text-sm font-semibold text-app-ink"
        id="shared-rooms-heading"
      >
        Shared with Rooms
      </h3>
      <div className="mt-2 divide-y divide-app-border">
        {rooms.map((room) => (
          <div
            className="flex min-h-11 items-center justify-between gap-3"
            key={room.source.source_id}
          >
            <div className="min-w-0">
              <span className="block truncate text-sm text-app-ink">
                {room.label}
              </span>
              <span className="block text-xs text-app-muted">
                {roleLabel(room.source.role)}
              </span>
            </div>
            <Button
              disabled={disabled}
              onClick={() => setSelected(room)}
              size="compact"
              tone="ghost"
            >
              Remove from Room
            </Button>
          </div>
        ))}
      </div>
      {selected?.source.provenance.context_id ? (
        <ModalDialog
          closeOnBackdrop
          onClose={() => setSelected(null)}
          size="sm"
          title={`Remove from ${selected.label}?`}
          footer={
            <>
              <Button onClick={() => setSelected(null)} tone="ghost">
                Cancel
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  void onRemove(
                    selected.source.provenance.context_id!,
                    selected.source.source_version,
                  ).then(() => setSelected(null));
                }}
                tone="danger"
              >
                Remove
              </Button>
            </>
          }
        >
          <p className="px-5 py-4 text-sm text-app-muted">
            Room members will lose this source. Direct, Task, and Wiki access
            are not affected.
          </p>
        </ModalDialog>
      ) : null}
    </section>
  );
}

function CopyLinkSection({ onCopyLink }: { onCopyLink: () => void }) {
  return (
    <section className="border-t border-app-border pt-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-app-ink">Document link</h3>
          <p className="mt-1 text-xs text-app-muted">
            Copying the link does not change who can access this document.
          </p>
        </div>
        <Button onClick={onCopyLink} tone="secondary">
          <Icon icon={Copy01Icon} size={14} /> Copy link
        </Button>
      </div>
    </section>
  );
}

function InviteCollaboratorsField({
  actorsError,
  actorsPending,
  availableActors,
  disabled,
  onInvite,
  onRetry,
}: {
  actorsError: Error | null;
  actorsPending: boolean;
  availableActors: {
    display_name: string;
    id: string;
    kind: "human" | "agent";
  }[];
  disabled: boolean;
  onInvite: (targetIds: string[], role: DirectRole) => Promise<void>;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = new Set(selected);
  const [role, setRole] = useState<DirectRole>("viewer");
  const filtered = availableActors.filter((actor) =>
    actor.display_name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="mt-3">
      <div className="flex items-center rounded-lg border border-input bg-card pr-1 transition-colors hover:border-border-hover focus-within:border-foreground focus-within:ring-2 focus-within:ring-ring">
        <input
          aria-label="Search collaborators"
          className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm text-app-ink outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="Search Agents"
          value={query}
        />
        <Button
          aria-label="Add collaborators"
          disabled={disabled}
          onClick={() => setOpen(true)}
          size="icon"
          tone="ghost"
        >
          <Icon icon={UserAdd01Icon} />
        </Button>
      </div>
      {open ? (
        <div className="mt-2 overflow-hidden rounded-md border border-app-border bg-popover shadow-md">
          {actorsPending ? (
            <p className="px-3 py-3 text-sm text-app-muted">
              Loading collaborators...
            </p>
          ) : actorsError ? (
            <button
              className="px-3 py-3 text-sm text-app-danger"
              onClick={onRetry}
              type="button"
            >
              Unable to load. Retry
            </button>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-3 text-sm text-app-muted">
              No matching collaborators.
            </p>
          ) : (
            <div className="max-h-52 overflow-y-auto p-1">
              {filtered.map((actor) => {
                const checked = selectedSet.has(actor.id);
                return (
                  <button
                    className="flex min-h-11 w-full items-center justify-between rounded-sm px-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    key={actor.id}
                    onClick={() =>
                      setSelected((current) =>
                        checked
                          ? current.filter((id) => id !== actor.id)
                          : [...current, actor.id],
                      )
                    }
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">
                        {actor.display_name}
                      </span>
                      <span className="block text-xs text-app-muted">
                        {actor.kind === "agent" ? "Agent" : "Person"}
                      </span>
                    </span>
                    <span
                      className={
                        checked ? "font-medium text-app-ink" : "text-app-muted"
                      }
                    >
                      {checked ? "Selected" : "Select"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-app-border px-3 py-2">
            <Select
              aria-label="Invite role"
              className="h-8 w-auto"
              onValueChange={(value) => setRole(value as DirectRole)}
              value={role}
            >
              {roles.map((option) => (
                <SelectItem key={option} value={option}>
                  {roleLabel(option)}
                </SelectItem>
              ))}
            </Select>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setOpen(false);
                  setSelected([]);
                }}
                size="compact"
                tone="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={!selected.length || disabled}
                onClick={() =>
                  void onInvite(selected, role).then(() => {
                    setOpen(false);
                    setSelected([]);
                  })
                }
                size="compact"
              >
                Invite{selected.length ? ` (${selected.length})` : ""}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShareLoading() {
  return (
    <div aria-label="Share loading" className="space-y-3" role="status">
      <span className="sr-only">Loading access</span>
      {[0, 1, 2].map((item) => (
        <div
          className="h-12 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
          key={item}
        />
      ))}
    </div>
  );
}

function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
function sourceGroup(item: TeamHubDocumentShareViewV2["sources"][number]) {
  return item.source_group ?? item.source.source_kind;
}
