import { formatDateTime } from "@/lib/date-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock01Icon,
  Comment01Icon,
  Copy01Icon,
  Link04Icon,
  LinkSquare02Icon,
  SecurityCheckIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

export function RoomHistoryShareDialog({
  roomId,
  canCreate = true,
  onClose,
}: {
  roomId: string;
  canCreate?: boolean;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const queryKey = ["room-history-shares", roomId];
  const history = useQuery({
    queryKey,
    queryFn: () => client.roomHistory.list(roomId),
  });
  const [link, setLink] = useState("");
  const [snapshotLinks, setSnapshotLinks] = useState<Record<string, string>>(
    {},
  );
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  const create = useMutation({
    mutationFn: () => client.roomHistory.create(roomId),
    onSuccess: async (share) => {
      const value = shareUrl(share.token);
      if (!value) return;
      setLink(value);
      // Remember it against its snapshot too: issuing a link replaces the
      // stored token, so reusing this one keeps the shared address stable.
      setSnapshotLinks((current) => ({ ...current, [share.id]: value }));
      await copy(value);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.roomHistory.revoke(roomId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  // Opening a snapshot whose token this session already holds must not issue a
  // new one; the server keeps a single token per snapshot, so reissuing would
  // break the link that was already copied.
  const [pendingOpen, setPendingOpen] = useState<Window | null>(null);
  const issueLink = useMutation({
    mutationFn: (shareId: string) => client.roomHistory.link(roomId, shareId),
    onSuccess: (share) => {
      const value = shareUrl(share.token);
      if (!value) return;
      setSnapshotLinks((current) => ({ ...current, [share.id]: value }));
      openShare(value, pendingOpen);
      setPendingOpen(null);
    },
    onError: () => {
      pendingOpen?.close();
      setPendingOpen(null);
    },
  });
  return (
    <ModalDialog
      description="Create a read-only snapshot for sharing or debugging."
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      size="md"
      title="Share conversation"
    >
      <div className="px-5 py-4">
        <div className="rounded-xl border border-app-border bg-app-surface-soft p-4">
          <div className="flex items-start gap-3">
            <Icon
              icon={SecurityCheckIcon}
              className="mt-0.5 shrink-0 text-app-info"
            />
            <p className="text-sm leading-6 text-app-body">
              Anyone with the link can read messages sent up to now, without
              signing in. New messages and later changes are not included. Files
              appear as cards; source documents stay private.
            </p>
          </div>
        </div>
        {link ? (
          <div className="mt-4 rounded-xl border border-app-info/30 bg-app-info/5 p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label
                className="text-xs font-medium uppercase tracking-[0.06em] text-app-info"
                htmlFor="room-share-link"
              >
                Conversation link
              </label>
              {copied ? (
                <span className="flex items-center gap-1 text-xs text-app-info">
                  <Icon icon={Tick02Icon} size={14} /> Copied
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                id="room-share-link"
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-sm outline-none transition-colors hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring"
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                aria-label="Copy conversation link"
                size="compactIcon"
                tone="secondary"
                onClick={() => void copy(link)}
              >
                <Icon icon={Copy01Icon} />
              </Button>
            </div>
            {copyError ? (
              <p role="status" className="mt-2 text-xs text-app-muted">
                Select the link above to copy it.
              </p>
            ) : null}
          </div>
        ) : (
          <Button
            className="mt-4 w-full"
            tone="primary"
            disabled={create.isPending || !canCreate}
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <Spinner size={16} />
            ) : (
              <Icon icon={Link04Icon} />
            )}
            {create.isPending ? "Creating snapshot..." : "Create share link"}
          </Button>
        )}
        {create.error || revoke.error || issueLink.error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-app-danger/30 bg-app-danger/5 px-3 py-2 text-sm text-app-danger"
          >
            {(create.error ?? revoke.error ?? issueLink.error)?.message}
          </p>
        ) : null}
        <section className="mt-7 border-t border-app-border pt-5">
          <div>
            <h3 className="text-sm font-semibold text-app-ink">
              Shared snapshots
              <span className="ml-1.5 text-xs font-normal text-app-muted">
                {history.data?.items.length ?? 0}
              </span>
            </h3>
            <p className="mt-1 text-xs leading-5 text-app-muted">
              Each item is a frozen copy of the conversation at that time.
            </p>
          </div>
          {history.isPending ? (
            <div
              aria-label="Loading shared snapshots"
              className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 px-3 py-4 text-sm text-app-muted"
              role="status"
            >
              <Spinner size={16} className="text-app-info" />
              Loading shared snapshots...
            </div>
          ) : null}
          {history.error ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-app-danger/30 bg-app-danger/5 px-3 py-2 text-sm text-app-danger"
            >
              Shared snapshots could not be loaded.
            </p>
          ) : null}
          <ul className="mt-4 max-h-72 space-y-2 overflow-y-auto">
            {history.data?.items.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-app-border bg-card p-3 text-sm transition-colors hover:bg-accent/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-app-ink">
                      <Icon
                        icon={Clock01Icon}
                        size={14}
                        className="text-app-muted"
                      />
                      {formatDateTime(item.created_at)}
                    </span>
                    <small className="mt-1 flex items-center gap-1.5 text-xs text-app-muted">
                      <Icon icon={Comment01Icon} size={14} />
                      {item.message_count} messages
                    </small>
                    {!item.revoked ? (
                      <Button
                        aria-label={`Open shared link from ${formatDateTime(item.created_at)}`}
                        className="mt-2 self-start"
                        disabled={issueLink.isPending}
                        size="compactIcon"
                        title="Open shared link"
                        tone="ghost"
                        onClick={() => {
                          const known = snapshotLinks[item.id];
                          if (known) {
                            openShare(known);
                            return;
                          }
                          // Reserve the tab inside the click so the browser does
                          // not treat the post-request open as a popup.
                          setPendingOpen(reserveShareTab());
                          issueLink.mutate(item.id);
                        }}
                      >
                        <Icon icon={LinkSquare02Icon} size={14} />
                      </Button>
                    ) : null}
                  </span>
                  {item.revoked ? (
                    <span className="rounded-sm bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Revoked
                    </span>
                  ) : (
                    <Button
                      size="compact"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(item.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </ModalDialog>
  );
}

/** Reserved inside the click so issuing a token first is not blocked. */
function reserveShareTab() {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

function openShare(value: string, reserved?: Window | null) {
  if (reserved && !reserved.closed) {
    reserved.location.replace(value);
    return;
  }
  window.open(value, "_blank", "noopener,noreferrer");
}

function shareUrl(token?: string | null) {
  if (!token) return undefined;
  const value = new URL("/shared-room-history", window.location.origin);
  value.hash = token;
  return value.toString();
}
