import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedUploadedDocument,
} from "@/test/document-scenarios";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { DocumentVersionPreview } from "../documents/document-version-preview";
import { ArtifactPreviewSurface } from "./artifact-preview-surface";

// These cases exercise session expiry and refresh, not the renderer's cold
// module load. Prepare the real renderer before starting the expiry clock.
beforeAll(async () => {
  await import("@/components/read-only-blocknote-document");
});

afterEach(() => vi.useRealTimers());

for (const surface of ["details", "attachment"] as const) {
  for (const kind of ["html", "markdown"] as const) {
    it(`${surface} ${kind} restores expired resources only on explicit refresh`, async () => {
      const runtime = createDocumentTestRuntime();

      const filename = kind === "html" ? "index.html" : "readme.md";
      const document = await seedUploadedDocument(
        runtime,
        `recovery-${surface}-${kind}`,
        {
          file: new File(
            [kind === "html" ? "<h1>Preview</h1>" : "![Logo](./logo.png)"],
            filename,
            { type: `text/${kind}` },
          ),
          representationFormat: "binary",
        },
      );
      let sessionNumber = 0;
      const create = vi.fn(() => ({
        expires_at: new Date(Date.now() + 600000).toISOString(),
        preview_url: `https://preview.example.test/v0/document-previews/token-${++sessionNumber}/${filename}`,
      }));
      runtime.server.on(
        "POST",
        "/v0/document-versions/{documentVersionId}/preview-sessions",
        create,
      );
      const element = (title: string) => (
        <TeamHubRuntimeProvider runtime={runtime}>
          {surface === "details" ? (
            <DocumentVersionPreview
              client={runtime.client}
              document={{ ...document, title }}
            />
          ) : (
            <ArtifactPreviewSurface node={{ ...document, title }} />
          )}
        </TeamHubRuntimeProvider>
      );
      // Keep promise scheduling live while driving the session expiry clock.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const view = render(element(document.title));
      if (kind === "html") {
        expect(
          await vi.waitFor(() => screen.getByTitle(`Preview ${filename}`), {
            timeout: 5_000,
          }),
        ).toHaveAttribute("src", expect.stringContaining("/token-1/"));
      } else {
        expect(
          await vi.waitFor(() => screen.getByRole("img", { name: "Logo" }), {
            timeout: 5_000,
          }),
        ).toHaveAttribute(
          "src",
          "https://preview.example.test/v0/document-previews/token-1/logo.png",
        );
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300000);
      });
      view.rerender(element("Unrelated title change"));
      expect(
        screen.queryByRole("button", { name: "Refresh preview" }),
      ).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(301000);
      });
      expect(create).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: { documentVersionId: document.current_version!.id },
        }),
      );
      expect(
        screen.queryByRole("button", { name: "Refresh preview" }),
      ).toBeNull();
      const resource =
        kind === "html"
          ? screen.getByTitle(`Preview ${filename}`)
          : screen.getByRole("img", { name: "Logo" });
      expect(resource).toHaveAttribute(
        "src",
        expect.stringContaining("/token-2/"),
      );
      view.unmount();
    });
  }
}
