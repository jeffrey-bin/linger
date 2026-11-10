import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  RoomChromeProvider,
  type RoomOutletContext,
  useRoomOutletContext,
} from "./room-connectivity";

const chrome: RoomOutletContext = {
  focusPanelMessageId: null,
  lastAppliedRoomSeq: 0,
  messagePresentations: {},
  openPanelTab: vi.fn(),
  openProfile: () => undefined,
  recordMessagePresentation: () => undefined,
  status: "connected",
};

function Probe() {
  const { openPanelTab } = useRoomOutletContext();
  return (
    <button
      onClick={() =>
        openPanelTab({
          documentId: "document-1",
          kind: "file",
          title: "thread-proof.txt",
        })
      }
      type="button"
    >
      Open file
    </button>
  );
}

describe("Room chrome context", () => {
  it("lets the Thread sidebar open a file tab", () => {
    render(
      <RoomChromeProvider value={chrome}>
        <Probe />
      </RoomChromeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(chrome.openPanelTab).toHaveBeenCalledWith({
      documentId: "document-1",
      kind: "file",
      title: "thread-proof.txt",
    });
  });
});
