import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useEffect, type ComponentProps } from "react";
import { RoomDocumentBlockNoteEditor } from "./room-document-blocknote-editor-loader";
const fakes = vi.hoisted(() => ({ loaded: true, mounts: vi.fn() }));
function Editor() {
  useEffect(() => {
    fakes.mounts();
  }, []);
  return <div>Preloaded editor</div>;
}
vi.mock("./document-editor-preload", () => ({
  getPreloadedDocumentEditor: () => (fakes.loaded ? Editor : undefined),
  preloadDocumentEditor: async () => ({ RoomDocumentBlockNoteEditor: Editor }),
}));
beforeEach(() => {
  fakes.loaded = true;
  fakes.mounts.mockClear();
});
const props = {} as ComponentProps<typeof RoomDocumentBlockNoteEditor>;
it("renders an already preloaded editor without a Suspense loading frame", () => {
  render(<RoomDocumentBlockNoteEditor {...props} />);
  expect(screen.getByText("Preloaded editor")).toBeVisible();
  expect(
    screen.queryByLabelText("Loading Room Document editor"),
  ).not.toBeInTheDocument();
});
it("keeps the same editor instance when its module finishes loading after mount", async () => {
  fakes.loaded = false;
  const view = render(<RoomDocumentBlockNoteEditor {...props} />);
  expect(await screen.findByText("Preloaded editor")).toBeVisible();
  fakes.loaded = true;
  view.rerender(<RoomDocumentBlockNoteEditor {...props} />);
  expect(fakes.mounts).toHaveBeenCalledTimes(1);
});
