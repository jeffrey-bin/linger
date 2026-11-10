import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceCaptureQuestion } from "@/features/teamhub/teamhub-types";
import {
  openVoicePip,
  resetVoicePipForTest,
} from "../chat/voice-mode/voice-pip";
import RecordingWindow, { pinchedPlacement } from "./recording-window";
import {
  openRecordingWindow,
  resetRecordingWindowForTest,
  useRecordingWindow,
} from "./recording-window-store";
import {
  VoiceControlContext,
  type VoiceControlContextValue,
} from "./voice-control-context";

const capture = {
  created_at: "2026-10-12T02:00:00Z",
  gap_count: 0,
  gap_duration_ms: 0,
  id: "capture-1",
  requested_start_offset_ms: 60_000,
  room_id: "room-1",
  status: "recording" as const,
  updated_at: "2026-10-12T02:00:00Z",
  voice_session_id: "voice-session-1",
};

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function voiceValue(
  overrides: Partial<VoiceControlContextValue> = {},
): VoiceControlContextValue {
  return {
    acquireComposerMicrophone: vi.fn(async () => async () => undefined),
    boundDevice: { deviceId: "mic", groupId: "group", label: "Mic" },
    captureSyncStatus: "live",
    captureState: { status: "recording", capture },
    composerMicrophoneActive: false,
    connectDevice: vi.fn(async () => undefined),
    devices: [],
    discoverDevices: vi.fn(async () => []),
    disconnectDevice: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    leavePage: vi.fn(async () => undefined),
    listenerStatus: "listening",
    selectedDeviceId: "mic",
    microphoneMuted: false,
    setMicrophoneMuted: vi.fn(async () => undefined),
    selectDevice: vi.fn(async () => undefined),
    startCapture: vi.fn(async () => undefined),
    startNewCapture: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined),
    targetAgentName: "Another Me",
    transcriptItems: [],
    transcriptStatus: "live",
    ...overrides,
  };
}

function api() {
  const base = createTestTeamHubRuntime();
  const asked: TeamHubVoiceCaptureQuestion[] = [];
  const routes = {
    sendVoiceCaptureQuestionTask: vi.fn(
      async (_id: string, questionId: string) => {
        const request = asked.find((each) => each.id === questionId)!;
        request.sent_message_id = "message-2";
        return structuredClone(request);
      },
    ),
    listVoiceCaptureQuestions: vi.fn(async () => ({
      items: structuredClone(asked),
    })),
    askVoiceCaptureQuestion: vi.fn(
      async (
        _id: string,
        question: string,
      ): Promise<TeamHubVoiceCaptureQuestion> => {
        // The recording's Agent hears "Help me…" as a request for Another Me.
        if (question.startsWith("Help me")) {
          const request: TeamHubVoiceCaptureQuestion = {
            id: `q${asked.length + 1}`,
            kind: "task",
            question,
            answer: "",
            answered: true,
            task_title: "Draft the pricing email",
            cutoff_offset_ms: 185_000,
            sources: [],
            created_at: "2026-10-12T02:03:00Z",
          };
          asked.push(request);
          return structuredClone(request);
        }
        const answer: TeamHubVoiceCaptureQuestion = {
          id: `q${asked.length + 1}`,
          kind: "answer",
          question,
          answer: "Budget is 200k.",
          answered: true,
          cutoff_offset_ms: 185_000,
          sources: [
            {
              start_offset_ms: 125_000,
              end_offset_ms: 130_000,
              text: "We settle on 200k.",
            },
          ],
          created_at: "2026-10-12T02:03:00Z",
        };
        asked.push(answer);
        return answer;
      },
    ),
  };
  base.server
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/questions/{questionId}/task",
      ({ params }) =>
        routes.sendVoiceCaptureQuestionTask(
          params.captureSessionId!,
          params.questionId!,
        ),
    )
    .on("GET", "/v0/voice-captures/{captureSessionId}/questions", () =>
      routes.listVoiceCaptureQuestions(),
    )
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/questions",
      ({ params, body }) =>
        routes.askVoiceCaptureQuestion(
          params.captureSessionId!,
          (body as { question: string }).question,
        ),
    );
  return { runtime: base, routes };
}

function WindowState() {
  const state = useRecordingWindow();
  return (
    <span data-testid="window-state">
      {state.open ? (state.minimized ? "minimized" : "open") : "closed"}
      {state.autoStart ? ":autostart" : ""}
      {state.ending ? ":ending" : ""}
    </span>
  );
}

function renderWindow(
  voice: VoiceControlContextValue,
  { tenantId }: { tenantId?: string } = {},
) {
  const { runtime, routes } = api();
  const queryClient = new QueryClient();
  const content = (value: VoiceControlContextValue) => (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceControlContext value={value}>
          <RecordingWindow />
          <WindowState />
        </VoiceControlContext>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  // Inside a tenant route the window can link a created Task.
  const tree = (value: VoiceControlContextValue) =>
    tenantId ? (
      <MemoryRouter initialEntries={[`/t/${tenantId}/rooms/room-1/chat`]}>
        <Routes>
          <Route element={content(value)} path="/t/:tenantId/*" />
        </Routes>
      </MemoryRouter>
    ) : (
      content(value)
    );
  const view = render(tree(voice));
  return {
    routes,
    rerender: (value: VoiceControlContextValue) => view.rerender(tree(value)),
  };
}

beforeEach(() => {
  resetRecordingWindowForTest();
  resetVoicePipForTest();
  openRecordingWindow();
});
afterEach(() => {
  Reflect.deleteProperty(window, "documentPictureInPicture");
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

function askInWindow(text: string) {
  const box = screen.getByRole("textbox", {
    name: "Ask about this recording",
  });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("Recording window", () => {
  it("does not retry a failed question from the previous recording", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    routes.askVoiceCaptureQuestion.mockRejectedValueOnce(new Error("offline"));
    const ask = screen.getByRole("textbox", {
      name: "Ask about this recording",
    });
    fireEvent.change(ask, { target: { value: "Only recording A?" } });
    fireEvent.keyDown(ask, { key: "Enter" });
    await screen.findByRole("button", { name: "Retry" });
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Only recording A?")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      {
        target: { value: "Only recording B?" },
      },
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(routes.askVoiceCaptureQuestion).toHaveBeenLastCalledWith(
        "capture-2",
        "Only recording B?",
      ),
    );
  });

  it.each(["success", "failure"] as const)(
    "keeps the current question pending after a late %s from another recording",
    async (outcome) => {
      const { routes, rerender } = renderWindow(voiceValue());
      const old = pending<TeamHubVoiceCaptureQuestion>();
      const current = pending<TeamHubVoiceCaptureQuestion>();
      routes.askVoiceCaptureQuestion
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const ask = () =>
        screen.getByRole("textbox", { name: "Ask about this recording" });
      fireEvent.change(ask(), { target: { value: "Only A?" } });
      fireEvent.keyDown(ask(), { key: "Enter" });
      rerender(
        voiceValue({
          captureState: {
            status: "recording",
            capture: { ...capture, id: "capture-2" },
          },
        }),
      );
      fireEvent.change(ask(), { target: { value: "Only B?" } });
      fireEvent.keyDown(ask(), { key: "Enter" });
      await waitFor(() =>
        expect(routes.askVoiceCaptureQuestion).toHaveBeenCalledTimes(2),
      );
      const answer = (question: string): TeamHubVoiceCaptureQuestion => ({
        id: question,
        kind: "answer",
        question,
        answer: "Recorded answer",
        answered: true,
        cutoff_offset_ms: 185_000,
        sources: [],
        created_at: capture.created_at,
      });
      await act(async () => {
        if (outcome === "success") old.resolve(answer("Only A?"));
        else old.reject(new Error("offline"));
      });
      expect(screen.getByText("Only B?")).toBeVisible();
      expect(screen.getByText("Answering…")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await act(async () => current.resolve(answer("Only B?")));
      expect(screen.queryByText("Answering…")).toBeNull();
      expect(routes.askVoiceCaptureQuestion.mock.calls).toEqual([
        ["capture-1", "Only A?"],
        ["capture-2", "Only B?"],
      ]);
    },
  );

  it("keeps an unsent question draft inside its recording", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    fireEvent.change(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
      {
        target: { value: "Question draft A" },
      },
    );
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
    ).toHaveValue("");
    expect(routes.askVoiceCaptureQuestion).not.toHaveBeenCalled();
  });

  it("keeps one microphone start when its new Capture identity arrives", async () => {
    openRecordingWindow({ autoStart: true });
    const start = pending<void>();
    const voice = voiceValue({
      captureState: { status: "idle" },
      startCapture: vi.fn(() => start.promise),
    });
    const { rerender } = renderWindow(voice);
    await waitFor(() => expect(voice.startCapture).toHaveBeenCalledTimes(1));
    rerender({ ...voice, captureState: { status: "starting", capture } });
    await act(async () => start.resolve());
    rerender({ ...voice, captureState: { status: "recording", capture } });
    expect(voice.startCapture).toHaveBeenCalledTimes(1);
    expect(voice.startNewCapture).not.toHaveBeenCalled();
    expect(voice.leavePage).not.toHaveBeenCalled();
    expect(voice.stopCapture).not.toHaveBeenCalled();
  });

  it("opens on the full transcript with the question box below", () => {
    renderWindow(voiceValue());
    // Notes are gone: only the transcript and Ask remain, and no full screen.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Transcript",
      "Ask",
    ]);
    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("log", { name: "Voice focus transcript" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Ask about this recording" }),
    ).toBeInTheDocument();
    // Tasks are sent from any chat while the window floats; it has no task button.
    expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
  });

  it("answers a question from the meeting and shows it under Ask", async () => {
    const { routes } = renderWindow(voiceValue());
    const ask = screen.getByRole("textbox", {
      name: "Ask about this recording",
    });
    fireEvent.change(ask, { target: { value: "How was the budget settled?" } });
    fireEvent.keyDown(ask, { key: "Enter" });
    expect(screen.getByRole("tab", { name: "Ask" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const answers = screen.getByRole("list", {
      name: "Answers about this recording",
    });
    expect(await within(answers).findByText("Budget is 200k.")).toBeVisible();
    expect(routes.askVoiceCaptureQuestion).toHaveBeenCalledWith(
      "capture-1",
      "How was the budget settled?",
    );
    // Session offsets are shown from the start of this recording.
    expect(
      within(answers).getByText("Based on the recording up to 02:05"),
    ).toBeVisible();
    // Answers read cleanly, without source quotes.
    expect(within(answers).queryByText(/We settle on 200k/)).toBeNull();
  });

  // The request shows in its bubble and again as the Task card's goal.
  function requestRow(text: string) {
    return screen.getAllByText(text)[0]!.closest("li")!;
  }

  function node(row: HTMLElement) {
    return row.querySelector("[data-node]")!.getAttribute("data-node");
  }

  it("hands a recognized request to Another Me and turns its spinner into a check", async () => {
    const { routes } = renderWindow(voiceValue(), { tenantId: "tenant-1" });
    // Holds the server's reply until the spinner has been seen.
    const gate = pending<void>();
    const createTask =
      routes.sendVoiceCaptureQuestionTask.getMockImplementation()!;
    routes.sendVoiceCaptureQuestionTask.mockImplementationOnce(
      async (captureId, questionId) => {
        await gate.promise;
        return createTask(captureId, questionId);
      },
    );
    askInWindow("Help me write the prices into an email to Lena");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledWith(
        "capture-1",
        "q1",
      ),
    );
    const row = requestRow("Help me write the prices into an email to Lena");
    // No answer text: the request shows as being handed over.
    expect(node(row)).toBe("sending");
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Sending to Another Me…",
    );
    expect(within(row).queryByText(/Based on the recording/)).toBeNull();
    await act(async () => gate.resolve());
    expect(node(row)).toBe("sent");
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Sent to Another Me",
    );
    // Another Me decides on the Task; Ask shows no Task card or link.
    expect(within(row).queryByRole("article")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
    // It stays sent across tabs.
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }));
    fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
    expect(
      node(requestRow("Help me write the prices into an email to Lena")),
    ).toBe("sent");
    expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledOnce();
  });

  it("keeps the new recording task sending when the previous recording task fails late", async () => {
    const { routes, rerender } = renderWindow(voiceValue());
    const old = pending<void>();
    const current = pending<void>();
    const createTask =
      routes.sendVoiceCaptureQuestionTask.getMockImplementation()!;
    routes.sendVoiceCaptureQuestionTask
      .mockImplementationOnce(async () => {
        await old.promise;
        throw new Error("old request failed");
      })
      .mockImplementationOnce(async (captureId, questionId) => {
        await current.promise;
        return createTask(captureId, questionId);
      });
    askInWindow("Help me handle recording A's task");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(1),
    );
    rerender(
      voiceValue({
        captureState: {
          status: "recording",
          capture: { ...capture, id: "capture-2" },
        },
      }),
    );
    askInWindow("Help me handle recording B's task");
    await waitFor(() =>
      expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(2),
    );
    expect(node(requestRow("Help me handle recording B's task"))).toBe(
      "sending",
    );
    await act(async () => old.resolve());
    expect(node(requestRow("Help me handle recording B's task"))).toBe(
      "sending",
    );
    await act(async () => current.resolve());
    expect(node(requestRow("Help me handle recording B's task"))).toBe("sent");
  });

  it("shows a failed task on a red node and retries it", async () => {
    const { routes } = renderWindow(voiceValue());
    routes.sendVoiceCaptureQuestionTask.mockRejectedValueOnce(
      new Error("offline"),
    );
    askInWindow("Help me remind Kai to send the quote after the meeting");
    const row = await waitFor(() => {
      const found = requestRow(
        "Help me remind Kai to send the quote after the meeting",
      );
      expect(node(found)).toBe("failed");
      return found;
    });
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Not sent · Retry",
    );
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(node(row)).toBe("sent"));
    expect(routes.sendVoiceCaptureQuestionTask).toHaveBeenCalledTimes(2);
  });

  it("minimizes to its top row and keeps recording until Stop", async () => {
    const voice = voiceValue();
    renderWindow(voice);
    fireEvent.click(screen.getByRole("button", { name: "Minimize recording" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByLabelText("Recording duration")).toBeVisible();
    expect(voice.leavePage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open recording" }));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    clickStop();
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    // Saving continues in the background; the sidebar shows its progress.
    expect(screen.getByTestId("window-state")).toHaveTextContent("closed");
  });

  it("floats over other apps, and closing it minimized ends the recording", async () => {
    const { frame, pipWindow } = stubPictureInPicture();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    const floating = within(frame.contentDocument!.body);
    expect(
      await floating.findByRole("region", { name: "Recording window" }),
    ).toBeInTheDocument();
    // Minimizing from inside the floating window shrinks it to its top row.
    fireEvent.click(
      floating.getByRole("button", { name: "Minimize recording" }),
    );
    expect(pipWindow.resizeBy).toHaveBeenCalledWith(0, 104 - 720);

    act(() => pipWindow.close());
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("ends the recording when the open floating window is closed", async () => {
    const { frame, pipWindow } = stubPictureInPicture();
    const voice = voiceValue();
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    expect(
      within(frame.contentDocument!.body).getByRole("tab", { name: "Ask" }),
    ).toBeInTheDocument();

    act(() => pipWindow.close());
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("does not show the window in the page while the closed one stops", async () => {
    const { pipWindow } = stubPictureInPicture();
    let finishStop = () => {};
    const voice = voiceValue({
      leavePage: vi.fn(
        () => new Promise<void>((resolve) => (finishStop = resolve)),
      ),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    expect(voice.leavePage).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Recording duration")).toBeNull();
    await act(async () => finishStop());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("spends autoStart once recording is underway", async () => {
    resetRecordingWindowForTest();
    openRecordingWindow({ autoStart: true });
    renderWindow(voiceValue());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("open"),
    );
    expect(screen.getByTestId("window-state")).not.toHaveTextContent(
      "autostart",
    );
  });

  it("marks the window ending the moment the floating window closes", async () => {
    const { pipWindow } = stubPictureInPicture();
    let finishStop = () => {};
    const voice = voiceValue({
      leavePage: vi.fn(
        () => new Promise<void>((resolve) => (finishStop = resolve)),
      ),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    expect(screen.getByTestId("window-state")).toHaveTextContent("ending");
    expect(
      screen.queryByRole("region", { name: "Recording window" }),
    ).toBeNull();
    await act(async () => finishStop());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("closed"),
    );
  });

  it("keeps recording in the page when stopping after the close fails", async () => {
    const { pipWindow } = stubPictureInPicture();
    const voice = voiceValue({
      leavePage: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });
    renderWindow(voice);
    await act(() => openVoicePip("recording"));
    act(() => pipWindow.close());
    await waitFor(() => expect(voice.leavePage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId("window-state")).toHaveTextContent("minimized"),
    );
    expect(
      screen.getByRole("region", { name: "Recording window" }),
    ).toBeVisible();
  });
});

function stubPictureInPicture() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document: frame.contentDocument!,
    innerHeight: 720,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
    resizeBy: vi.fn(),
  };
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow: vi.fn(async () => pipWindow) },
  });
  return { frame, pipWindow };
}

describe("Recording window placement", () => {
  it("stays at the top right of a pinch-zoomed view at its usual size", () => {
    // Zoomed 2×, looking at the part of the page from (300, 200).
    expect(
      pinchedPlacement({ left: 300, top: 200, width: 720, scale: 2 }),
    ).toMatchObject({
      left: 300 + 720 - (420 + 16) / 2,
      top: 200 + 64 / 2,
      transform: "scale(0.5)",
    });
  });
});

/** Stops the recording, confirming in the window when it asks first. */
function clickStop() {
  fireEvent.click(
    screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
  );
  const confirm = screen.queryByRole("button", { name: "Stop & save" });
  if (confirm) fireEvent.click(confirm);
}
