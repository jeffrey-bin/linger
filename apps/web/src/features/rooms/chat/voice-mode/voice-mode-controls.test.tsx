import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import { VoiceModeControls, type VoiceModeTarget } from "./voice-mode-controls";
import type { VoiceModePresentation } from "./voice-mode-presentation";
import {
  useOptionalVoiceModeSession,
  VoiceModeSessionProvider,
} from "./voice-mode-session";
import type {
  VoiceModeEvent,
  VoiceModeMicrophone,
} from "./voice-mode-controller";

const transport = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: VoiceModeEvent) => void),
  commit: vi.fn<() => Promise<void>>(async () => undefined),
  close: vi.fn<() => Promise<void>>(async () => undefined),
  open: vi.fn(),
  microphone: undefined as
    | undefined
    | ((microphone: VoiceModeMicrophone | undefined) => void),
  level: undefined as undefined | ((level: number) => void),
  setMuted: vi.fn<(muted: boolean) => Promise<void>>(async () => undefined),
}));
const pip = vi.hoisted(() => ({
  close: vi.fn(),
  open: vi.fn(async () => undefined),
}));
vi.mock("./voice-pip", () => ({
  closeVoicePip: pip.close,
  openVoicePip: pip.open,
}));
vi.mock("./voice-mode-transport", () => ({
  openVoiceMode: async (input: {
    receive: (event: VoiceModeEvent) => void;
    microphone: (microphone: VoiceModeMicrophone | undefined) => void;
    level: (level: number) => void;
  }) => {
    transport.receive = input.receive;
    transport.microphone = input.microphone;
    transport.level = input.level;
    await transport.open();
    return {
      commit: transport.commit,
      close: transport.close,
      setMuted: transport.setMuted,
    };
  },
}));

interface BoundControlsProps {
  target: VoiceModeTarget;
  disabled: boolean;
  empty: boolean;
  onChange: (presentation: VoiceModePresentation) => void;
  onSend: (text: string, eventId: string) => Promise<void> | void;
  prepareSend?: (text: string, eventId: string) => () => Promise<void>;
}

/** Binds a Room's turn callbacks and voice policy, as the composer does. */
function BoundControls(props: BoundControlsProps) {
  const voice = useOptionalVoiceModeSession()!;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const { bind } = voice;
  const { roomId } = props.target;
  useEffect(
    () =>
      bind(roomId, {
        onChange: (next) => latest.current.onChange(next),
        prepareSend: (text, eventId) =>
          latest.current.prepareSend?.(text, eventId) ??
          (async () => latest.current.onSend(text, eventId)),
      }),
    [bind, roomId],
  );
  const policy = useVoiceMediaPolicy(props.target.tenantId);
  return (
    <VoiceModeControls
      target={props.target}
      disabled={props.disabled}
      empty={props.empty}
      prefix={{ body: "", documentReferences: [], mentions: [] }}
      policy={policy}
    />
  );
}

function SessionConsumer({ onCommit }: { onCommit: () => void }) {
  useOptionalVoiceModeSession();
  // No dependency list: this runs after every commit of a session consumer.
  useEffect(() => onCommit());
  return null;
}

afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.clearAllMocks();
});

describe("Voice Mode controls", () => {
  it("projects connecting, listening and finishing states without delaying the transcript", async () => {
    let connected!: () => void;
    transport.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    );
    const runtime = createTestTeamHubRuntime();
    const onChange = vi.fn();
    const sessionRender = vi.fn();
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls
            target={{ tenantId: "tenant-northstar", roomId: "room-another-me" }}
            empty
            disabled={false}
            onChange={onChange}
            onSend={vi.fn()}
          />
          <SessionConsumer onCommit={sessionRender} />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start Voice Mode" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Voice Mode" }));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    const connecting = screen.getByRole("status");
    expect(connecting).toHaveTextContent("Connecting microphone…");
    expect(connecting).toHaveClass("sr-only");
    const wave = screen
      .getByRole("group", { name: "Voice Mode controls" })
      .querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(wave).not.toBeNull();
    expect(wave.style.getPropertyValue("--voice-level")).toBe("0");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "connecting",
        sending: false,
        flushing: false,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Mute microphone" }),
    ).toBeDisabled();
    act(() => transport.microphone?.({ setMuted: transport.setMuted }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting transcription…",
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "connecting", microphoneActive: true }),
    );
    const rendersBeforeLevel = sessionRender.mock.calls.length;
    act(() => transport.level?.(0.6));
    // The level redraws the meter only, not every session consumer.
    expect(sessionRender).toHaveBeenCalledTimes(rendersBeforeLevel);
    // Quiet speech is lifted: the bar shows the square root of the level.
    expect(Number(wave.style.getPropertyValue("--voice-level"))).toBeCloseTo(
      Math.sqrt(0.6),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    await waitFor(() => expect(transport.setMuted).toHaveBeenCalledWith(true));
    expect(wave.style.getPropertyValue("--voice-level")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    await waitFor(() => expect(transport.setMuted).toHaveBeenCalledWith(false));
    await act(async () => connected());
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "listening" }),
    );
    act(() =>
      transport.receive?.({
        kind: "partial",
        text: "Confirming this sentence",
        endOffsetMs: 100,
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Confirming this sentence",
        status: "listening",
      }),
    );
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    const micGlyph = mute.querySelector("svg")?.innerHTML;
    expect(micGlyph).toBeTruthy();
    fireEvent.click(mute);
    await waitFor(() => expect(transport.setMuted).toHaveBeenCalledWith(true));
    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveAttribute("aria-pressed", "true");
    const mutedGlyph = unmute.querySelector("svg")?.innerHTML;
    expect(mutedGlyph).toBeTruthy();
    expect(mutedGlyph).not.toBe(micGlyph);
  });

  it("prepares a send when a turn arrives and projects its real sending state", async () => {
    const runtime = createTestTeamHubRuntime();
    const onChange = vi.fn();
    const onSend = vi.fn();
    let delivered!: () => void;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          delivered = resolve;
        }),
    );
    const prepareSend = vi.fn(() => dispatch);
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls
            target={{ tenantId: "tenant-northstar", roomId: "room-another-me" }}
            empty
            disabled={false}
            onChange={onChange}
            onSend={onSend}
            prepareSend={prepareSend}
          />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start Voice Mode" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Voice Mode" }));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    act(() =>
      transport.receive?.({
        kind: "turn",
        id: "turn-with-context",
        text: "Use these materials",
        endOffsetMs: 100,
      }),
    );
    expect(prepareSend).toHaveBeenCalledExactlyOnceWith(
      "Use these materials",
      "turn-with-context",
    );
    // Every turn is first matched against the Voice Mode commands.
    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sending: true, status: "listening" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sending message");
    // The bar reads "Voice input" and dims while the finished turn settles.
    const bar = screen.getByRole("group", { name: "Voice Mode controls" });
    expect(bar).toHaveTextContent("Voice input");
    expect(bar).toHaveAttribute("data-settling", "true");
    expect(
      screen.getByRole("button", { name: "Exit Voice Mode" }),
    ).toBeEnabled();
    await act(async () => delivered());
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sending: false }),
    );
    expect(bar).not.toHaveAttribute("data-settling");
  });
  it("sends every dictation turn as an ordinary Message, even one that sounds like a command", async () => {
    const runtime = createTestTeamHubRuntime();
    const dispatch = vi.fn(async () => undefined);
    const prepareSend = vi.fn(() => dispatch);
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls
            target={{ tenantId: "tenant-northstar", roomId: "room-another-me" }}
            empty
            disabled={false}
            onChange={vi.fn()}
            onSend={vi.fn()}
            prepareSend={prepareSend}
          />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start Voice Mode" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start Voice Mode" }));
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    act(() =>
      transport.receive?.({
        kind: "turn",
        id: "turn-1",
        text: "That is all, turn off voice",
        endOffsetMs: 100,
      }),
    );

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(prepareSend).toHaveBeenCalledWith(
      "That is all, turn off voice",
      "turn-1",
    );
    expect(transport.close).not.toHaveBeenCalled();
  });
  it("exits immediately but keeps Voice Mode disabled until its microphone lease is released", async () => {
    const runtime = createTestTeamHubRuntime();
    const onChange = vi.fn();
    const onSend = vi.fn(async () => undefined);
    const props = {
      target: { tenantId: "tenant-northstar", roomId: "room-another-me" },
      disabled: false,
      empty: true,
      onChange,
      onSend,
    };
    const view = render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls {...props} />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start Voice Mode" }),
      ).toBeEnabled(),
    );
    expect(transport.open).not.toHaveBeenCalled();
    pip.open.mockClear();
    pip.close.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Start Voice Mode" }));
    // The floating window may only open inside the starting click.
    expect(pip.open).toHaveBeenCalledOnce();
    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
    act(() =>
      transport.receive?.({
        kind: "partial",
        text: "unsent draft",
        endOffsetMs: 100,
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ entered: true, text: "unsent draft" }),
    );
    expect(
      screen.queryByRole("button", { name: "Resume Voice Mode" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls {...props} onSend={async () => undefined} />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    expect(transport.open).toHaveBeenCalledOnce();
    let releaseClose!: () => void;
    transport.close.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseClose = resolve)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Exit Voice Mode" }));
    expect(pip.close).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("group", { name: "Voice Mode controls" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start Voice Mode" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Finishing Voice Mode" }),
    ).toBeDisabled();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ entered: false, status: "closing" }),
    );
    await act(async () => releaseClose());
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Start Voice Mode" }),
      ).toBeVisible();
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ entered: false, text: "unsent draft" }),
      );
    });
    expect(
      screen.queryByRole("group", { name: "Voice Mode controls" }),
    ).toBeNull();
    expect(transport.close).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows no entry when the deployment has no voice media", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/voice-media-policy",
      () => ({
        voice_media_supported: false,
      }),
    );
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <VoiceModeSessionProvider>
          <BoundControls
            target={{ tenantId: "tenant-northstar", roomId: "room-another-me" }}
            disabled={false}
            empty
            onChange={vi.fn()}
            onSend={vi.fn()}
          />
        </VoiceModeSessionProvider>
      </TeamHubRuntimeProvider>,
    );
    await act(async () => undefined);
    expect(
      screen.queryByRole("button", { name: "Start Voice Mode" }),
    ).toBeNull();
    expect(transport.open).not.toHaveBeenCalled();
  });
});
