import { render, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { MessageRow } from "./message-row";
import { useRoomMessagePresentations } from "./room-message-presentations";

const nova: TeamHubActorRef = {
  display_name: "Nova",
  id: "actor-nova",
  kind: "agent",
  tenant_id: "tenant-a",
};

function message(id: string, body: string): TeamHubMessage {
  return {
    attachments: [
      {
        available: true,
        document_id: `document-${id}`,
        filename: `${id}.pdf`,
        id: `attachment-${id}`,
        media_type: "application/pdf",
        size_bytes: 10,
      },
    ] as TeamHubMessage["attachments"],
    author: nova,
    created_at: "2026-11-11T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-a",
    segments: [
      {
        content: "@Nova",
        target: nova.id,
        target_type: "agent",
        type: "reference",
      },
      { content: ` ${body}`, type: "text" },
    ] as TeamHubMessage["segments"],
    tenant_id: "tenant-a",
  };
}

describe("Room Message presentations", () => {
  it("keeps each unchanged Message's presentation when another arrives", () => {
    const first = message("message-1", "first");
    const second = message("message-2", "second");
    const props = {
      deliveryPresentations: {},
      mentionOptions: [nova],
      messages: [first],
      roomMessagePresentations: {},
    };
    const { rerender, result } = renderHook(useRoomMessagePresentations, {
      initialProps: props,
    });
    const before = result.current["message-1"];
    expect(before?.mentions).toEqual([nova]);
    expect(before?.attachments).toHaveLength(1);

    rerender({ ...props, messages: [first, second] });

    expect(result.current["message-1"]).toBe(before);
    expect(result.current["message-2"]?.attachments[0]?.filename).toBe(
      "message-2.pdf",
    );
  });

  it("updates a streamed Message body in place instead of remounting it", () => {
    const rowProps = {
      actorDisplayNames: {},
      documentMetadata: {},
      documentTitles: {},
      onCardDecision: () => undefined,
      onOpenArtifact: () => undefined,
      onOpenMessageFile: () => undefined,
      onOpenProfile: () => undefined,
      tenantId: "tenant-a",
      workspaceAgentIds: new Set<string>(),
    };
    const streaming = { ...message("message-1", "Hello"), attachments: [] };
    const { container, rerender } = render(
      <MessageRow {...rowProps} message={streaming} />,
    );
    const body = container.querySelector(".message-row-body");
    expect(body).toHaveTextContent("Hello");

    rerender(
      <MessageRow
        {...rowProps}
        message={{
          ...streaming,
          raw_message: "Hello world",
          segments: [{ content: "Hello world", type: "text" }],
        }}
      />,
    );

    expect(container.querySelector(".message-row-body")).toBe(body);
    expect(body).toHaveTextContent("Hello world");
  });
});
