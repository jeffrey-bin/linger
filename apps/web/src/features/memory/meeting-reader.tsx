import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ReadOnlyBlockNoteDocumentLoader } from "@/components/read-only-blocknote-document-loader";
import { Button } from "@/components/ui/button";
import { ArtifactContentRendererLoader } from "@/features/rooms/files/artifact-content-renderer-loader";
import {
  downloadArtifactPreview,
  loadArtifactPreview,
  triggerArtifactDownload,
  type LoadedArtifactPreview,
} from "@/features/rooms/files/artifact-preview-loader";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";
import { MeetingAudioPlayer } from "./meeting-audio-player";
import { parseMeetingSummary } from "./meeting-overview";
import {
  MeetingKeywords,
  MeetingOutcomes,
  MeetingOverviewCard,
} from "./meeting-overview-card";
import { HideMeetingDialog } from "./hide-meeting-dialog";
import { formatMeetingWhen, meetingWhen } from "./meetings-calendar";

const meetingSummaryHiddenSectionTitles = [
  "CRM Evidence Cache",
  "Workflow Evidence Cache",
  "Runtime Evidence",
  "Subject Relation Note",
] as const;

export type MeetingTab = "summary" | "transcript";

/**
 * One page per meeting: Summary and Transcript share the reading area as two
 * tabs, and the recording player closes the Summary tab. Summary opens first
 * once it exists; until then the transcript is shown.
 */
export function MeetingReader({
  entry,
  file,
  onHidden,
  onSelectTab,
  resolveLink,
  tenantId,
}: {
  entry: TeamHubMemoryEntry;
  /** The `file` URL parameter; "recording" and none choose the default tab. */
  file: string | null;
  /** Leaves the page once the meeting is deleted from the reader's Meetings. */
  onHidden: () => void;
  onSelectTab: (tab: MeetingTab) => void;
  resolveLink?: (reference: string) => string | null | undefined;
  tenantId: string;
}) {
  const meeting = entry.meeting!;
  const [deleting, setDeleting] = useState(false);
  const tab: MeetingTab =
    file === "summary" || file === "transcript"
      ? file
      : meeting.summary_ready
        ? "summary"
        : "transcript";
  const when = meetingWhen(entry.path);
  // The Session page's H1 is a generated recording ID, not a reader title.
  const summaryMarkdown = useMemo(
    () => entry.content.replace(/^#[ \t]+[^\n]*\n?/mu, ""),
    [entry.content],
  );
  // Keywords, Meeting Summary topics and the outcome lists are shown in
  // place; the rest stays the knowledge document around them.
  const blocks = useMemo(
    () => parseMeetingSummary(summaryMarkdown),
    [summaryMarkdown],
  );
  const summaryDocument = (markdown: string) => (
    <ReadOnlyBlockNoteDocumentLoader
      ariaLabel="Meeting summary document"
      hiddenSectionTitles={meetingSummaryHiddenSectionTitles}
      markdown={markdown}
      presentation="knowledge"
      resolveLink={resolveLink}
    />
  );
  const tabs: Array<{ id: MeetingTab; label: string }> = [
    { id: "summary", label: "Summary" },
    { id: "transcript", label: "Transcript" },
  ];
  return (
    <article
      className="meeting-document mx-auto w-full max-w-4xl px-5 py-7 md:px-10"
      aria-label="Meeting"
    >
      <header className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl text-app-ink">
            {when
              ? `Meeting · ${formatMeetingWhen(when.date, when.time)}`
              : entry.title}
          </h2>
          <p className="mt-1 text-xs text-app-muted">Read only</p>
        </div>
        <Button onClick={() => setDeleting(true)} size="compact" tone="ghost">
          Delete
        </Button>
      </header>
      {deleting ? (
        <HideMeetingDialog
          captureId={meeting.capture_id}
          name={
            when
              ? `Meeting ${formatMeetingWhen(when.date, when.time)}`
              : entry.title
          }
          onClose={() => setDeleting(false)}
          onHidden={onHidden}
          tenantId={tenantId}
        />
      ) : null}
      <div
        aria-label="Meeting views"
        className="flex items-center gap-1 border-b border-app-border"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            aria-controls={`meeting-${item.id}`}
            aria-selected={tab === item.id}
            className={`-mb-px border-b-2 px-3 pb-2 pt-1 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus ${
              tab === item.id
                ? "border-app-ink text-app-ink"
                : "border-transparent text-app-muted hover:text-app-ink"
            }`}
            id={`meeting-tab-${item.id}`}
            key={item.id}
            onClick={() => onSelectTab(item.id)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`meeting-tab-${tab}`}
        className="pt-5"
        id={`meeting-${tab}`}
        role="tabpanel"
      >
        {tab === "summary" ? (
          <>
            {meeting.summary_ready ? (
              <>
                <div className="mb-3 flex justify-end">
                  <Button
                    size="compact"
                    tone="secondary"
                    onClick={() =>
                      triggerArtifactDownload(
                        new Blob([entry.content], {
                          type: "text/markdown;charset=utf-8",
                        }),
                        "summary.md",
                      )
                    }
                  >
                    Download summary
                  </Button>
                </div>
                {/* One reading surface: the table of contents reads every
                    heading inside it, the card's included. */}
                <article
                  aria-label="Meeting summary"
                  className="[&>article:not(:first-child)]:pt-0 [&>article:not(:last-child)]:pb-0"
                  data-content-renderer="blocknote"
                  data-editable="false"
                >
                  {blocks.map((block, index) =>
                    block.kind === "markdown" ? (
                      <Fragment key={index}>
                        {summaryDocument(block.markdown)}
                      </Fragment>
                    ) : block.kind === "keywords" ? (
                      <MeetingKeywords
                        key={index}
                        keywords={block.keywords}
                        title={block.title}
                      />
                    ) : block.kind === "topics" ? (
                      <MeetingOverviewCard key={index} topics={block.topics} />
                    ) : (
                      <MeetingOutcomes
                        key={index}
                        outcomes={block.outcomes}
                        title={block.title}
                      />
                    ),
                  )}
                </article>
              </>
            ) : (
              <p className="text-sm text-app-muted" role="status">
                The summary is still being written. The transcript is ready now.
              </p>
            )}
            {/* The recording closes the summary, ready to replay a moment. */}
            <div className="mt-8">
              <MeetingVersionReader
                key={meeting.recording_version_id}
                documentId={meeting.recording_document_id}
                versionId={meeting.recording_version_id}
                filename={meeting.recording_filename}
                variant="player"
              />
            </div>
          </>
        ) : (
          <MeetingVersionReader
            key={meeting.transcript_version_id}
            documentId={meeting.transcript_document_id}
            versionId={meeting.transcript_version_id}
            filename="transcript.md"
            variant="document"
          />
        )}
      </div>
    </article>
  );
}

/**
 * A meeting file read from its exact Version: the recording as a player row,
 * the transcript as the tab's document, each with its own download.
 */
function MeetingVersionReader({
  documentId,
  versionId,
  filename,
  variant,
}: {
  documentId: string;
  versionId: string;
  filename: string;
  variant: "player" | "document";
}) {
  const { client } = useTeamHubRuntime();
  const [preview, setPreview] = useState<LoadedArtifactPreview>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const transfer = useRef<AbortController | null>(null);
  const siblingRetries = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    transfer.current = controller;
    let dispose: (() => void) | undefined;
    setPreview(undefined);
    setError(undefined);
    void loadArtifactPreview({
      client,
      documentId,
      versionId,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) {
          result.dispose();
          return;
        }
        dispose = result.dispose;
        setPreview(result);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        // The preview cache drops every load when another file is refused,
        // and the recording and transcript load side by side here. A load
        // cancelled by its sibling retries instead of showing an error.
        if (
          failure instanceof DOMException &&
          failure.name === "AbortError" &&
          siblingRetries.current < 2
        ) {
          siblingRetries.current += 1;
          setAttempt((value) => value + 1);
          return;
        }
        setError(
          failure instanceof Error ? failure.message : "File unavailable.",
        );
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [client, documentId, versionId, attempt]);
  async function download() {
    const signal = transfer.current?.signal;
    if (!preview || !signal || signal.aborted) return;
    setDownloading(true);
    try {
      triggerArtifactDownload(
        await downloadArtifactPreview({
          client,
          preview,
          signal,
        }),
        filename,
      );
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error ? failure.message : "Download failed.",
        );
    } finally {
      if (!signal.aborted) setDownloading(false);
    }
  }
  const header = (
    <div className="mb-3 flex justify-end">
      <Button
        aria-label={`Download ${filename}`}
        size="compact"
        tone="secondary"
        disabled={!preview || downloading}
        onClick={() => void download()}
      >
        {variant === "player" ? "Download recording" : "Download transcript"}
      </Button>
    </div>
  );
  const body = error ? (
    <div className="text-sm text-app-danger" role="alert">
      {error}{" "}
      <Button
        onClick={() => setAttempt((value) => value + 1)}
        size="compact"
        tone="secondary"
      >
        Retry
      </Button>
    </div>
  ) : !preview ? (
    <p className="text-sm text-app-muted" role="status">
      {variant === "player" ? "Loading recording…" : "Loading transcript…"}
    </p>
  ) : preview.decision.kind === "download" ? (
    <p className="text-sm text-app-muted">
      Preview unavailable. Download the recording to open it.
    </p>
  ) : (
    <ArtifactContentRendererLoader
      kind={preview.decision.kind}
      filename={filename}
      mediaType={preview.version.media_type}
      blob={preview.blob}
      objectUrl={preview.objectUrl}
      previewUrl={preview.previewUrl}
      textContent={preview.textContent}
      sourceSizeBytes={preview.sourceSizeBytes}
      presentation="knowledge"
    />
  );
  if (variant === "player") {
    if (error)
      return (
        <section
          aria-label="Meeting recording"
          className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface px-3 py-2.5 text-sm"
        >
          <span className="min-w-0 flex-1 text-app-danger" role="alert">
            {error}
          </span>
          <Button
            onClick={() => setAttempt((value) => value + 1)}
            size="compact"
            tone="secondary"
          >
            Retry
          </Button>
        </section>
      );
    const playable =
      preview?.objectUrl &&
      preview.decision.kind === "media" &&
      preview.version.media_type.toLowerCase().startsWith("audio/");
    return (
      <MeetingAudioPlayer
        downloadDisabled={!preview || downloading}
        filename={filename}
        mediaType={preview?.version.media_type}
        onDownload={() => void download()}
        src={playable ? preview.objectUrl : undefined}
        status={
          !preview
            ? "Loading…"
            : playable
              ? undefined
              : "Preview unavailable · download to listen"
        }
      />
    );
  }
  return (
    <>
      {header}
      {body}
    </>
  );
}
