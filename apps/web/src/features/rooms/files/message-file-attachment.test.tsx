import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteRequest } from "@/test/teamhub-test-server";
import * as loader from "./artifact-preview-loader";
import { MessageFileAttachment } from "./message-file-attachment";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

async function fixture() {
  const runtime = createDocumentTestRuntime();

  const document = await seedRoomUpload(runtime, "inline-image", {
    representationFormat: "png",
    file: new File(["image bytes"], "photo.png", { type: "image/png" }),
  });
  const versionId = document.current_version!.id;
  const createUrl = vi.fn(() => "blob:photo");
  const revokeUrl = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createUrl;
      static override revokeObjectURL = revokeUrl;
    },
  );
  const onOpen = vi.fn();
  const props = {
    documentId: document.id,
    versionId,
    filename: "photo.png",
    mediaType: "image/png",
    onOpen,
  };
  const element = (overrides = {}) => (
    <TeamHubRuntimeProvider runtime={runtime}>
      <MessageFileAttachment {...props} {...overrides} />
    </TeamHubRuntimeProvider>
  );
  return {
    runtime,
    document,
    versionId,
    createUrl,
    revokeUrl,
    onOpen,
    element,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MessageFileAttachment", () => {
  it("shows the exact image Version in the chat and opens the sidebar without file chrome", async () => {
    const f = await fixture();
    const getVersion = countVersionReads(f.runtime);
    const view = render(f.element());
    expect(
      await screen.findByRole("img", { name: "photo.png" }),
    ).toHaveAttribute("src", "blob:photo");
    expect(getVersion).toHaveBeenCalledWith(
      expect.objectContaining({ params: { documentVersionId: f.versionId } }),
    );
    // The image itself, not a file item with a thumbnail.
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
    expect(screen.queryByText("Image")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview photo.png" }));
    expect(f.onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(f.createUrl).toHaveBeenCalledOnce();
    expect(f.revokeUrl).not.toHaveBeenCalled();
    view.unmount();
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:photo");
  });

  it.each([
    { disabled: true },
    { previewEnabled: false },
    { sizeBytes: 51 * 1024 * 1024 },
    { mediaType: "text/html" },
    { versionId: undefined },
    { filename: "page.html", mediaType: "text/html" },
    { filename: "diagram.svg", mediaType: "image/svg+xml" },
  ])(
    "keeps non-previewable attachments as icon items without fetching: %j",
    async (overrides) => {
      const f = await fixture();
      const getVersion = countVersionReads(f.runtime);
      render(f.element(overrides));
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.getByText(overrides.filename ?? "photo.png")).toBeVisible();
      expect(getVersion).not.toHaveBeenCalled();
    },
  );

  it.each(["download", "decode", "oversize"])(
    "falls back to the file icon on %s failure",
    async (failure) => {
      const f = await fixture();
      if (failure === "download")
        vi.spyOn(f.runtime.client, "downloadDocumentVersion").mockRejectedValue(
          new Error("unavailable"),
        );
      if (failure === "oversize") {
        const version = await readDocumentVersion(
          f.runtime.client,
          f.versionId,
        );
        f.runtime.server.on(
          "GET",
          "/v0/document-versions/{documentVersionId}",
          () => ({
            ...version,
            size_bytes: 51 * 1024 * 1024,
          }),
        );
      }
      render(f.element());
      if (failure === "decode") fireEvent.error(await screen.findByRole("img"));
      expect(await screen.findByText("photo.png")).toBeVisible();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: "Preview photo.png" }),
      );
      expect(f.onOpen).toHaveBeenCalledOnce();
    },
  );

  it("defers the transfer until near the viewport and disconnects the observer", async () => {
    const f = await fixture();
    let enter: () => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          enter = () =>
            callback(
              [{ isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const getVersion = countVersionReads(f.runtime);
    render(f.element());
    expect(getVersion).not.toHaveBeenCalled();
    act(() => enter());
    expect(await screen.findByRole("img")).toBeVisible();
    expect(disconnect).toHaveBeenCalled();
  });

  it("keeps a transfer across unrelated rerenders and disposes a late response after unmount", async () => {
    const f = await fixture();
    const version = await readDocumentVersion(f.runtime.client, f.versionId);
    let finish!: (preview: loader.LoadedArtifactPreview) => void;
    const load = vi.spyOn(loader, "loadArtifactPreview").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = vi.fn();
    const view = render(f.element());
    view.rerender(f.element({ onOpen: vi.fn(), subtitle: "new label" }));
    expect(load).toHaveBeenCalledOnce();
    const signal = load.mock.calls[0]![0].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish({
        decision: { kind: "image" },
        dispose,
        objectUrl: "blob:late",
        version,
      }),
    );
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });

  it("releases the previous image when its Version changes", async () => {
    const f = await fixture();
    const version = await readDocumentVersion(f.runtime.client, f.versionId);
    f.runtime.server.on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      ({ params }) => ({ ...version, id: params.documentVersionId }),
    );
    const content = await f.runtime.client.downloadDocumentVersion(f.versionId);
    vi.spyOn(f.runtime.client, "downloadDocumentVersion").mockResolvedValue(
      content,
    );
    const view = render(f.element());
    await screen.findByRole("img");
    view.rerender(f.element({ versionId: "version-next" }));
    await screen.findByRole("img");
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:photo");
    expect(f.createUrl).toHaveBeenCalledTimes(2);
  });

  it("plays a video in the chat from its content URL without downloading it", async () => {
    const f = await fixture();
    const download = vi.spyOn(f.runtime.client, "downloadDocumentVersion");
    render(f.element({ filename: "clip.mp4", mediaType: "video/mp4" }));
    const video = await screen.findByLabelText("clip.mp4");
    await waitFor(() =>
      expect(video).toHaveAttribute(
        "src",
        expect.stringContaining(`/v0/document-versions/${f.versionId}/content`),
      ),
    );
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();

    fireEvent.error(video);
    expect(await screen.findByText("clip.mp4")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview clip.mp4" }));
    expect(f.onOpen).toHaveBeenCalledOnce();
  });

  it("keeps audio as a file item", async () => {
    const f = await fixture();
    render(f.element({ filename: "song.mp3", mediaType: "audio/mpeg" }));
    expect(screen.getByText("song.mp3")).toBeVisible();
    expect(screen.queryByLabelText("song.mp3")).not.toBeInTheDocument();
  });
});

// Serves the seeded Version and records each metadata read.
function countVersionReads(runtime: TestTeamHubRuntime) {
  const read = vi.fn(({ params }: TestRouteRequest) =>
    runtime.seed.documentVersions.get(params.documentVersionId!),
  );
  runtime.server.on("GET", "/v0/document-versions/{documentVersionId}", read);
  return read;
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
