import { describe, expect, it } from "vitest";

import { resolveMemoryDocumentLink } from "./memory-document-links";

describe("Memory document references", () => {
  it.each([
    "../contacts/person.md",
    "../../../evidence/2026-09-09/sessions/room.md",
    "../../../timeline/daily/2026-09-09.md",
    "/knowledge/projects/alpha.md",
    "/etc/passwd",
    "bad%ZZ.md",
    "\\server\\file.md",
    "teamhub://rooms/room-one/messages",
    "teamhub://documents/doc-one/versions/version-one",
    "memory://timeline/daily/2026-10-13.md",
    "memory://timeline/weekly/2026-10-05.md",
  ])("leaves private evidence %s as plain text", (href) => {
    expect(resolveMemoryDocumentLink(href)).toBeNull();
  });

  it.each([
    "#section",
    "https://example.test/guide.md",
    "mailto:person@example.test",
    "/t/tenant-one/documents/document-one",
  ])("does not remap %s as a Memory file", (href) => {
    expect(resolveMemoryDocumentLink(href)).toBeUndefined();
  });
});
