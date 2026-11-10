import { Navigate, useParams, useSearchParams } from "react-router";
import { ReadOnlyBlockNoteDocumentLoader } from "@/components/read-only-blocknote-document-loader";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";

import { useWikiDocuments } from "./knowledge-sidebar-trees";
import { wikiPageKey, wikiPagePath } from "./wiki-display-state";
import { resolveWikiPageReference } from "./wiki-document-links";
import { wikiPreviewPages } from "./wiki-preview-pages";
import { usePersonalWikiRefresh } from "./wiki-refresh";
import "@/features/rooms/documents/room-document-blocknote.css";
import "./wiki-working-card.css";

/** Where a Wiki page opens: its Document once published, else its preview. */
export function wikiPreviewPath(tenantId: string, path: string) {
  return `/t/${encodeURIComponent(tenantId)}/wiki-preview?page=${encodeURIComponent(path)}`;
}

/**
 * A page the running refresh has written but not published, in the same
 * layout as a published Wiki page. Once the refresh publishes it, the route
 * moves to the published Document.
 */
export function WikiPreviewPage() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [searchParams] = useSearchParams();
  const path = searchParams.get("page") ?? "";
  const refresh = usePersonalWikiRefresh(tenantId);
  const documents = useWikiDocuments(tenantId);
  const key = wikiPageKey(path);
  const page = wikiPreviewPages(refresh.preview).find(
    (item) => item.key === key,
  );
  const published = documents.data?.pages
    .flatMap((item) => item.items)
    .find((document) => wikiPageKey(wikiPagePath(document)) === key);
  const documentsByKey = new Map(
    (documents.data?.pages.flatMap((item) => item.items) ?? []).map(
      (document) => [wikiPageKey(wikiPagePath(document)), document.id],
    ),
  );
  const previewKeys = new Set(
    wikiPreviewPages(refresh.preview).map((item) => item.key),
  );
  const resolveLink = (reference: string) => {
    const target = resolveWikiPageReference(reference, path);
    if (!target) return null;
    const targetKey = wikiPageKey(target.pageKey);
    if (previewKeys.has(targetKey))
      return wikiPreviewPath(tenantId, target.pageKey);
    const id = documentsByKey.get(targetKey);
    return id
      ? `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(id)}${target.hash}`
      : null;
  };

  if (!page) {
    if (!refresh.refreshing && published)
      return (
        <Navigate
          replace
          to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(published.id)}`}
        />
      );
    return (
      <main className="flex min-w-0 flex-1 items-start justify-center bg-app-surface p-10">
        <p className="text-sm text-app-muted" role="status">
          {refresh.refreshing
            ? "This page is not written yet."
            : "This page was not published."}
        </p>
      </main>
    );
  }
  const fileName = path.split("/").at(-1) ?? path;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="room-document-main flex min-h-0 min-w-0 flex-1 flex-col bg-app-surface">
        <header className="room-document-header border-b border-app-border/60">
          <div className="room-document-header-identity">
            <div className="room-document-header-file">
              <span className="truncate text-sm font-semibold text-app-ink">
                {fileName.charAt(0).toUpperCase() + fileName.slice(1)}
              </span>
              <span
                className="room-document-header-updated inline-flex items-center gap-1.5"
                title="Not published yet. This page may still change."
              >
                <span aria-hidden="true" className="wiki-preview-dot" />
                Generating
              </span>
            </div>
          </div>
        </header>
        <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto">
          <div className="room-document-layout room-document-layout--knowledge mx-auto min-h-full">
            <div className="room-document-content-lane mx-auto mb-6 border-b border-app-border pb-5">
              <h1 className="room-document-page-title">{page.name}</h1>
            </div>
            <div className="wiki-preview-body room-document-content-lane mx-auto">
              <ReadOnlyBlockNoteDocumentLoader
                ariaLabel={page.name}
                documentTitle={page.name}
                markdown={page.markdown}
                presentation="knowledge"
                resolveLink={resolveLink}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
