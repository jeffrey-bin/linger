// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRoomDrafts,
  readRoomComposerDraft,
  subscribeRoomComposerDrafts,
  writeRoomComposerDraft,
} from "./room-drafts";

const firstRoom = {
  accountId: "account-1",
  roomId: "room-1",
  tenantId: "tenant-1",
};

describe("Room drafts", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
  });

  it("isolates drafts by Account, Tenant, Room, and optional Thread", () => {
    writeRoomComposerDraft(firstRoom, textDraft("first Room"));
    writeRoomComposerDraft(
      { ...firstRoom, accountId: "account-2" },
      textDraft("other Account"),
    );
    writeRoomComposerDraft(
      { ...firstRoom, roomId: "room-2" },
      textDraft("other Room"),
    );
    writeRoomComposerDraft(
      { ...firstRoom, threadId: "message-1" },
      textDraft("Thread reply"),
    );

    expect(readRoomComposerDraft(firstRoom).body).toBe("first Room");
    expect(
      readRoomComposerDraft({ ...firstRoom, accountId: "account-2" }).body,
    ).toBe("other Account");
    expect(readRoomComposerDraft({ ...firstRoom, roomId: "room-2" }).body).toBe(
      "other Room",
    );
    expect(
      readRoomComposerDraft({ ...firstRoom, threadId: "message-1" }).body,
    ).toBe("Thread reply");
  });

  it("tells subscribers about every write and clear", () => {
    const listener = vi.fn();
    const stop = subscribeRoomComposerDrafts(listener);
    writeRoomComposerDraft(firstRoom, {
      ...readRoomComposerDraft(firstRoom),
      body: "hello",
    });
    clearRoomDrafts();
    stop();
    writeRoomComposerDraft(firstRoom, {
      ...readRoomComposerDraft(firstRoom),
      body: "after",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears only Room drafts during local sign-out", () => {
    writeRoomComposerDraft(firstRoom, textDraft("private draft"));
    window.localStorage.setItem("unrelated", "keep");

    clearRoomDrafts();

    expect(readRoomComposerDraft(firstRoom).body).toBe("");
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("round-trips structured Composer references", () => {
    const draft = {
      documentContexts: [],
      body: "@Codex /review-changes inspect @Launch_plan",
      documentReferences: [
        {
          documentId: "document-plan",
          token: "@Launch_plan",
        },
      ],
      mentions: [
        {
          display_name: "Codex",
          id: "actor-codex",
          kind: "agent" as const,
          tenant_id: "tenant-1",
        },
      ],
      skillReferences: [
        {
          manifestVersion: "1.0.0",
          skillId: "skill-review",
          target: "actor-codex",
          token: "/review-changes",
        },
      ],
    };

    writeRoomComposerDraft(firstRoom, draft);

    expect(readRoomComposerDraft(firstRoom)).toEqual(draft);
  });

  it("persists immutable Document Version context without requiring message text", () => {
    const draft = {
      documentContexts: [
        {
          documentId: "document-report",
          documentVersionId: "version-report-v1",
          filename: "report.md",
          sourceRoomId: "room-source",
          sourceRoomName: "Source Room",
          versionNumber: 1,
        },
      ],
      body: "",
      documentReferences: [],
      mentions: [],
      skillReferences: [],
    };

    writeRoomComposerDraft(firstRoom, draft);

    expect(readRoomComposerDraft(firstRoom)).toEqual(draft);
  });

  it("keeps selected voice excerpts without text and discards malformed restored selections", () => {
    const voiceMaterials = [
      {
        id: "selection-1",
        documentId: "document-plan",
        title: "Plan",
        quote: "Selected source paragraph",
      },
    ];
    const draft = { ...readRoomComposerDraft(firstRoom), voiceMaterials };
    writeRoomComposerDraft(firstRoom, draft);
    expect(readRoomComposerDraft(firstRoom).voiceMaterials).toEqual(
      voiceMaterials,
    );
    expect(
      readRoomComposerDraft({ ...firstRoom, roomId: "other" }).voiceMaterials,
    ).toBeUndefined();
    writeRoomComposerDraft(firstRoom, {
      ...draft,
      voiceMaterials: [{ ...voiceMaterials[0]!, quote: "x".repeat(10_001) }],
    });
    expect(readRoomComposerDraft(firstRoom).voiceMaterials).toEqual([]);
  });

  it("keeps a Message excerpt and rejects a selection with two or no sources", () => {
    const message = {
      id: "selection-2",
      messageId: "message_abc",
      title: "AnotherMe",
      quote: "Selected chat sentence",
    };
    const draft = { ...readRoomComposerDraft(firstRoom) };
    writeRoomComposerDraft(firstRoom, { ...draft, voiceMaterials: [message] });
    expect(readRoomComposerDraft(firstRoom).voiceMaterials).toEqual([message]);
    for (const invalid of [
      { ...message, documentId: "document-plan" },
      { ...message, messageId: undefined },
      { ...message, versionId: "version-1" },
    ]) {
      writeRoomComposerDraft(firstRoom, {
        ...draft,
        voiceMaterials: [invalid],
      });
      expect(readRoomComposerDraft(firstRoom).voiceMaterials).toEqual([]);
    }
  });

  it("keeps draft text opaque, including JSON-shaped text with a format marker", () => {
    const protocolShapedText =
      '{"format":"linger-composer-draft-v1","body":"must stay JSON"}';
    writeRoomComposerDraft(firstRoom, textDraft(protocolShapedText));

    expect(readRoomComposerDraft(firstRoom)).toEqual(
      textDraft(protocolShapedText),
    );
  });

  it("filters malformed structured references and removes an empty structured draft", () => {
    window.localStorage.setItem(
      "linger.room-composer-draft:account-1:tenant-1:room-1",
      JSON.stringify({
        artifactContexts: [
          {
            artifactId: "legacy-artifact",
            artifactVersionId: "legacy-version",
            filename: "legacy.md",
            sourceRoomId: "room-source",
            sourceRoomName: "Source Room",
            versionNumber: 1,
          },
        ],
        body: "Keep valid data only",
        documentReferences: [
          { documentId: "document-plan", token: "@Launch_plan" },
          { documentId: 42, token: "@Broken" },
        ],
        format: "linger-composer-draft-v3",
        mentions: [{ display_name: "Broken" }],
        skillReferences: [{ skillId: "missing-fields" }],
      }),
    );

    expect(readRoomComposerDraft(firstRoom)).toEqual({
      documentContexts: [],
      body: "Keep valid data only",
      documentReferences: [
        { documentId: "document-plan", token: "@Launch_plan" },
      ],
      mentions: [],
      skillReferences: [],
    });

    writeRoomComposerDraft(firstRoom, {
      documentContexts: [],
      body: "",
      documentReferences: [],
      mentions: [],
      skillReferences: [],
    });
    expect(
      window.localStorage.getItem(
        "linger.room-composer-draft:account-1:tenant-1:room-1",
      ),
    ).toBeNull();
  });
});

function textDraft(body: string) {
  return {
    documentContexts: [],
    body,
    documentReferences: [],
    mentions: [],
    skillReferences: [],
  };
}

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
