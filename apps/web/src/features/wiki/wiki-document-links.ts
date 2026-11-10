import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useNavigate } from "react-router";

import { useDocumentAnchorLinks } from "@/components/document-anchor-links";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import { personalWikiDocumentsQueryKey } from "@/features/teamhub/document-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import { isWikiCitationHref } from "./wiki-citation-links";

type WikiDocument = Pick<TeamHubDocument, "id" | "tenant_id" | "from">;

export function resolveWikiPageReference(reference: string, pageKey: string) {
  const value = reference.trim();
  if (!value || /^(?:#|\\|\/\/|\/t\/|[a-z][a-z\d+.-]*:)/i.test(value))
    return null;
  try {
    const url = new URL(value, new URL(pageKey, "https://wiki.invalid/"));
    const pathname = decodeURIComponent(url.pathname.slice(1));
    const path =
      !pathname || pathname.endsWith("/") ? `${pathname}index.md` : pathname;
    if (!/^[a-z0-9][a-z0-9._/-]*$/.test(path)) return null;
    return { pageKey: path, hash: url.hash };
  } catch {
    return null;
  }
}

export async function findWikiPageDocument(
  client: Pick<TeamHubClient, "api">,
  source: WikiDocument,
  wikiId: string,
  pageKey: string,
) {
  // Match the publisher's Markdown-file and directory-index resolution order.
  const primaryKey = pageKey.endsWith(".md") ? pageKey : `${pageKey}.md`;
  const indexKey = pageKey.endsWith(".md") ? undefined : `${pageKey}/index.md`;
  const matchesPage = (item: WikiDocument, key: string) =>
    item.tenant_id === source.tenant_id &&
    item.from.some(
      (binding) =>
        binding.binding_kind === "wiki_page" &&
        binding.context_id === wikiId &&
        binding.page_key === key,
    );
  if (matchesPage(source, primaryKey)) return source.id;
  let indexDocumentId =
    indexKey && matchesPage(source, indexKey) ? source.id : undefined;

  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/personal-wiki/documents", {
        params: {
          path: { tenantId: source.tenant_id },
          query: { ...(cursor ? { cursor } : {}), limit: 100 },
        },
      }),
    );
    const target = page.items.find((item) => matchesPage(item, primaryKey));
    if (target) return target.id;
    if (indexKey && !indexDocumentId) {
      indexDocumentId = page.items.find((item) =>
        matchesPage(item, indexKey),
      )?.id;
    }
    if (!page.page.has_more) break;
    cursor = page.page.next_cursor;
    if (!cursor || seen.has(cursor))
      throw new Error("Wiki directory could not be loaded. Please try again.");
    seen.add(cursor);
  } while (cursor);
  if (indexDocumentId) return indexDocumentId;
  throw new Error(
    "This linked Wiki page is unavailable or you no longer have access.",
  );
}

export function useWikiDocumentLinks(
  client: TeamHubClient,
  document: WikiDocument | undefined,
  contentRef: RefObject<HTMLElement | null>,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const request = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documentId = document?.id;
  const anchorLinks = useDocumentAnchorLinks(contentRef, documentId);
  useEffect(() => {
    setPending(false);
    setError(null);
    return () => {
      request.current += 1;
    };
  }, [documentId]);

  function openLink(event: SyntheticEvent) {
    if (anchorLinks.openAnchor(event)) return;
    const binding = document?.from.find(
      (source) => source.binding_kind === "wiki_page" && source.page_key,
    );
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !document ||
      !binding?.page_key ||
      !(anchor instanceof HTMLAnchorElement)
    )
      return;
    // Interpret the stored Wiki path, not the browser's Document-relative URL.
    const reference = anchor.getAttribute("href")?.trim() ?? "";
    // A cited message opens in its Room in this window.
    if (isWikiCitationHref(reference)) {
      event.preventDefault();
      event.stopPropagation();
      request.current += 1;
      setPending(false);
      setError(null);
      void navigate(reference);
      return;
    }
    const target = resolveWikiPageReference(reference, binding.page_key);
    if (!target) {
      if (!reference || /^(?:#|\/\/|[a-z][a-z\d+.-]*:|\/t\/)/i.test(reference))
        return;
      event.preventDefault();
      event.stopPropagation();
      request.current += 1;
      setPending(false);
      setError("This link does not point to an available Wiki page.");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const currentRequest = ++request.current;
    setPending(true);
    setError(null);
    void queryClient
      .fetchQuery({
        queryKey: [
          ...personalWikiDocumentsQueryKey(document.tenant_id),
          "link-target",
          binding.context_id,
          target.pageKey,
        ],
        queryFn: () =>
          findWikiPageDocument(
            client,
            document,
            binding.context_id,
            target.pageKey,
          ),
        staleTime: 60_000,
        retry: false,
      })
      .then((targetId) => {
        if (request.current !== currentRequest) return;
        setPending(false);
        void navigate(
          documentDetailPath({
            documentId: targetId,
            tenantId: document.tenant_id,
          }) + target.hash,
        );
      })
      .catch(() => {
        if (request.current !== currentRequest) return;
        setPending(false);
        setError(
          "This linked Wiki page could not be opened. It may be unavailable or you may no longer have access. Please try again.",
        );
      });
  }
  return {
    error: pending ? null : (anchorLinks.error ?? error),
    openLink,
    pending,
  };
}
