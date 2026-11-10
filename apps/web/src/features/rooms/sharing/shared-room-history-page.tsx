import { formatDateTime } from "@/lib/date-format";
import { useInfiniteQuery } from "@tanstack/react-query";
import { File01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { RoomHistoryMessage } from "@/features/teamhub/teamhub-room-history";
import { MessageMarkdown } from "../chat/message-markdown";
import { ActorAvatar } from "../members/actor-avatar";
import { avatarKeyFromSeed } from "../members/agent-avatar";
import { formatBytes } from "@/lib/format-bytes";

export function SharedRoomHistoryPage() {
  const token = useLocation().hash.slice(1);
  return <SharedHistory key={token} token={token} />;
}
function SharedHistory({ token }: { token: string }) {
  const { client } = useTeamHubRuntime();
  const valid = /^room_share_[A-Za-z0-9_-]{43}$/.test(token);
  const query = useInfiniteQuery({
    queryKey: ["shared-room-history", token],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      client.roomHistory.read(token, pageParam, signal),
    getNextPageParam: (page) => page.next_after || undefined,
    enabled: valid,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const share = query.data?.pages[0]?.share;
  return (
    <main className="min-h-dvh bg-app-surface text-app-body">
      <header className="border-b border-app-border px-6 py-5">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-lg">
            {share?.room_name ?? "Shared conversation"}
          </h1>
          <p className="mt-1 text-xs text-app-muted">
            Read-only snapshot
            {share ? ` · ${formatDateTime(share.created_at)}` : ""}
          </p>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-6">
        {!valid || query.error ? (
          <p role="alert">
            This shared conversation is unavailable or has been revoked. Ask the
            person who shared it for a new link.
          </p>
        ) : query.isPending ? (
          <p
            className="flex items-center gap-2 text-sm text-app-muted"
            role="status"
          >
            <Spinner size={16} />
            Loading conversation…
          </p>
        ) : (
          <>
            {share?.message_count === 0 ? (
              <p className="text-sm text-app-muted">
                No messages had been sent when this snapshot was created.
              </p>
            ) : null}
            <div className="space-y-7">
              {query.data.pages.flatMap((page) =>
                page.items.map((message) => (
                  <SnapshotMessage
                    key={message.id}
                    message={message}
                    token={token}
                  />
                )),
              )}
            </div>
            {query.hasNextPage ? (
              <Button
                className="mt-6"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Load more messages
              </Button>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
function SnapshotMessage({
  message,
  token,
}: {
  message: RoomHistoryMessage;
  token: string;
}) {
  return (
    <article
      className="flex gap-3"
      aria-label={`Message from ${message.author.display_name}`}
    >
      {message.avatar_image ? (
        <img
          alt={`${message.author.display_name} avatar`}
          src={message.avatar_image}
          className="size-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <ActorAvatar
          avatarKey={avatarKeyFromSeed(message.author.id)}
          actorId={message.author.id}
          kind={message.author.kind}
          name={message.author.display_name}
          size="nav"
        />
      )}
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-semibold">
            {message.author.display_name}
          </span>
          <time
            className="text-xs text-app-muted"
            dateTime={message.created_at}
          >
            {formatDateTime(message.created_at)}
          </time>
        </header>
        <div className="break-words text-sm leading-6">
          <MessageMarkdown
            authorKind={message.author.kind}
            body={message.body}
            segments={message.segments}
            readOnlyReferences
            documentReferences={message.segments.filter(
              (segment) => segment.type === "document",
            )}
          />
        </div>
        {message.card ? (
          <section className="my-3 rounded-xl border border-app-border bg-app-surface-soft p-4">
            <h3 className="font-medium">{message.card.title}</h3>
            <MessageMarkdown
              authorKind="agent"
              body={message.card.description}
              readOnlyReferences
            />
            <p className="mt-2 text-xs text-app-muted">{message.card.status}</p>
          </section>
        ) : null}
        {message.attachments.map((file) => (
          <div key={file.id} className="mt-3">
            {file.image_asset_id ? (
              <SnapshotImage
                token={token}
                assetId={file.image_asset_id}
                filename={file.filename}
              />
            ) : (
              <div className="flex items-center gap-3 rounded-lg border border-app-border bg-card p-3 text-sm">
                <Icon
                  icon={File01Icon}
                  size={20}
                  className="shrink-0 text-app-muted"
                />
                <div className="min-w-0">
                  <p className="truncate">{file.filename}</p>
                  <p className="text-xs text-app-muted">
                    {file.media_type} · {formatBytes(file.size_bytes)}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}
function SnapshotImage({
  token,
  assetId,
  filename,
}: {
  token: string;
  assetId: string;
  filename: string;
}) {
  const { client } = useTeamHubRuntime();
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    void client.roomHistory
      .image(token, assetId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, token, assetId]);
  return url ? (
    <img
      alt={filename}
      src={url}
      className="max-h-[32rem] max-w-full rounded-lg object-contain"
    />
  ) : (
    <p className="text-xs text-app-muted">
      {failed ? `Image unavailable: ${filename}` : "Loading image..."}
    </p>
  );
}
