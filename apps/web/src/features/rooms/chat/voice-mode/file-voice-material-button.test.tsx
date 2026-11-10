import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { isVoiceDocumentSelection } from "../../room-drafts";
import { FileVoiceMaterialButton } from "./file-voice-material-button";
import {
  useOptionalVoiceMaterials,
  VoiceMaterialsProvider,
} from "./voice-materials-context";
import { VoiceMaterialsPreview } from "./voice-materials-preview";

const scope = {
  accountId: "account-1",
  roomId: "room-1",
  tenantId: "tenant-1",
};

function EnterVoiceMode({ entered }: { entered: boolean }) {
  const materials = useOptionalVoiceMaterials();
  useEffect(() => {
    materials?.setVoiceModeEntered(entered);
  }, [entered, materials]);
  return null;
}

function renderButton(entered: boolean) {
  return render(
    <VoiceMaterialsProvider enabled scope={scope}>
      <EnterVoiceMode entered={entered} />
      <FileVoiceMaterialButton
        documentId="doc-report"
        filename="Q3 report.pdf"
        versionId="version-1"
      />
      <VoiceMaterialsPreview />
    </VoiceMaterialsProvider>,
  );
}

describe("FileVoiceMaterialButton", () => {
  // Voice materials persist in the Room draft; start every case empty.
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
  });

  it("adds the whole file as one voice material while Voice Mode is on", () => {
    renderButton(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Add Q3 report.pdf to voice" }),
    );

    expect(
      screen.getByRole("button", { name: "Q3 report.pdf added to voice" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Remove selection from Q3 report.pdf",
      }),
    ).toBeInTheDocument();
  });

  it("floats below the card and reveals only on hover or keyboard focus", () => {
    renderButton(true);
    const button = screen.getByRole("button", {
      name: "Add Q3 report.pdf to voice",
    });
    const wrapper = button.closest("[data-file-voice-material]");
    // Button carries its own `relative`; the float must live on the wrapper.
    expect(wrapper?.className).toContain("absolute");
    expect(wrapper?.className).toContain("top-full");
    expect(wrapper?.className).toContain("left-1/2");
    expect(wrapper?.className).toContain("-translate-x-1/2");
    expect(wrapper?.className).toContain("opacity-0");
    expect(wrapper?.className).toContain("group-hover/file:opacity-100");
    expect(wrapper?.className).toContain("focus-within:opacity-100");
    expect(button.className).not.toContain("absolute");
  });

  it("stays hidden outside Voice Mode", () => {
    renderButton(false);
    expect(screen.queryByRole("button", { name: /to voice/ })).toBeNull();
  });

  it("accepts an empty quote only for a Document material", () => {
    const base = { id: "m1", title: "Q3 report.pdf", quote: "" };
    expect(
      isVoiceDocumentSelection({ ...base, documentId: "doc-report" }),
    ).toBe(true);
    expect(isVoiceDocumentSelection({ ...base, messageId: "message-1" })).toBe(
      false,
    );
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
