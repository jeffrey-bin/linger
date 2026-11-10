import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WikiProfileEditor } from "./wiki-profile-editor";

const markdown = "# Avery\n\n## Background\n\nAvery leads research.";

function renderEditor(error?: string) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <WikiProfileEditor
      error={error}
      markdown={markdown}
      onCancel={onCancel}
      onSave={onSave}
      pending={false}
    />,
  );
  return { onCancel, onSave };
}

describe("WikiProfileEditor", () => {
  it("edits the whole Profile Markdown and saves it", () => {
    const { onSave } = renderEditor();
    const text = screen.getByRole("textbox", { name: "Profile Markdown" });
    expect(text).toHaveValue(markdown);
    // Nothing to save until the Markdown changes.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const edited = markdown.replace("research", "research and hiring");
    fireEvent.change(text, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(edited);
  });

  it("cancels and shows the save error", () => {
    const { onCancel } = renderEditor("Line 3: unknown section.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Line 3: unknown section.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
