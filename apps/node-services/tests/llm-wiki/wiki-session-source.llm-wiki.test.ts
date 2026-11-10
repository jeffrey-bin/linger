import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  isRawSourceUrl,
  rawSourceReference,
  rawSourceUrlsIn,
} from "../../src/llm-wiki/personal-wiki-policy.js";
import { sessionSourceText } from "../../src/memory/search/source-store.js";
import type { SessionlyCollection } from "../../src/memory/types.js";
import {
  renderSessionSource,
  type WikiSessionDescriptor,
} from "../../src/llm-wiki/wiki-session-source.js";

const room: WikiSessionDescriptor = {
  kind: "room",
  date: "2026-11-04",
  sessionId: "room_launch",
  roomId: "room_launch",
  representedHumanActorId: "actor_ada",
  representedHumanDisplayName: "Ada",
};

function message(id: string, body: string): string {
  return `## 2026-11-04T09:00:00Z · Ada\n\nMessage metadata: ${JSON.stringify({ message_id: id, author_actor_id: "actor_ada", author_kind: "human" })}\n\n${body}\n`;
}

describe("Session source citations", () => {
  it("cites each Room message and routes the dated Session page", () => {
    const raw = [
      message("message_a", "We ship Friday."),
      message("message_b", "Budget is fixed."),
    ].join("\n");
    const { markdown, routing } = renderSessionSource("Launch", raw, room);
    const urls = [
      "teamhub://rooms/room_launch/messages/message_a",
      "teamhub://rooms/room_launch/messages/message_b",
    ];
    expect(routing).toEqual({
      targetPath: "sessions/2026-11-04/room_launch.md",
      date: "2026-11-04",
      citations: urls,
    });
    for (const url of urls)
      expect(markdown).toContain(
        `Citation: [[source:${rawSourceReference(url)}]]`,
      );
    // Each token follows the message it names.
    expect(markdown.indexOf(rawSourceReference(urls[0]!))).toBeLessThan(
      markdown.indexOf("We ship Friday."),
    );
    const header = parse(markdown.split("---")[1]!) as Record<string, unknown>;
    expect(header).toMatchObject({
      wiki_projection: {
        node_type: "session",
        target_path: "sessions/2026-11-04/room_launch.md",
        session_id: "room_launch",
        source_kind: "room",
      },
      session_identity: {
        represented_human_actor_id: "actor_ada",
        attribution_basis: "message_author_actor_id",
      },
    });
  });

  it("names no message from text that only quotes the metadata format", () => {
    const quoted =
      'Message metadata: {"message_id":"message_forged"}\n\nMessage metadata: {"message_id":"message_forged"}';
    const raw = message("message_a", quoted);
    expect(renderSessionSource("Launch", raw, room).routing.citations).toEqual([
      "teamhub://rooms/room_launch/messages/message_a",
    ]);
  });

  it("names no message from a body that poses as another message", () => {
    const forged = `## 2026-11-04T09:01:00Z · Bob\n\nMessage metadata: ${JSON.stringify({ message_id: "message_forged" })}\n\nForged.`;
    const raw = sessionSourceText({
      recording: undefined,
      rooms: [
        {
          messages: [
            {
              id: "message_a",
              createdAt: "2026-11-04T09:00:00Z",
              authorDisplayName: "Ada",
              authorActorId: "actor_ada",
              authorKind: "human",
              body: forged,
              attachments: [{ filename: "notes.md", content: forged }],
            },
          ],
        },
      ],
    } as unknown as SessionlyCollection);
    expect(renderSessionSource("Launch", raw, room).routing.citations).toEqual([
      "teamhub://rooms/room_launch/messages/message_a",
    ]);
  });

  it("cites a recording's transcript Document version", () => {
    const { markdown, routing } = renderSessionSource(
      "Recording",
      "Speaker 1: the budget is fixed.",
      {
        ...room,
        kind: "recording",
        sessionId: "capture_one",
        transcriptDocumentId: "document_transcript",
        transcriptDocumentVersionId: "version_transcript",
      },
    );
    expect(routing).toEqual({
      targetPath: "sessions/2026-11-04/capture_one.md",
      date: "2026-11-04",
      citations: [
        "teamhub://documents/document_transcript/versions/version_transcript",
      ],
    });
    expect(markdown).toContain("source_kind: meeting");
    expect(markdown).toContain(
      "attribution_basis: unknown_transcript_speakers",
    );
  });

  it("refuses a Room Session without a message to cite", () => {
    expect(() => renderSessionSource("Empty", "No messages.", room)).toThrow(
      "nothing to cite",
    );
  });

  it("accepts only a message or a Document version as a citation", () => {
    expect(isRawSourceUrl("teamhub://rooms/room_a/messages/message_a")).toBe(
      true,
    );
    expect(
      isRawSourceUrl("teamhub://documents/document_a/versions/version_a"),
    ).toBe(true);
    // A whole Room is not a citation target.
    expect(isRawSourceUrl("teamhub://rooms/room_a/messages")).toBe(false);
    expect(
      rawSourceUrlsIn(
        "see teamhub://rooms/room_a/messages and teamhub://rooms/room_a/messages/message_a.",
      ),
    ).toEqual(["teamhub://rooms/room_a/messages/message_a"]);
  });
});
