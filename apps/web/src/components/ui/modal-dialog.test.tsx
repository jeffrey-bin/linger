import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModalDialog } from "./modal-dialog";

// jsdom does not move focus on showModal, so mimic browsers: open the dialog and focus its first control.
function stubShowModal() {
  const original = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true;
    this.querySelector<HTMLElement>("button, input")?.focus();
  };
  return () => {
    HTMLDialogElement.prototype.showModal = original;
  };
}

describe("ModalDialog initial focus", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stubShowModal();
  });

  afterEach(() => {
    restore();
  });

  it("moves initial focus from the header close button into the body", () => {
    render(
      <ModalDialog onClose={vi.fn()} title="Rename">
        <input aria-label="File name" />
      </ModalDialog>,
    );

    expect(screen.getByRole("textbox", { name: "File name" })).toHaveFocus();
  });

  it("falls back to the footer when the body has nothing focusable", () => {
    render(
      <ModalDialog
        footer={<button type="button">Save</button>}
        onClose={vi.fn()}
        title="Notice"
      >
        <p>Read only</p>
      </ModalDialog>,
    );

    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  });

  it("keeps focus on the close button when nothing else is focusable", () => {
    render(
      <ModalDialog onClose={vi.fn()} title="Info">
        <p>Read only</p>
      </ModalDialog>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});
