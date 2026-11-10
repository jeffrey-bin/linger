import { writeClipboardText } from "@/lib/clipboard";

import { parseInternalRoomDocumentLink } from "./document-detail-routes";

export interface DocumentClipboardLink {
  documentId: string;
  tenantId: string;
  title: string;
  url: string;
}

export async function writeDocumentLinkClipboard(link: DocumentClipboardLink) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const html = `<a href="${escapeHtml(link.url)}" data-linger-document-id="${escapeHtml(link.documentId)}" data-linger-tenant-id="${escapeHtml(link.tenantId)}">${escapeHtml(link.title)}</a>`;
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([link.url], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Keep canonical plain text available on older or restricted browsers.
    }
  }
  await writeClipboardText(link.url);
}

export function readDocumentClipboardLink(
  clipboardData: Pick<DataTransfer, "getData">,
  origin: string,
): DocumentClipboardLink | undefined {
  const plain = clipboardData.getData("text/plain").trim();
  const parsedPlain = parseInternalRoomDocumentLink(plain, origin);
  const html = clipboardData.getData("text/html");
  if (!parsedPlain || !html) return undefined;
  const document = new DOMParser().parseFromString(html, "text/html");
  const anchor = document.querySelector("a[data-linger-document-id]");
  return parseDocumentClipboardAnchor(anchor, origin, parsedPlain, plain);
}

export function parseDocumentClipboardAnchor(
  element: Element | null,
  origin: string,
  expected?: { documentId: string; tenantId: string },
  plainUrl?: string,
): DocumentClipboardLink | undefined {
  if (!(element instanceof HTMLAnchorElement)) return undefined;
  const parsed = parseInternalRoomDocumentLink(element.href, origin);
  const documentId = element.dataset.lingerDocumentId;
  const tenantId = element.dataset.lingerTenantId;
  const title = element.textContent?.trim();
  if (
    !parsed ||
    !documentId ||
    !tenantId ||
    !title ||
    parsed.documentId !== documentId ||
    parsed.tenantId !== tenantId ||
    (expected !== undefined &&
      (expected.documentId !== documentId || expected.tenantId !== tenantId))
  ) {
    return undefined;
  }
  return {
    documentId,
    tenantId,
    title,
    url: plainUrl ?? element.href,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
