import { useQuery } from "@tanstack/react-query";
import {
  Download04Icon,
  File01Icon,
  FloppyDiskIcon,
  RefreshIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useState } from "react";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  createTeamHubIdempotencyKey,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type { SharedDocumentContent } from "@/features/teamhub/teamhub-document-links";
import { triggerArtifactDownload } from "@/features/rooms/files/artifact-preview-loader";

export function SharedDocumentPage() {
  const { client } = useTeamHubRuntime();
  const token = useLocation().hash.slice(1);
  return <SharedDocumentSurface key={token} client={client} token={token} />;
}

function SharedDocumentSurface({
  client,
  token,
}: {
  client: TeamHubClient;
  token: string;
}) {
  const [dirty, setDirty] = useState(false);
  const valid = /^doc_link_[A-Za-z0-9_-]{43}$/.test(token);
  const file = useQuery({
    queryKey: ["shared-document", token],
    enabled: valid,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const result = await client.documentLinks.download(token, signal);
      const text =
        result.blob.size <= 1024 * 1024 &&
        /^(text\/|application\/(json|xml))/i.test(result.mediaType)
          ? await result.blob.text()
          : null;
      return { ...result, text };
    },
  });
  const session = useQuery({
    queryKey: ["teamhub", "shared-document-session"],
    queryFn: () => teamHubData(client.api.GET("/v0/session")),
    retry: false,
  });
  return (
    <main className="min-h-dvh bg-app-surface text-app-body">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-app-border px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Icon
            icon={File01Icon}
            size={20}
            className="shrink-0 text-app-muted"
          />
          <h1 className="min-w-0 break-all text-lg">
            {file.data?.filename ?? "Shared file"}
          </h1>
        </div>
        <Button
          aria-label="Refresh file"
          title="Refresh file"
          disabled={file.isFetching || !valid || dirty}
          onClick={() => void file.refetch()}
          size="compactIcon"
          tone="ghost"
        >
          <Icon icon={RefreshIcon} />
        </Button>
      </header>
      {file.error && dirty ? (
        <p role="alert" className="px-5 pt-4 text-sm text-app-danger">
          The link is unavailable. Your unsaved changes are still here.
        </p>
      ) : null}
      {!valid || (file.error && (!file.data || !dirty)) ? (
        <div className="mx-auto max-w-3xl p-6" role="alert">
          {file.error instanceof Error &&
          !(file.error instanceof TeamHubError && file.error.status === 404)
            ? file.error.message
            : "This link is unavailable or has been revoked."}
        </div>
      ) : file.isPending ? (
        <p className="flex items-center gap-2 p-6 text-sm text-app-muted">
          <Spinner size={16} />
          Loading file…
        </p>
      ) : (
        <SharedFileEditor
          key={`${token}:${file.data.versionId}`}
          client={client}
          data={file.data}
          token={token}
          signedIn={Boolean(session.data)}
          onDirty={setDirty}
          onSaved={async () => {
            setDirty(false);
            await file.refetch();
          }}
        />
      )}
    </main>
  );
}

function SharedFileEditor({
  client,
  data,
  token,
  signedIn,
  onSaved,
  onDirty,
}: {
  client: TeamHubClient;
  data: SharedDocumentContent & { text: string | null };
  token: string;
  signedIn: boolean;
  onSaved: () => Promise<unknown>;
  onDirty: (dirty: boolean) => void;
}) {
  const [text, setText] = useState(data.text ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = data.access.role === "editor" && !data.readOnly;
  async function save(file: File) {
    setPending(true);
    setError(null);
    try {
      await client.uploadDocumentVersion(
        data.documentId,
        {
          file,
          representationFormat: data.representationFormat,
          expectedCurrentVersionId: data.versionId,
          linkToken: token,
        },
        createTeamHubIdempotencyKey(),
      );
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save this version.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="mx-auto max-w-5xl px-5 py-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="mr-auto text-sm text-app-muted">
          {editable ? "Can edit" : "Read only"}
        </span>
        <Button
          tone="secondary"
          onClick={() => triggerArtifactDownload(data.blob, data.filename)}
        >
          <Icon icon={Download04Icon} /> Download
        </Button>
        {editable && !signedIn ? (
          <a
            href="/login"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--app-link)] underline-offset-2 hover:underline"
          >
            Sign in to edit
          </a>
        ) : null}
        {editable && signedIn && data.text !== null ? (
          <Button
            disabled={pending || text === data.text}
            onClick={() =>
              void save(
                new File([text], data.filename, { type: data.mediaType }),
              )
            }
          >
            <Icon icon={FloppyDiskIcon} /> {pending ? "Saving..." : "Save"}
          </Button>
        ) : null}
        {editable && signedIn ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Icon icon={Upload04Icon} /> Upload version
            <input
              aria-label="Upload version"
              type="file"
              disabled={pending}
              className="max-w-52 text-xs"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void save(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-app-danger">
          {error}
        </p>
      ) : null}
      {data.text !== null ? (
        editable && signedIn ? (
          <textarea
            aria-label="File content"
            disabled={pending}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              onDirty(event.target.value !== data.text);
            }}
            className="min-h-[65dvh] w-full resize-y rounded-lg border border-input bg-card p-4 font-mono text-sm leading-6 outline-none transition-colors hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6">
            {data.text}
          </pre>
        )
      ) : (
        <div className="flex min-h-48 items-center justify-center gap-3 text-sm text-app-muted">
          <Icon icon={File01Icon} size={24} />
          {data.mediaType}
        </div>
      )}
    </section>
  );
}
