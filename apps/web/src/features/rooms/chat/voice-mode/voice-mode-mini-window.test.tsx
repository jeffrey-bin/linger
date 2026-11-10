import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import VoiceModeMiniWindow, {
  clampPosition,
  sessionMessages,
} from "./voice-mode-mini-window";
import type { VoiceModeSession } from "./voice-mode-session";
import { openVoicePip, resetVoicePipForTest } from "./voice-pip";

const startedAt = "2026-10-02T03:00:00.000Z";
const message = (
  id: string,
  createdAt: string,
  author: object,
  text: string,
) => ({
  attachments: [],
  author,
  body: text,
  created_at: createdAt,
  id,
  message_kind: "conversation",
  raw_message: text,
  room_id: "room-voice",
  segments: [],
  tenant_id: "tenant-northstar",
});
const me = { display_name: "Jenny", id: "actor-me", kind: "human" };
const codex = { display_name: "Codex", id: "agent-codex", kind: "agent" };

vi.mock("../../room-queries", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  roomMessagesInfiniteQueryOptions: () => ({
    getNextPageParam: () => undefined,
    initialPageParam: undefined,
    queryFn: async () => ({
      items: [
        message("old", "2026-10-02T02:00:00.000Z", me, "Before voice"),
        message("q1", "2026-10-02T03:01:00.000Z", me, "What is next?"),
        message("a1", "2026-10-02T03:01:05.000Z", codex, "Ship the fix."),
      ],
    }),
    queryKey: ["mini-window-test", "messages"],
  }),
}));
vi.mock("../../runtime-status/use-room-run-statuses", () => ({
  useRoomRunStatusCollection: () => ({
    items: [{ agent: codex, id: "run-1", run_id: "run-1", status: "active" }],
  }),
}));
const voice = vi.hoisted(() => ({
  exit: vi.fn(),
  level: 0,
  retry: vi.fn(),
  session: undefined as VoiceModeSession | undefined,
  setMuted: vi.fn(async () => undefined),
  setSoundOff: vi.fn(),
}));
vi.mock("./voice-mode-session", () => ({
  useOptionalVoiceModeSession: () => voice,
  useVoiceModeLevel: () => voice.level,
}));

beforeEach(() => {
  voice.exit.mockReset();
  voice.level = 0;
  voice.session = {
    closing: false,
    entered: true,
    muted: false,
    prefix: { body: "", documentReferences: [], mentions: [] },
    sourceId: "source-1",
    startedAt,
    state: {
      flushing: false,
      microphoneActive: true,
      sending: false,
      status: "listening",
      text: "and the tests",
    },
    target: {
      accountId: "account-1",
      roomId: "room-voice",
      roomName: "Codex",
      tenantId: "tenant-northstar",
    },
  };
});

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderWindow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <MemoryRouter
          initialEntries={["/t/tenant-northstar/rooms/room-other/chat"]}
        >
          <VoiceModeMiniWindow currentActorId="actor-me" />
          <LocationProbe />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

/** A stand-in for the browser's picture-in-picture window. */
function installFakeVoicePip() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    // A closed window is gone; the next request opens a fresh one.
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const requestWindow = vi.fn(async () => pipWindow as unknown as Window);
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow },
  });
  return { document, frame, pipWindow, requestWindow };
}

describe("Voice Mode mini window", () => {
  it("shows this session's turns, replies, and live words in order", async () => {
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    expect(await within(log).findByText("What is next?")).toBeInTheDocument();
    expect(within(log).getByText("Ship the fix.")).toBeInTheDocument();
    expect(within(log).getByText("Working…")).toBeInTheDocument();
    expect(within(log).getByText("and the tests")).toBeInTheDocument();
    expect(within(log).queryByText("Before voice")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Voice Mode window" }),
    ).toHaveTextContent("Codex");
  });

  it("shows the live reply and turns its sound off apart from the microphone", async () => {
    voice.session!.live = {
      soundOff: false,
      transcript: [
        { id: "lt_1", speaker: "you", text: "When is the meeting tomorrow" },
        {
          id: "lt_1:reply",
          speaker: "live",
          text: "Tomorrow, after review.",
          pending: true,
        },
      ],
    };
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    expect(
      within(log).getByText("Tomorrow, after review."),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Turn reply sound off from the voice window",
      }),
    );
    expect(voice.setSoundOff).toHaveBeenCalledWith(true);
    expect(voice.setMuted).not.toHaveBeenCalled();
  });

  it("shows a live call as it was said, with words still being said last", async () => {
    voice.session!.state = {
      ...voice.session!.state,
      text: "Scroll down a bit\nthen",
      heardText: "Scroll down a bit",
      speakingText: "then",
    };
    voice.session!.live = {
      soundOff: true,
      transcript: [
        { id: "lt_1", speaker: "you", text: "Scroll down a bit" },
        { id: "lt_1:reply", speaker: "live", text: "Sure, scrolling for you." },
        {
          id: "m-9",
          speaker: "live",
          text: "The weekly report is in the chat",
        },
      ],
    };
    renderWindow();
    const log = await screen.findByRole("log", {
      name: "Voice Mode conversation",
    });
    const order = [
      "Scroll down a bit",
      "Sure, scrolling for you.",
      "The weekly report is in the chat",
      "then",
    ].map((text) => within(log).getByText(text));
    for (const [index, bubble] of order.slice(1).entries())
      expect(
        order[index]!.compareDocumentPosition(bubble) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    // Said once: neither the saved Messages nor the queued words repeat it.
    expect(within(log).getAllByText("Scroll down a bit")).toHaveLength(1);
    expect(within(log).queryByText("What is next?")).toBeNull();
    expect(within(log).queryByText("Ship the fix.")).toBeNull();
    expect(within(log).queryByText("Working…")).toBeNull();
    expect(within(log).queryByText("Codex")).toBeNull();
    expect(within(log).getAllByText("Reply")).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "Turn reply sound on from the voice window",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("retries a failed turn from the window", () => {
    voice.session!.state = { ...voice.session!.state, canRetry: true };
    renderWindow();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry voice message from the voice window",
      }),
    );
    expect(voice.retry).toHaveBeenCalledOnce();
  });

  it("shows Another Me beating while listening and turning while speaking", () => {
    voice.level = 0.5;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).toHaveAttribute("data-listening");
    expect(avatar).toHaveAttribute("data-speaking");
    expect(avatar.querySelector("[role='img'], img")).not.toBeNull();
  });

  it("rests the avatar while muted", () => {
    voice.level = 0.5;
    voice.session!.muted = true;
    renderWindow();
    const avatar = document.querySelector("[data-voice-avatar]")!;
    expect(avatar).not.toHaveAttribute("data-listening");
    expect(avatar).not.toHaveAttribute("data-speaking");
  });

  it("expands and shrinks the window", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    expect(panel).toHaveStyle({ width: "320px" });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Voice Mode window" }),
    );
    expect(panel).toHaveStyle({ width: "560px" });
    fireEvent.click(
      screen.getByRole("button", { name: "Shrink Voice Mode window" }),
    );
    expect(panel).toHaveStyle({ width: "320px" });
  });

  it("floats over other windows as the one Voice Mode window", async () => {
    const fake = installFakeVoicePip();
    try {
      renderWindow();
      await act(() => openVoicePip("voice-mode"));
      const floating = within(fake.document.body);
      await floating.findByRole("region", { name: "Voice Mode window" });
      expect(
        screen.queryByRole("region", { name: "Voice Mode window" }),
      ).not.toBeInTheDocument();
      // The desktop sizes, places, and closes that window, so it shows no
      // size or close button of its own.
      expect(
        floating.queryByRole("button", { name: "Expand Voice Mode window" }),
      ).not.toBeInTheDocument();
      expect(
        floating.queryByRole("button", { name: "End Voice Mode" }),
      ).not.toBeInTheDocument();

      // The desktop's close button ends Voice Mode instead of leaving a
      // second window behind in the page.
      act(() => fake.pipWindow.close());
      expect(voice.exit).toHaveBeenCalledOnce();
    } finally {
      fake.frame.remove();
      Reflect.deleteProperty(window, "documentPictureInPicture");
      resetVoicePipForTest();
    }
  });

  it("drags from anywhere on the header, including the title", () => {
    renderWindow();
    const panel = screen.getByRole("region", { name: "Voice Mode window" });
    const title = screen.getByTitle("Open this conversation");
    const before = Number.parseFloat(panel.style.top);
    fireEvent.pointerDown(title, { button: 0, clientX: 600, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
    expect(Number.parseFloat(panel.style.top)).toBe(before + 200);
    // Releasing a drag on the title must not also open the Room.
    fireEvent.click(title);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/rooms/room-other/chat",
    );
    fireEvent.click(title);
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/rooms/room-voice/chat",
    );
  });

  it("opens compact every time, even after it was expanded", () => {
    const first = renderWindow();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Voice Mode window" }),
    );
    first.unmount();
    renderWindow();
    expect(
      screen.getByRole("region", { name: "Voice Mode window" }),
    ).toHaveStyle({ width: "320px" });
  });

  it("names its controls apart from the Room composer's", () => {
    voice.session!.state = { ...voice.session!.state, canRetry: true };
    renderWindow();
    expect(
      screen.getByRole("button", { name: "Mute Voice Mode" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mute microphone" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Retry voice message$/ }),
    ).toBeNull();
    // Voice Mode takes no screenshots.
    expect(screen.queryByRole("button", { name: /screenshot/i })).toBeNull();
  });

  it("ends Voice Mode from its close button", () => {
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "End Voice Mode" }));
    expect(voice.exit).toHaveBeenCalledOnce();
  });

  it("leaves at once when Voice Mode ends, while the session drains", () => {
    voice.session!.closing = true;
    renderWindow();
    expect(
      screen.queryByRole("region", { name: "Voice Mode window" }),
    ).toBeNull();
  });

  it("filters to conversation Messages since the session started", () => {
    const items = [
      message("b", "2026-10-02T03:02:00.000Z", codex, "second"),
      message("a", "2026-10-02T03:01:00.000Z", me, "first"),
      {
        ...message("s", "2026-10-02T03:03:00.000Z", codex, "status"),
        message_kind: "agent_status",
      },
      message("o", "2026-10-02T02:59:59.000Z", me, "earlier"),
    ] as unknown as Parameters<typeof sessionMessages>[0];
    expect(sessionMessages(items, startedAt).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps a dragged window inside the viewport", () => {
    expect(clampPosition({ left: -500, top: -500 })).toEqual({
      left: 16,
      top: 16,
    });
    const far = clampPosition({ left: 99_999, top: 99_999 });
    expect(far.left).toBe(window.innerWidth - 320 - 16);
    expect(far.top).toBe(window.innerHeight - 120);
  });
});
