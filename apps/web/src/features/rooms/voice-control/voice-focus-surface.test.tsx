import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { RecordingEntry } from "./recording-entry";
import { VoiceFocusSurface } from "./voice-focus-surface";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

describe("RecordingEntry", () => {
  it("shows saving only while recovery is still running", () => {
    const view = render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: {
            status: "recovering",
            capture: { ...capture(), status: "recovering" },
          },
        })}
      >
        <RecordingEntry anotherMeRoomId="room_another_me" />
      </VoiceControlContext.Provider>,
    );
    expect(
      screen.getByRole("button", { name: "View save progress" }),
    ).toBeEnabled();
    view.rerender(
      <VoiceControlContext.Provider
        value={voiceValue({ captureState: pausedRecovery() })}
      >
        <RecordingEntry anotherMeRoomId="room_another_me" />
      </VoiceControlContext.Provider>,
    );
    const meetings = screen.getByRole("button", { name: "Meetings" });
    expect(meetings).toBeEnabled();
    expect(meetings).toHaveAttribute("title", "Meetings");
    expect(meetings).toHaveTextContent("");
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

describe("VoiceFocusSurface", () => {
  it("keeps recording when the window closes; only Stop releases it", async () => {
    const leavePage = vi.fn(async () => undefined);
    const nextLeave = vi.fn(async () => undefined);
    const view = render(
      <StrictMode>
        <VoiceControlContext value={voiceValue({ leavePage })}>
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext>
      </StrictMode>,
    );
    await act(async () => undefined);
    expect(leavePage).not.toHaveBeenCalled();
    view.rerender(
      <StrictMode>
        <VoiceControlContext value={voiceValue({ leavePage: nextLeave })}>
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext>
      </StrictMode>,
    );
    await act(async () => undefined);
    expect(leavePage).not.toHaveBeenCalled();
    expect(nextLeave).not.toHaveBeenCalled();
    // Minimizing the window or leaving the page unmounts the surface; the
    // recording above the routes must carry on.
    view.unmount();
    await act(async () => undefined);
    expect(nextLeave).not.toHaveBeenCalled();
  });

  it("places failed transcript recovery after the latest speech and explains the paused state", () => {
    render(
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <VoiceControlContext.Provider
          value={voiceValue({
            listenerStatus: "disabled",
            captureState: {
              status: "recovering",
              capture: {
                ...capture(),
                status: "recovering",
                transcript_recovery_status: "failed",
              },
            },
            transcriptItems: [
              {
                id: "speech",
                text: "Last confirmed sentence",
                createdAtMs: 1,
              },
            ],
          })}
        >
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext.Provider>
      </TeamHubRuntimeProvider>,
    );
    const transcript = screen.getByRole("log");
    const recovery = screen.getByRole("status", {
      name: "Recording transcript recovery",
    });
    expect(
      transcript.compareDocumentPosition(recovery) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "Recording saved. Transcript recovery paused",
      }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "You can disconnect the microphone. Transcript recovery continues in the background.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start new recording" }),
    ).toBeVisible();
  });

  it("starts a new recording when re-entering while transcript recovery waits for Retry", async () => {
    const startCapture = vi.fn(async () => undefined);
    const startNewCapture = vi.fn(async () => undefined);
    render(
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <VoiceControlContext.Provider
          value={voiceValue({
            captureState: pausedRecovery(),
            listenerStatus: "disabled",
            startCapture,
            startNewCapture,
          })}
        >
          <VoiceFocusSurface autoStart onExit={vi.fn()} />
        </VoiceControlContext.Provider>
      </TeamHubRuntimeProvider>,
    );

    await vi.waitFor(() => expect(startNewCapture).toHaveBeenCalledOnce());
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("starts each transcript row with its speaker in a Town Nature color", () => {
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          transcriptItems: [
            {
              id: "speech",
              text: "Budget set at 200k",
              createdAtMs: 1,
              speakerLabel: "Speaker 1",
            },
          ],
        })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    const label = screen.getByText("Speaker 1");
    const row = label.parentElement!;
    // No dot or diamond before the speaker: the row opens with the name.
    expect(row.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(row.firstElementChild).toBe(label);
    expect(label).toHaveClass(
      "text-[14px]",
      "font-medium",
      "text-bluebell-700",
    );
    expect(label.getAttribute("style")).toBeNull();
    expect(within(row).getByText("Budget set at 200k")).toHaveClass(
      "text-sm",
      "leading-5",
    );
  });

  it("asks the browser for a microphone and starts recording on entry", async () => {
    const discoverDevices = vi.fn(async () => [microphone]);
    const selectDevice = vi.fn(async () => undefined);
    const startCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          boundDevice: undefined,
          captureState: { status: "idle" },
          discoverDevices,
          listenerStatus: "disabled",
          selectDevice,
          startCapture,
        })}
      >
        <VoiceFocusSurface autoStart onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    await vi.waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
    expect(discoverDevices).toHaveBeenCalledOnce();
    expect(selectDevice).toHaveBeenCalledWith(microphone.deviceId);
  });

  it("does not take the microphone while another tab owns the recording", async () => {
    const startCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: { status: "idle" },
          listenerStatus: "standby",
          startCapture,
        })}
      >
        <VoiceFocusSurface autoStart onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    expect(
      await screen.findByRole("heading", {
        name: "Recording is continuing in another tab",
      }),
    ).toBeVisible();
    expect(startCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Start recording" }),
    ).not.toBeInTheDocument();
  });

  it("explains a blocked microphone and starts again after it is allowed", async () => {
    const startCapture = vi.fn(async () => undefined);
    const discoverDevices = vi
      .fn<() => Promise<(typeof microphone)[]>>()
      .mockRejectedValueOnce(
        new DOMException("Permission denied", "NotAllowedError"),
      )
      .mockResolvedValue([microphone]);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          boundDevice: undefined,
          captureState: { status: "idle" },
          discoverDevices,
          listenerStatus: "disabled",
          startCapture,
        })}
      >
        <VoiceFocusSurface autoStart onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Recording did not start" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access was blocked. Allow it in the browser, then start recording again.",
    );
    expect(startCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await vi.waitFor(() => expect(startCapture).toHaveBeenCalledOnce());
  });

  it("shows Pause then Stop in the top row and no separate Mute", () => {
    render(
      <VoiceControlContext.Provider value={voiceValue()}>
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    const header = screen
      .getByLabelText("Recording duration")
      .closest("header")!;
    expect(
      within(header)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Pause", "Stop"]);
    expect(
      screen.queryByRole("button", { name: /mute microphone/i }),
    ).not.toBeInTheDocument();
  });

  it("offers to reconnect an interrupted microphone and resumes with it", async () => {
    const connectDevice = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          connectDevice,
          listenerStatus: "device_disconnected",
        })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    expect(
      screen.getByRole("heading", { name: "Recording input was interrupted" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect microphone" }),
    );
    await vi.waitFor(() =>
      expect(connectDevice).toHaveBeenCalledWith(microphone.deviceId),
    );
  });

  it("starts a new recording when entering after the previous one finished", async () => {
    const startCapture = vi.fn(async () => undefined);
    const startNewCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: {
            status: "completed",
            capture: { ...capture(), status: "finalized" },
          },
          listenerStatus: "disabled",
          startCapture,
          startNewCapture,
        })}
      >
        <VoiceFocusSurface autoStart onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    await vi.waitFor(() => expect(startNewCapture).toHaveBeenCalledOnce());
    expect(startCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Start recording" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      reason: new Error("transcript_incomplete"),
      message: "The transcript could not be fully confirmed",
    },
    {
      reason: new Error("Save service is temporarily unavailable"),
      message: "Save service is temporarily unavailable",
    },
  ])(
    "shows a current Capture failure and keeps its confirmed text ($message)",
    ({ reason, message }) => {
      const value = voiceValue({
        transcriptItems: [
          {
            id: "speech",
            text: "Confirmed recording text",
            createdAtMs: 1,
          },
        ],
      });
      const ui = (state: VoiceControlContextValue) => (
        <VoiceControlContext.Provider value={state}>
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext.Provider>
      );
      const view = render(ui(value));
      view.rerender(
        ui({
          ...value,
          captureState: {
            status: "failed",
            capture: { ...capture(), status: "failed" },
            reason,
          },
        }),
      );
      expect(
        screen.getByRole("heading", { name: "Recording save failed" }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("log")).toHaveTextContent(
        "Confirmed recording text",
      );
      expect(screen.queryByText("Recording")).not.toBeInTheDocument();
    },
  );

  it("can abandon a terminal failed recording and start a new one", async () => {
    const startCapture = vi.fn(async () => undefined);
    const startNewCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: {
            status: "failed",
            capture: { ...capture(), status: "failed" },
            reason: new Error("materialization_failed"),
          },
          listenerStatus: "disabled",
          startCapture,
          startNewCapture,
        })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Start new recording" }),
    );

    await vi.waitFor(() => expect(startNewCapture).toHaveBeenCalledOnce());
    expect(startCapture).not.toHaveBeenCalled();
  });

  it("starts a new recording when re-entering after a terminal failure", async () => {
    const startCapture = vi.fn(async () => undefined);
    const startNewCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: {
            status: "failed",
            capture: { ...capture(), status: "failed" },
            reason: new Error("materialization_failed"),
          },
          listenerStatus: "disabled",
          startCapture,
          startNewCapture,
        })}
      >
        <VoiceFocusSurface autoStart onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );

    await vi.waitFor(() => expect(startNewCapture).toHaveBeenCalledOnce());
    expect(startCapture).not.toHaveBeenCalled();
  });

  it.each(["device_disconnected", "error", "disabled"] as const)(
    "can still save the recording after live input becomes %s",
    async (listenerStatus) => {
      const stopCapture = vi.fn(async () => undefined);
      render(
        <VoiceControlContext.Provider
          value={voiceValue({
            listenerStatus,
            stopCapture,
            captureState: {
              status: "recording",
              capture: capture(),
            },
          })}
        >
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext.Provider>,
      );
      const save = screen.getByRole("button", {
        name: /^(Stop|Close) recording$/,
      });
      expect(save).toBeEnabled();
      expect(
        screen.getByText("Recorded content can still be saved."),
      ).toBeVisible();
      clickStop();
      await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledOnce());
    },
  );

  it.each([
    {
      listenerStatus: "enabling" as const,
      transcriptStatus: "recovering" as const,
      captureSyncStatus: "recovering" as const,
      message: "Reconnecting microphone; audio delivery is not yet confirmed",
    },
    {
      listenerStatus: "listening" as const,
      transcriptStatus: "recovering" as const,
      captureSyncStatus: "recovering" as const,
      message:
        "Reconnecting transcript updates; saved text will sync after reconnection",
    },
    {
      listenerStatus: "listening" as const,
      transcriptStatus: "live" as const,
      captureSyncStatus: "recovering" as const,
      message: "Reconnecting recording status; waiting for server confirmation",
    },
  ])(
    "explains connection recovery without claiming audio delivery: $message",
    ({ message, ...state }) => {
      const recording = capture();
      const tree = (value: Partial<VoiceControlContextValue>) => (
        <VoiceControlContext.Provider
          value={voiceValue({
            ...value,
            captureState: { status: "recording", capture: recording },
          })}
        >
          <VoiceFocusSurface onExit={vi.fn()} />
        </VoiceControlContext.Provider>
      );
      // The connection was up before it dropped.
      const view = render(tree({ listenerStatus: "listening" }));
      view.rerender(tree(state));
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
      ).toBeEnabled();
    },
  );

  it("does not call the first microphone connection after Start a reconnection", () => {
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          listenerStatus: "enabling",
          captureState: { status: "starting", capture: capture() },
        })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    expect(
      screen.queryByText(/^Reconnecting microphone/),
    ).not.toBeInTheDocument();
  });

  it("keeps the Room during a failed Leave and exits once the recording stops", async () => {
    const stopCapture = vi
      .fn()
      .mockRejectedValueOnce(new Error("Recording stop request timed out"))
      .mockResolvedValue(undefined);
    const onExit = vi.fn();
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: { status: "recording", capture: capture() },
          listenerStatus: "enabling",
          stopCapture,
        })}
      >
        <VoiceFocusSurface onExit={onExit} />
      </VoiceControlContext.Provider>,
    );
    const leave = screen.getByRole("button", {
      name: /^(Stop|Close) recording$/,
    });
    clickStop();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Recording stop request timed out",
    );
    expect(onExit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(leave).toBeEnabled());
    clickStop();
    await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledTimes(2));
    expect(onExit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("pauses by muting and freezing the clock, then resumes the same recording", async () => {
    const setMicrophoneMuted = vi.fn(async () => undefined);
    const stopCapture = vi.fn(async () => undefined);
    render(
      <VoiceControlContext.Provider
        value={voiceValue({ setMicrophoneMuted, stopCapture })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resume recording" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(setMicrophoneMuted).toHaveBeenLastCalledWith(true);
    expect(screen.getByText("Recording paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pause recording" }),
      ).toBeInTheDocument(),
    );
    expect(setMicrophoneMuted).toHaveBeenLastCalledWith(false);
    expect(stopCapture).not.toHaveBeenCalled();
  });

  it("asks before stopping and keeps recording when the Human declines", () => {
    const stopCapture = vi.fn(async () => undefined);
    const onExit = vi.fn();
    render(
      <VoiceControlContext.Provider value={voiceValue({ stopCapture })}>
        <VoiceFocusSurface onExit={onExit} />
      </VoiceControlContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(
      screen.getByRole("alertdialog", { name: "Stop recording?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(stopCapture).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("presents the connected live state with partial and final transcript", () => {
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          partialTranscript: "Recognizing this sentence live",
          transcriptItems: [
            {
              createdAtMs: 1,
              endOffsetMs: 1_000,
              id: "final-1",
              startOffsetMs: 0,
              text: "Confirmed live transcript",
            },
          ],
        })}
      >
        <VoiceFocusSurface onExit={vi.fn()} />
      </VoiceControlContext.Provider>,
    );

    expect(
      screen.getByRole("region", { name: "Hardware voice focus" }),
    ).toBeVisible();
    expect(screen.getByText("Recording")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "I’m listening to the meeting..." }),
    ).toBeVisible();
    const transcript = screen.getByRole("log", {
      name: "Voice focus transcript",
    });
    expect(transcript).toHaveTextContent("Confirmed live transcript");
    expect(transcript).toHaveTextContent("Recognizing this sentence live");
  });

  it("shows saving until finalization completes and returns to Room on exit", async () => {
    const stopCapture = vi.fn(async () => undefined);
    const onExit = vi.fn();
    render(
      <VoiceControlContext.Provider
        value={voiceValue({
          captureState: {
            capture: { ...capture(), status: "finalizing" },
            status: "finalizing",
          },
          stopCapture,
        })}
      >
        <VoiceFocusSurface onExit={onExit} />
      </VoiceControlContext.Provider>,
    );

    expect(
      screen.getByRole("heading", { name: "Saving recording..." }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Generating recording and transcript files",
    );
    clickStop();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
    expect(stopCapture).not.toHaveBeenCalled();
  });

  describe("microphone permission while starting", () => {
    const allowAccess = "Allow microphone access in the browser to begin.";

    afterEach(() => {
      Reflect.deleteProperty(navigator, "permissions");
    });

    function renderArming() {
      render(
        <VoiceControlContext.Provider
          value={voiceValue({
            captureState: { status: "idle" },
            listenerStatus: "disabled",
            // Starting stays in flight so the surface remains arming.
            startCapture: vi.fn(() => new Promise<void>(() => undefined)),
          })}
        >
          <VoiceFocusSurface autoStart onExit={vi.fn()} />
        </VoiceControlContext.Provider>,
      );
    }

    it("does not ask for access while the permission check is pending", async () => {
      stubMicrophonePermission(new Promise(() => undefined));
      renderArming();
      expect(
        await screen.findByRole("heading", { name: "Starting recording…" }),
      ).toBeVisible();
      expect(screen.getByText("Connecting the microphone…")).toBeVisible();
      expect(screen.queryByText(allowAccess)).not.toBeInTheDocument();
    });

    it("does not ask for access once the browser has granted it", async () => {
      stubMicrophonePermission(Promise.resolve(permissionStatus("granted")));
      renderArming();
      expect(
        await screen.findByText("Connecting the microphone…"),
      ).toBeVisible();
      await act(async () => undefined);
      expect(screen.queryByText(allowAccess)).not.toBeInTheDocument();
    });

    it("asks for access while the browser still prompts, until it is granted", async () => {
      const status = permissionStatus("prompt");
      stubMicrophonePermission(Promise.resolve(status));
      renderArming();
      expect(await screen.findByText(allowAccess)).toBeVisible();
      act(() => status.grant());
      expect(screen.queryByText(allowAccess)).not.toBeInTheDocument();
      expect(screen.getByText("Connecting the microphone…")).toBeVisible();
    });

    it("asks for access when the browser has denied it", async () => {
      stubMicrophonePermission(Promise.resolve(permissionStatus("denied")));
      renderArming();
      expect(await screen.findByText(allowAccess)).toBeVisible();
    });
  });
});

function stubMicrophonePermission(result: Promise<PermissionStatus>) {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(() => result) },
  });
}

function permissionStatus(initial: PermissionState) {
  const target = new EventTarget();
  let state = initial;
  return Object.defineProperties(target, {
    grant: {
      value: () => {
        state = "granted";
        target.dispatchEvent(new Event("change"));
      },
    },
    state: { get: () => state },
  }) as unknown as PermissionStatus & { grant(): void };
}

const microphone = {
  deviceId: "microphone-1",
  groupId: "group-1",
  label: "Desk microphone",
};

function capture() {
  return {
    created_at: "2026-09-02T00:00:00Z",
    gap_count: 0,
    gap_duration_ms: 0,
    id: "capture-1",
    requested_start_offset_ms: 0,
    room_id: "room-1",
    status: "recording" as const,
    updated_at: "2026-09-02T00:00:00Z",
    voice_session_id: "voice-session-1",
  };
}

function pausedRecovery() {
  return {
    status: "recovering" as const,
    capture: {
      ...capture(),
      status: "recovering" as const,
      transcript_recovery_status: "failed" as const,
    },
  };
}

function voiceValue(
  overrides: Partial<VoiceControlContextValue> = {},
): VoiceControlContextValue {
  return {
    acquireComposerMicrophone: vi.fn(async () => async () => undefined),
    boundDevice: microphone,
    captureSyncStatus: "live",
    captureState: { status: "recording", capture: capture() },
    composerMicrophoneActive: false,
    connectDevice: vi.fn(async () => undefined),
    devices: [],
    discoverDevices: vi.fn(async () => []),
    disconnectDevice: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    listenerStatus: "listening",
    selectedDeviceId: "microphone-1",
    microphoneMuted: false,
    setMicrophoneMuted: vi.fn(async () => undefined),
    selectDevice: vi.fn(async () => undefined),
    startCapture: vi.fn(async () => undefined),
    startNewCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined),
    targetAgentName: "AnotherMe",
    transcriptItems: [],
    transcriptStatus: "live",
    ...overrides,
  };
}

/** Stops the recording, confirming in the window when it asks first. */
function clickStop() {
  fireEvent.click(
    screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
  );
  const confirm = screen.queryByRole("button", { name: "Stop & save" });
  if (confirm) fireEvent.click(confirm);
}
