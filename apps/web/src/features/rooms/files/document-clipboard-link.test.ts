// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { readDocumentClipboardLink } from "./document-clipboard-link";

describe("Document clipboard links", () => {
  it("accepts matching canonical plain text and rich Document metadata", () => {
    const url = `${window.location.origin}/t/tenant-1/documents/document-1`;
    expect(
      readDocumentClipboardLink(
        {
          getData: (type) =>
            type === "text/html"
              ? `<a href="${url}" data-linger-document-id="document-1" data-linger-tenant-id="tenant-1">Launch plan</a>`
              : url,
        },
        window.location.origin,
      ),
    ).toEqual({
      documentId: "document-1",
      tenantId: "tenant-1",
      title: "Launch plan",
      url,
    });
  });

  it("rejects rich metadata that does not match the canonical URL", () => {
    const url = `${window.location.origin}/t/tenant-1/documents/document-1`;
    expect(
      readDocumentClipboardLink(
        {
          getData: (type) =>
            type === "text/html"
              ? `<a href="${url}" data-linger-document-id="document-other" data-linger-tenant-id="tenant-1">Wrong</a>`
              : url,
        },
        window.location.origin,
      ),
    ).toBeUndefined();
  });
});
