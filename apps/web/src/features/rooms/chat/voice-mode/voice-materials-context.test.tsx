import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { readRoomComposerDraft } from "../../room-drafts";
import {
  roomOffersVoiceMaterials,
  useOptionalVoiceMaterials,
  VoiceMaterialsProvider,
} from "./voice-materials-context";

const voiceRoom = {
  accountId: "account-1",
  roomId: "room-voice",
  tenantId: "tenant-1",
};

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createTestStorage(),
  });
});

describe("roomOffersVoiceMaterials", () => {
  it("offers Add to voice in group and direct Rooms but not in Threads", () => {
    expect(roomOffersVoiceMaterials({ kind: "room" })).toBe(true);
    expect(roomOffersVoiceMaterials({ kind: "direct" })).toBe(true);
    expect(roomOffersVoiceMaterials({ kind: "thread" })).toBe(false);
  });
});

describe("remote voice material collection", () => {
  it("collects only Message text for the voice Room while Voice Mode runs elsewhere", () => {
    let materials!: ReturnType<typeof useOptionalVoiceMaterials>;
    function Capture() {
      materials = useOptionalVoiceMaterials();
      return null;
    }
    render(
      <VoiceMaterialsProvider enabled remote scope={voiceRoom}>
        <Capture />
      </VoiceMaterialsProvider>,
    );
    expect(materials).toMatchObject({
      acceptsDocuments: false,
      roomId: "room-voice",
      voiceModeEntered: true,
    });

    let accepted = true;
    act(() => {
      accepted = materials!.addSelection({
        documentId: "doc-plan",
        quote: "Scope",
        title: "Plan",
      });
    });
    expect(accepted).toBe(false);
    act(() => {
      accepted = materials!.addSelection({
        messageId: "message-7",
        quote: "Ship Friday",
        title: "Alex",
      });
    });
    expect(accepted).toBe(true);
    expect(readRoomComposerDraft(voiceRoom).voiceMaterials).toEqual([
      expect.objectContaining({ messageId: "message-7", quote: "Ship Friday" }),
    ]);
  });
});

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}
