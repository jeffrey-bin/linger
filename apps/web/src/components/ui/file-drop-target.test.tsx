import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { FileDropTarget } from "./file-drop-target";

function FileDropHarness({
  accepting = true,
  onFiles = vi.fn(),
  scopeKey = "tenant-1/room-1",
}: {
  accepting?: boolean;
  onFiles?: (files: File[]) => void;
  scopeKey?: string;
}) {
  return (
    <FileDropTarget
      canAccept={() => accepting}
      className="relative"
      key={scopeKey}
      onFiles={onFiles}
      subtitle="Up to 5 files"
      testId="room-chat-file-drop-target"
      title="Release to add to the current message"
    >
      <span data-testid="nested">Nested</span>
    </FileDropTarget>
  );
}

it("shows a stable overlay while files cross nested target elements", () => {
  render(<FileDropHarness />);
  const target = screen.getByTestId("room-chat-file-drop-target");
  const nested = screen.getByTestId("nested");
  const transfer = fileTransfer([new File(["x"], "x.txt")]);

  fireEvent.dragEnter(target, { dataTransfer: transfer });
  fireEvent.dragEnter(nested, { dataTransfer: transfer });
  expect(
    screen.getByText("Release to add to the current message"),
  ).toBeVisible();
  expect(screen.getByText("Up to 5 files")).toBeVisible();
  expect(screen.queryByText(/100 MiB/)).toBeNull();
  const nestedLeave = createEvent.dragLeave(nested, {
    dataTransfer: transfer,
  });
  Object.defineProperty(nestedLeave, "relatedTarget", { value: target });
  fireEvent(nested, nestedLeave);
  expect(
    screen.getByText("Release to add to the current message"),
  ).toBeVisible();
  fireEvent.dragLeave(target, { dataTransfer: transfer });
  expect(
    screen.queryByText("Release to add to the current message"),
  ).toBeNull();
});

it("delivers files once and clears the overlay on drop", () => {
  const onFiles = vi.fn();
  const file = new File(["x"], "x.txt");
  render(<FileDropHarness onFiles={onFiles} />);
  const target = screen.getByTestId("room-chat-file-drop-target");
  const transfer = fileTransfer([file]);

  fireEvent.dragEnter(target, { dataTransfer: transfer });
  fireEvent.drop(target, { dataTransfer: transfer });

  expect(onFiles).toHaveBeenCalledOnce();
  expect(onFiles).toHaveBeenCalledWith([file], expect.anything());
  expect(
    screen.queryByText("Release to add to the current message"),
  ).toBeNull();
});

it("ignores text drags and unavailable composers", () => {
  const onFiles = vi.fn();
  const { rerender } = render(
    <FileDropHarness accepting={false} onFiles={onFiles} />,
  );
  const target = screen.getByTestId("room-chat-file-drop-target");

  expect(fireEvent.dragEnter(target, { dataTransfer: textTransfer() })).toBe(
    true,
  );
  expect(
    screen.queryByText("Release to add to the current message"),
  ).toBeNull();

  rerender(<FileDropHarness accepting={false} onFiles={onFiles} />);
  fireEvent.drop(target, {
    dataTransfer: fileTransfer([new File(["x"], "x.txt")]),
  });
  expect(onFiles).not.toHaveBeenCalled();
});

it("clears active drag feedback when the Room scope changes", () => {
  const { rerender } = render(<FileDropHarness scopeKey="room-1" />);
  fireEvent.dragEnter(screen.getByTestId("room-chat-file-drop-target"), {
    dataTransfer: fileTransfer([new File(["x"], "x.txt")]),
  });
  expect(
    screen.getByText("Release to add to the current message"),
  ).toBeVisible();

  rerender(<FileDropHarness scopeKey="room-2" />);
  expect(
    screen.queryByText("Release to add to the current message"),
  ).toBeNull();
});

function fileTransfer(files: File[]) {
  return {
    dropEffect: "none",
    files,
    items: files.map(() => ({ kind: "file" })),
    types: ["Files"],
  } as unknown as DataTransfer;
}

function textTransfer() {
  return {
    dropEffect: "none",
    files: [],
    items: [{ kind: "string" }],
    types: ["text/plain"],
  } as unknown as DataTransfer;
}
