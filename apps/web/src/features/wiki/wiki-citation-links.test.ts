import { describe, expect, it } from "vitest";

import { isWikiCitationHref } from "./wiki-citation-links";

describe("Wiki citation links", () => {
  it("recognizes only Room message paths", () => {
    expect(
      isWikiCitationHref("/t/tenant_one/rooms/room_a/chat?message=message_a"),
    ).toBe(true);
    expect(isWikiCitationHref("/t/tenant_one/rooms/room_a/chat")).toBe(false);
    expect(isWikiCitationHref("/t/tenant_one/documents/document_a")).toBe(
      false,
    );
  });
});
