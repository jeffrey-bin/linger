import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaPreviewAdapter } from "./media-preview-adapter";

describe("MediaPreviewAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows a terminal codec error with a download fallback", () => {
    const { container } = render(
      <MediaPreviewAdapter
        filename="meeting.mp4"
        mediaType="video/mp4"
        objectUrl="/v0/artifact-versions/version-1/content"
      />,
    );

    fireEvent.error(container.querySelector("video")!);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This browser cannot play the file's media codec",
    );
    expect(
      screen.getByRole("button", { name: "Download original" }),
    ).toBeVisible();
  });

  it("keeps the download fallback when audio decoding fails", () => {
    const { container } = render(
      <MediaPreviewAdapter
        filename="source.m4a"
        mediaType="audio/mp4"
        objectUrl="blob:audio"
      />,
    );
    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This browser cannot play the file's media codec",
    );
    expect(
      screen.getByRole("button", { name: "Download original" }),
    ).toBeVisible();
  });

  it("preloads media data so a revisited video can decode its first frame", () => {
    const { container } = render(
      <MediaPreviewAdapter
        filename="meeting.webm"
        mediaType="video/webm"
        objectUrl="blob:meeting"
      />,
    );

    expect(container.querySelector("video")).toHaveAttribute("preload", "auto");
  });

  it("renders the native media source with its declared MIME type", () => {
    const { container } = render(
      <MediaPreviewAdapter
        filename="source.webm"
        mediaType="audio/webm;codecs=opus"
        objectUrl="/v0/artifact-versions/version-1/content"
      />,
    );

    const source = container.querySelector("audio source");
    expect(source).toHaveAttribute(
      "src",
      "/v0/artifact-versions/version-1/content",
    );
    expect(source).toHaveAttribute("type", "audio/webm;codecs=opus");
  });

  it("plays and seeks audio without leaving the duration", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue();
    const { container } = render(
      <MediaPreviewAdapter
        filename="source.m4a"
        mediaType="audio/mp4"
        objectUrl="blob:audio"
      />,
    );
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 37 });
    fireEvent.durationChange(audio);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(play).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Audio position" }), {
      target: { value: "35" },
    });
    expect(audio.currentTime).toBe(35);
    fireEvent.change(screen.getByRole("slider", { name: "Audio position" }), {
      target: { value: "99" },
    });
    expect(audio.currentTime).toBe(37);
    expect(
      screen.queryByRole("button", { name: /10 seconds/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /mute/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("slider", { name: "Volume" }),
    ).not.toBeInTheDocument();
    play.mockRestore();
  });

  it("shows decoded audio waveform when the file is small enough", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const decodeAudioData = vi.fn().mockResolvedValue({
      duration: 37,
      getChannelData: () => new Float32Array([0, 0.25, 0.5, 1]),
      numberOfChannels: 1,
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData = decodeAudioData;
        close = close;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      }),
    );
    const { container } = render(
      <MediaPreviewAdapter
        filename="source.m4a"
        mediaType="audio/mp4"
        objectUrl="blob:audio"
        sourceSizeBytes={4}
      />,
    );
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 37 });
    fireEvent.durationChange(audio);
    expect(
      await screen.findByRole("img", { name: "Audio waveform" }),
    ).toBeVisible();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
