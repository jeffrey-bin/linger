import {
  ArrowDown01Icon,
  Cancel01Icon,
  Clock01Icon,
  File01Icon,
  Link01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { AppLogo } from "@/features/apps/app-logo";
import {
  ConnectAppStatus,
  useConnectAppFlow,
} from "@/features/apps/connect-app-flow";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import { activeExternalConnections } from "@/features/apps/connection-state";
import { teamHubDone } from "@/features/teamhub/teamhub-api";
import {
  createTeamHubIdempotencyKey,
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
  TeamHubMessageAttachmentUpload,
} from "@/features/teamhub/teamhub-types";

import { CardActions, CardError } from "./approval-card-parts";
import { CardBox, CardDone } from "./card-shell";
import { connectedAppDisplayName } from "./connected-app-names";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

type Card = DecisionMessageCard;
type SetupDecision = "connected" | "done" | "skipped";

interface Props {
  card: Card;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
  roomId: string;
}

// The sources card mirrors TeamHub's answer limits.
const MAX_LINKS = 5;
const MAX_LINK_LENGTH = 2048;
const MAX_FILES = 5;

const listClassName = "flex w-full flex-col";
const rowClassName = "flex min-h-12 min-w-0 items-center gap-2.5 p-2";

/** The AnotherMe setup decisions: connect an app, then share links or files
 * through the link and upload slot. An answered card keeps its box with how
 * it ended in place of the replies. */
export function ProfileSetupDecision(props: Props) {
  return props.card.kind === "profile_setup_apps" ? (
    <ProfileSetupApps {...props} />
  ) : (
    <ProfileSetupSources {...props} />
  );
}

/** The Agent's ask, then the rows and the replies, or how it ended. */
function SetupCard({
  actions,
  card,
  children,
  error,
}: {
  actions?: ReactNode;
  card: Card;
  children?: ReactNode;
  error?: string | null;
}) {
  const done = card.status === "pending" ? null : setupDone(card);
  return (
    <>
      <CardBox heading={card.title} label="AnotherMe setup">
        {children}
        {done ? (
          <CardDone icon={done.icon} text={done.text} tone={done.tone} />
        ) : actions ? (
          <CardActions>{actions}</CardActions>
        ) : null}
        {error ? <CardError>{error}</CardError> : null}
      </CardBox>
    </>
  );
}

/** How an answered setup card ended, in a few words. */
function setupDone(card: Card) {
  const decision =
    card.status === "answered" ? card.answer?.decision : undefined;
  const links = card.answer?.links?.length ?? 0;
  const files = card.answer?.attachment_upload_ids?.length ?? 0;
  const shared = [
    links ? plural(links, "link") : "",
    files ? plural(files, "file") : "",
  ]
    .filter(Boolean)
    .join(" and ");
  if (decision === "connected")
    return { icon: Tick02Icon, text: "Connected", tone: "success" as const };
  if (decision === "done")
    return {
      icon: Tick02Icon,
      text: shared ? `Shared ${shared}` : "Nothing shared",
      tone: "success" as const,
    };
  if (decision === "skipped")
    return { icon: Cancel01Icon, text: "Skipped", tone: "muted" as const };
  return { icon: Clock01Icon, text: "Expired", tone: "muted" as const };
}

/** What an answered sources card shared. */
function SharedSources({ card }: { card: Card }) {
  const links = card.answer?.links ?? [];
  const fileCount = card.answer?.attachment_upload_ids?.length ?? 0;
  if (card.answer?.decision !== "done" || (!links.length && !fileCount))
    return null;
  return (
    <section aria-label="Shared sources" className={listClassName}>
      {links.map((url) => (
        <SourceRow icon={Link01Icon} key={url} label={linkLabel(url)} />
      ))}
      {fileCount ? (
        <SourceRow icon={File01Icon} label={plural(fileCount, "file")} />
      ) : null}
    </section>
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useSetupDecision({ card, messageId, onDecision }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(
    decision: SetupDecision,
    sources: { attachmentUploadIds?: string[]; links?: string[] } = {},
  ) {
    setError(null);
    setSubmitting(true);
    try {
      await onDecision({
        ...sources,
        decision,
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (caught) {
      setError(
        caught instanceof TeamHubError &&
          caught.code === "ATTACHMENT_UPLOAD_UNAVAILABLE"
          ? "A file is no longer available. Remove it and upload it again."
          : caught instanceof Error
            ? caught.message
            : "Card decision failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return { decide, error, submitting };
}

function ProfileSetupApps(props: Props) {
  const { card, currentActorId } = props;
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const canDecide =
    currentActorId === card.decision_owner.id && card.status === "pending";
  const connections = useQuery({
    ...externalConnectionsQueryOptions(client),
    enabled: canDecide,
  });
  const [expanded, setExpanded] = useState(false);
  const decision = useSetupDecision(props);
  const apps = card.profile_setup?.apps ?? [];
  const moreApps = card.profile_setup?.more_apps ?? [];
  const catalogApp = (key: string) =>
    catalog.data?.apps.find((app) => app.key === key);

  return (
    <SetupCard
      actions={
        canDecide ? (
          <SetupReplies
            decision={decision}
            replies={[
              { decision: "connected", label: "Connected" },
              { decision: "skipped", label: "Skip for now" },
            ]}
          />
        ) : undefined
      }
      card={card}
      error={decision.error}
    >
      <section aria-label="Connect your apps" className={listClassName}>
        {[...apps, ...(expanded ? moreApps : [])].map((key) => (
          <SetupAppRow
            app={catalogApp(key)}
            appKey={key}
            connections={(connections.data?.connections ?? []).filter(
              (connection) => connection.provider === key,
            )}
            interactive={canDecide}
            key={key}
            catalogLoaded={catalog.isSuccess}
            showConnections={canDecide}
          />
        ))}
        {moreApps.length > 0 && !expanded && card.status === "pending" ? (
          <button
            className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground motion-reduce:transition-none"
            onClick={() => setExpanded(true)}
            type="button"
          >
            <span className="flex -space-x-1">
              {moreApps.map((key) => (
                <span
                  className="flex size-5 items-center justify-center rounded-full bg-card shadow-outline"
                  key={key}
                >
                  <AppLogo
                    name={appName(catalogApp(key), key)}
                    size="sm"
                    url={catalogApp(key)?.logo_url}
                  />
                </span>
              ))}
            </span>
            <span className="flex-1">More</span>
            <Icon icon={ArrowDown01Icon} size={14} />
          </button>
        ) : null}
      </section>
    </SetupCard>
  );
}

function SetupAppRow({
  app,
  appKey,
  catalogLoaded,
  connections,
  interactive,
  showConnections,
}: {
  app?: TeamHubExternalApp;
  appKey: string;
  catalogLoaded: boolean;
  connections: TeamHubExternalConnection[];
  interactive: boolean;
  showConnections: boolean;
}) {
  const flow = useConnectAppFlow();
  const name = appName(app, appKey);
  const active = showConnections
    ? activeExternalConnections(connections)[0]
    : undefined;
  const pending = connections.find(
    (connection) =>
      connection.status === "pending" && !connection.status_error_code,
  );
  const verifying = connections.some(
    (connection) =>
      connection.status === "pending" &&
      connection.status_error_code === "provider_identity_unavailable",
  );
  return (
    <div className="p-2">
      <div className="flex min-h-8 items-center gap-2.5">
        <span className="flex size-10 shrink-0 items-center justify-center [&>svg]:size-6 [&>img]:size-7">
          <AppLogo name={name} size="profile" url={app?.logo_url} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {name}
        </span>
        {active ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-[var(--app-status-success-text)]"
            />
            <span className="truncate">
              {active.identity_label ?? "Connected"}
            </span>
          </span>
        ) : verifying && showConnections ? (
          <span className="text-xs text-muted-foreground" role="status">
            Verifying connection…
          </span>
        ) : app && showConnections ? (
          <Button
            aria-label={`Connect ${name}`}
            disabled={
              !interactive || !flow.canStart(app) || flow.connection.isPending
            }
            onClick={() => flow.start(app, pending)}
            size="large"
            tone="subtle"
          >
            {pending ? "Continue" : "Connect"}
          </Button>
        ) : showConnections && catalogLoaded && !app ? (
          <span className="text-xs text-muted-foreground">
            Not available yet
          </span>
        ) : null}
      </div>
      {interactive ? <ConnectAppStatus className="mt-1.5" flow={flow} /> : null}
    </div>
  );
}

type SourceItem =
  | { kind: "link"; url: string }
  | {
      controller: AbortController;
      error?: string;
      file: File;
      id: string;
      kind: "file";
      progress: number;
      upload?: TeamHubMessageAttachmentUpload;
    };

function ProfileSetupSources(props: Props) {
  const { card, currentActorId, roomId } = props;
  const { client } = useTeamHubRuntime();
  const [items, setItems] = useState<SourceItem[]>([]);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const decision = useSetupDecision(props);
  const canDecide =
    currentActorId === card.decision_owner.id && card.status === "pending";
  const links = items.flatMap((item) =>
    item.kind === "link" ? [item.url] : [],
  );
  const files = items.filter((item) => item.kind === "file");
  const uploading = files.some((item) => !item.upload && !item.error);
  const failedUpload = files.some((item) => item.error);

  function updateFile(id: string, change: Partial<SourceItem>) {
    setItems((current) =>
      current.map((item) =>
        item.kind === "file" && item.id === id
          ? ({ ...item, ...change } as SourceItem)
          : item,
      ),
    );
  }

  function validateLink(link: string) {
    return !isProfileSourceLink(link)
      ? "Enter a full link that starts with http:// or https://."
      : links.includes(link)
        ? "That link is already added."
        : links.length >= MAX_LINKS
          ? `You can add up to ${MAX_LINKS} links.`
          : null;
  }

  function addLink() {
    const link = draft.trim();
    if (!link) return;
    const error = validateLink(link);
    setInputError(error);
    if (error) return;
    setItems((current) => [...current, { kind: "link", url: link }]);
    setDraft("");
  }

  async function upload(id: string, file: File, controller: AbortController) {
    try {
      const result = await client.uploadMessageAttachment(
        roomId,
        file,
        createTeamHubIdempotencyKey(),
        {
          onProgress: (progress) => updateFile(id, { progress }),
          signal: controller.signal,
        },
      );
      // Removed while the upload finished: release it as the composer does.
      if (controller.signal.aborted) {
        await cancelAttachmentUpload(client, roomId, result.id);
        return;
      }
      updateFile(id, { progress: 1, upload: result });
    } catch (caught) {
      if (controller.signal.aborted) return;
      updateFile(id, {
        error: caught instanceof Error ? caught.message : "Upload failed.",
      });
    }
  }

  function addFiles(selected: File[]) {
    const room = MAX_FILES - files.length;
    setInputError(
      selected.length > room
        ? `You can upload up to ${MAX_FILES} files.`
        : null,
    );
    const added = selected.slice(0, Math.max(room, 0)).map((file) => ({
      controller: new AbortController(),
      file,
      id: createTeamHubIdempotencyKey(),
      kind: "file" as const,
      progress: 0,
    }));
    setItems((current) => [...current, ...added]);
    for (const item of added) void upload(item.id, item.file, item.controller);
  }

  function removeFile(id: string) {
    const item = files.find((candidate) => candidate.id === id);
    if (!item || item.kind !== "file") return;
    item.controller.abort();
    if (item.upload) {
      void cancelAttachmentUpload(client, roomId, item.upload.id);
    }
    setItems((current) =>
      current.filter(
        (candidate) => candidate.kind !== "file" || candidate.id !== id,
      ),
    );
    setInputError(null);
  }

  return (
    <SetupCard
      actions={
        canDecide ? (
          <SetupReplies
            decision={decision}
            doneDisabled={uploading || failedUpload}
            onDone={() => {
              const pendingLink = draft.trim();
              const error = pendingLink ? validateLink(pendingLink) : null;
              if (error) {
                setInputError(error);
                return;
              }
              void decision.decide("done", {
                attachmentUploadIds: files.flatMap((item) =>
                  item.kind === "file" && item.upload ? [item.upload.id] : [],
                ),
                links: pendingLink ? [...links, pendingLink] : links,
              });
            }}
            replies={[
              { decision: "done", label: "That's all" },
              { decision: "skipped", label: "Skip" },
            ]}
          />
        ) : undefined
      }
      card={card}
      error={decision.error}
    >
      {canDecide ? (
        <>
          <section aria-label="Website or files" className={listClassName}>
            {items.map((item) =>
              item.kind === "link" ? (
                <LinkRow
                  key={item.url}
                  url={item.url}
                  onRemove={() =>
                    setItems((current) =>
                      current.filter((candidate) => candidate !== item),
                    )
                  }
                />
              ) : (
                <SourceRow
                  icon={File01Icon}
                  key={item.id}
                  label={item.file.name}
                  trailing={
                    <>
                      {item.error ? (
                        <span className="text-xs text-app-danger" role="alert">
                          {item.error}
                        </span>
                      ) : (
                        <span className="text-xs text-app-muted tabular-nums">
                          {item.upload
                            ? `Uploaded · ${formatFileSize(item.file.size)}`
                            : `${Math.round(item.progress * 100)}%`}
                        </span>
                      )}
                      <Button
                        aria-label={`Remove ${item.file.name}`}
                        onClick={() => removeFile(item.id)}
                        size="compactIcon"
                        tone="ghost"
                      >
                        <Icon icon={Cancel01Icon} size={14} />
                      </Button>
                    </>
                  }
                />
              ),
            )}
            <div className={rowClassName}>
              <input
                aria-label="Paste a link"
                className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setInputError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  addLink();
                }}
                placeholder="Paste a link"
                value={draft}
              />
              <Button
                disabled={!draft.trim()}
                onClick={addLink}
                size="large"
                tone="subtle"
              >
                Add link
              </Button>
              <Button
                disabled={files.length >= MAX_FILES}
                onClick={() => fileInput.current?.click()}
                size="large"
                tone="subtle"
              >
                Upload files
              </Button>
              <input
                aria-label="Upload files"
                className="hidden"
                multiple
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
                ref={fileInput}
                type="file"
              />
            </div>
          </section>
          <p className="pb-1 text-xs text-app-muted" role="status">
            {items.length
              ? "Added here. Select That's all to share with Another Me."
              : "Add a link or upload a file, then select That's all to share."}
          </p>
          {inputError ? (
            <p className="pb-1 text-xs text-app-danger" role="alert">
              {inputError}
            </p>
          ) : null}
        </>
      ) : (
        <SharedSources card={card} />
      )}
    </SetupCard>
  );
}

function LinkRow({ url, onRemove }: { url: string; onRemove: () => void }) {
  return (
    <SourceRow
      icon={Link01Icon}
      label={linkLabel(url)}
      trailing={
        <>
          <span className="text-xs text-app-muted">Added</span>
          <Button
            aria-label={`Remove ${url}`}
            onClick={onRemove}
            size="compactIcon"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={14} />
          </Button>
        </>
      }
    />
  );
}

function SourceRow({
  icon,
  label,
  trailing,
}: {
  icon: typeof Link01Icon;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={rowClassName}>
      <span className="flex size-10 shrink-0 items-center justify-center [&>svg]:size-6 [&>img]:size-7 text-app-ink">
        <Icon icon={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-app-ink">
        {label}
      </span>
      {trailing}
    </div>
  );
}

/** The replies of a pending setup card; the first one is the main answer. */
function SetupReplies({
  decision,
  doneDisabled = false,
  onDone,
  replies,
}: {
  decision: ReturnType<typeof useSetupDecision>;
  doneDisabled?: boolean;
  onDone?: () => void;
  replies: { decision: SetupDecision; label: string }[];
}) {
  return replies.map((reply, index) => (
    <Button
      disabled={
        decision.submitting || (reply.decision === "done" && doneDisabled)
      }
      key={reply.decision}
      onClick={() =>
        reply.decision === "done" && onDone
          ? onDone()
          : void decision.decide(reply.decision)
      }
      size="large"
      tone={index === 0 ? "primary" : "subtle"}
    >
      {reply.label}
    </Button>
  ));
}

function appName(app: TeamHubExternalApp | undefined, key: string) {
  return app?.display_name ?? connectedAppDisplayName(key);
}

function isProfileSourceLink(value: string) {
  if (value.length > MAX_LINK_LENGTH || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.host
    );
  } catch {
    return false;
  }
}

function linkLabel(value: string) {
  const url = new URL(value);
  return url.pathname === "/" && !url.search
    ? url.hostname
    : `${url.hostname}${url.pathname}${url.search}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cancelAttachmentUpload(
  client: TeamHubClient,
  roomId: string,
  attachmentUploadId: string,
) {
  return teamHubDone(
    client.api.DELETE(
      "/v0/rooms/{roomId}/message-attachment-uploads/{attachmentUploadId}",
      { params: { path: { roomId, attachmentUploadId } } },
    ),
  );
}
