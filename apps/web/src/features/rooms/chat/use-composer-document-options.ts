import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import { roomCatalogRetry } from "./room-catalog-retry";

/** One bounded page keeps the Composer catalog small in Tenants with many Documents. */
export const COMPOSER_DOCUMENT_PAGE_SIZE = 50;
/**
 * Binding a Document into a Room needs collaborator management rights, which
 * only its owner holds. Personal Wiki pages and the Memory files projected as
 * Wiki sources are readable by the Wiki owner without owning the Document, so
 * TeamHub's `shareable` view returns them but a Room binding fails with
 * "Document could not be shared in this Room". Such Wiki-only Documents reach
 * the Composer only when the caller can manage them (their own uploads); a
 * Document with another binding, or none yet, is offered as before.
 */
const WIKI_BINDING_KINDS: ReadonlySet<string> = new Set([
  "wiki_page",
  "wiki_source",
]);

function isRoomShareable(document: TeamHubDocument) {
  return (
    document.capabilities.manage ||
    document.from.length === 0 ||
    document.from.some(
      (binding) => !WIKI_BINDING_KINDS.has(binding.binding_kind),
    )
  );
}
const COMPOSER_DOCUMENT_SEARCH_DEBOUNCE_MS = 180;
/** Like the search dialog, a shorter query only filters the loaded page. */
const COMPOSER_DOCUMENT_SEARCH_MIN_LENGTH = 2;
/** The picker shows a short list and never reads `search_match`. */
const COMPOSER_DOCUMENT_SEARCH_LIMIT = 20;

/**
 * Feeds the Composer `@` Docs list without loading the whole Tenant catalog: the
 * most recent shareable page is browsed offline, and typing a query searches the
 * full catalog on TeamHub so matches outside that page stay reachable.
 */
export function useComposerDocumentOptions({
  client,
  draftDocumentIds,
  roomDocuments,
  tenantId,
}: {
  client: TeamHubClient;
  /** Document IDs a restored draft already references, kept selectable. */
  draftDocumentIds: string[];
  roomDocuments: TeamHubDocument[];
  tenantId: string;
}) {
  const [documentQuery, setDocumentQuery] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    const next = documentQuery?.trim() ?? "";
    if (next === searchTerm) return;
    const timer = window.setTimeout(
      () => setSearchTerm(next),
      COMPOSER_DOCUMENT_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [documentQuery, searchTerm]);

  const shareableDocuments = useQuery({
    enabled: documentQuery !== null,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/library/documents", {
          params: {
            query: { limit: COMPOSER_DOCUMENT_PAGE_SIZE, view: "shareable" },
          },
        }),
      ),
    queryKey: ["teamhub", tenantId, "shareable-documents"],
    ...roomCatalogRetry,
    staleTime: 10_000,
  });
  const searchedDocuments = useQuery({
    enabled: searchTerm.length >= COMPOSER_DOCUMENT_SEARCH_MIN_LENGTH,
    placeholderData: keepPreviousData,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/library/documents/search", {
          params: {
            query: {
              limit: COMPOSER_DOCUMENT_SEARCH_LIMIT,
              q: searchTerm,
              tenant_id: tenantId,
            },
          },
        }),
      ),
    queryKey: ["teamhub", tenantId, "shareable-document-search", searchTerm],
    ...roomCatalogRetry,
    staleTime: 10_000,
  });

  const draftDocuments = useQuery({
    enabled: draftDocumentIds.length > 0,
    queryFn: async () => {
      const documents = await Promise.all(
        draftDocumentIds.map((documentId) =>
          teamHubData(
            client.api.GET("/v0/documents/{documentId}", {
              params: { path: { documentId } },
            }),
          ).catch(() => null),
        ),
      );
      return documents.filter((document) => document !== null);
    },
    queryKey: [
      "teamhub",
      tenantId,
      "composer-draft-documents",
      [...draftDocumentIds].sort(),
    ],
    retry: false,
    staleTime: Infinity,
  });

  const documents = useMemo(() => {
    const catalog = new Map<string, TeamHubDocument>();
    for (const document of [
      ...(shareableDocuments.data?.items ?? []),
      ...(searchedDocuments.data?.items ?? []),
    ]) {
      if (document.tenant_id === tenantId && isRoomShareable(document)) {
        catalog.set(document.id, document);
      }
    }
    // A restored draft keeps whatever it already referenced, so reopening a Room
    // never silently drops a Document the message still names.
    for (const document of draftDocuments.data ?? []) {
      if (document.tenant_id === tenantId) catalog.set(document.id, document);
    }
    // Room Documents win: they already carry the Room Binding the Composer needs.
    for (const document of roomDocuments) catalog.set(document.id, document);
    return [...catalog.values()];
  }, [
    draftDocuments.data,
    roomDocuments,
    searchedDocuments.data?.items,
    shareableDocuments.data?.items,
    tenantId,
  ]);

  return {
    documents,
    /** True until every Document a restored draft may reference is known. */
    documentsPending: draftDocumentIds.length > 0 && draftDocuments.isPending,
    onDocumentQueryChange: useCallback(
      (query: string | null) => setDocumentQuery(query),
      [],
    ),
    shareableDocuments,
  };
}
