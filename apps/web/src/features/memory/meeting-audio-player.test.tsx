import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatPlaybackTime, MeetingAudioPlayer } from "./meeting-audio-player";

afterEach(() => vi.restoreAllMocks());

describe("MeetingAudioPlayer", () => {
  it("formats playback time with hours only when needed", () => {
    expect(
      [0, 9.6, 65, 754.2, 3725, Number.NaN].map(formatPlaybackTime),
    ).toEqual(["0:00", "0:09", "1:05", "12:34", "1:02:05", "0:00"]);
  });

  it("waits disabled while the recording loads", () => {
    render(
      <MeetingAudioPlayer
        downloadDisabled
        filename="recording.m4a"
        onDownload={vi.fn()}
        status="Loading..."
      />,
    );
    expect(
      screen.getByRole("button", { name: "Play recording" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("slider", { name: "Seek recording" }),
    ).toBeDisabled();
    expect(screen.getByText("Loading...")).toBeVisible();
  });

  it("plays, follows the playhead, seeks, and downloads", () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const onDownload = vi.fn();
    const { container } = render(
      <MeetingAudioPlayer
        filename="recording.m4a"
        mediaType="audio/mp4"
        onDownload={onDownload}
        src="blob:recording"
      />,
    );
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 125,
    });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByText("0:00 / 2:05")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
    expect(play).toHaveBeenCalledOnce();
    fireEvent.play(audio);
    expect(
      screen.getByRole("button", { name: "Pause recording" }),
    ).toBeVisible();

    audio.currentTime = 42;
    fireEvent.timeUpdate(audio);
    expect(screen.getByText("0:42 / 2:05")).toBeVisible();

    fireEvent.change(screen.getByRole("slider", { name: "Seek recording" }), {
      target: { value: "100" },
    });
    expect(audio.currentTime).toBe(100);

    fireEvent.click(
      screen.getByRole("button", { name: "Download recording.m4a" }),
    );
    expect(onDownload).toHaveBeenCalledOnce();
  });
});
