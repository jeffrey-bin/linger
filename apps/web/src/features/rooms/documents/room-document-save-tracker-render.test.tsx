import { Fragment, useState, useSyncExternalStore } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { RoomDocumentSaveTracker } from "./room-document-save-tracker";

describe("Room Document save tracker React subscription", () => {
  it("defers subscriber notification when Yjs changes during another component render", async () => {
    const document = new Y.Doc({ gc: true });
    const tracker = new RoomDocumentSaveTracker({
      document,
      documentId: "document-1",
      schemaVersion: 1,
      stateHashVersion: 1,
    });
    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.setUnsyncedChanges(0);
    tracker.acceptDurableAck({
      head: {
        document_id: "document-1",
        persisted_seq: 0,
        schema_version: 1,
        state_hash: "a".repeat(64),
        state_hash_version: 1,
        state_vector: Buffer.from(Y.encodeStateVector(document)).toString(
          "base64",
        ),
      },
      type: "durability_ack",
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let changedDuringRender = false;

    function SaveIndicator() {
      const snapshot = useSyncExternalStore(
        tracker.subscribe,
        tracker.getSnapshot,
        tracker.getSnapshot,
      );
      return <span data-testid="save-status">{snapshot.status}</span>;
    }

    function ChangeDocumentDuringRender() {
      if (!changedDuringRender) {
        changedDuringRender = true;
        document.getText("content").insert(0, "rendered change");
      }
      return null;
    }

    function Harness() {
      const [trigger, setTrigger] = useState(false);
      return (
        <Fragment>
          <button onClick={() => setTrigger(true)} type="button">
            Trigger change
          </button>
          <SaveIndicator />
          {trigger ? <ChangeDocumentDuringRender /> : null}
        </Fragment>
      );
    }

    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Trigger change" }));

      await waitFor(() =>
        expect(screen.getByTestId("save-status")).toHaveTextContent(
          "Local pending",
        ),
      );
      expect(
        consoleError.mock.calls.flat().map(String).join("\n"),
      ).not.toContain("Cannot update a component");
    } finally {
      tracker.destroy();
      consoleError.mockRestore();
      document.destroy();
    }
  });
});
