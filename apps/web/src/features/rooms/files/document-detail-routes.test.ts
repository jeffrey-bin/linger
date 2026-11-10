import { describe, expect, it } from "vitest";

import { parseInternalRoomDocumentLink } from "./document-detail-routes";

describe("parseInternalRoomDocumentLink", () => {
  const origin = "http://127.0.0.1:5174";

  it("parses the canonical Document route with a decoded stable identity", () => {
    expect(
      parseInternalRoomDocumentLink(
        `${origin}/t/tenant%20one/documents/document%2Fone`,
        origin,
      ),
    ).toEqual({
      documentId: "document/one",
      tenantId: "tenant one",
    });
    expect(
      parseInternalRoomDocumentLink("/t/tenant-1/documents/document-1", origin),
    ).toEqual({
      documentId: "document-1",
      tenantId: "tenant-1",
    });
  });

  it("rejects foreign origins, malformed escapes, query strings, and legacy Artifact routes", () => {
    expect(
      parseInternalRoomDocumentLink(
        "https://example.com/t/tenant-1/documents/document-1",
        origin,
      ),
    ).toBeNull();
    expect(
      parseInternalRoomDocumentLink(
        `${origin}/t/tenant-1/documents/%E0%A4%A`,
        origin,
      ),
    ).toBeNull();
    expect(
      parseInternalRoomDocumentLink(
        `${origin}/t/tenant-1/documents/document-1?download=1`,
        origin,
      ),
    ).toBeNull();
    expect(
      parseInternalRoomDocumentLink(
        `${origin}/t/tenant-1/library/artifacts/rooms/room-1/files/artifact-1`,
        origin,
      ),
    ).toBeNull();
  });
});
