import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageComposer } from "../chat/message-composer";
import {
  commentBodyFromComposition,
  commentCompositionFromBody,
} from "./room-document-comment-body";

const bob = {
  display_name: "Bob Smith",
  id: "actor_bob",
  kind: "human" as const,
  tenant_id: "tenant_1",
};

describe("Room Document Comment composer", () => {
  it("round-trips a structured mention through the editable composition", () => {
    const body = commentBodyFromComposition({
      body: "Ask @Bob Smith today",
      files: [],
      mentions: [bob],
    });

    expect(commentCompositionFromBody(body, [bob])).toEqual({
      body: "Ask @Bob Smith today",
      files: [],
      mentions: [bob],
    });
  });

  it("submits an existing mention identity when editing without changing it", () => {
    const onSend = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageComposer
          ariaLabel="Edit comment"
          initialMentions={[bob]}
          initialValue="Ask @Bob Smith today"
          mentionOptions={[bob]}
          onSend={onSend}
        />
      </QueryClientProvider>,
    );

    fireEvent.keyDown(screen.getByLabelText("Edit comment"), { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith({
      body: "Ask @Bob Smith today",
      files: [],
      mentions: [bob],
    });
  });

  it("preserves a historical mention label as plain text after the Actor leaves the Room", () => {
    const body = commentBodyFromComposition({
      body: "Ask @Bob Smith today",
      files: [],
      mentions: [bob],
    });

    expect(commentCompositionFromBody(body, [])).toEqual({
      body: "Ask @Bob Smith today",
      files: [],
      mentions: [],
    });
  });
});
