import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useEffect } from "react";
import { afterEach, beforeEach, it, vi, expect } from "vitest";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { acceptVoice } from "@/test/teamhub-voice-routes";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { LiveKitVoiceControlProvider } from "@/features/rooms/voice-control/voice-control-provider";
import { VoiceControlProvider } from "@/features/rooms/voice-control/voice-backend-provider";
import {
  useOptionalVoiceControl,
  useVoiceControl,
} from "@/features/rooms/voice-control/voice-control-context";
import * as publisherLease from "@/features/rooms/voice-control/voice-publisher-lease";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceMediaPolicy,
} from "@/features/teamhub/teamhub-types";
import { teamHubData } from "@/features/teamhub/teamhub-api";

const media = vi.hoisted(() => ({
  publish: vi.fn(async () => undefined),
  stop: vi.fn(),
}));
vi.mock("livekit-client", () => ({
  RoomEvent: {
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
    MediaDevicesError: "mediaDevicesError",
  },
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: async () => ({
    stop: media.stop,
    mediaStreamTrack: Object.assign(new EventTarget(), {
      getSettings: () => ({ deviceId: "microphone" }),
    }),
  }),
  Room: class {
    localParticipant = {
      publishTrack: media.publish,
      unpublishTrack: async () => undefined,
    };
    on() {}
    async connect() {}
    async disconnect() {}
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
      clear: () => values.clear(),
    },
  });
  window.localStorage.setItem(
    "linger.voice.device.tenant-northstar",
    JSON.stringify({ deviceId: "microphone", groupId: "desk", label: "Desk" }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function Probe({ label }: { label: string }) {
  return useOptionalVoiceControl() ? <ReadyProbe label={label} /> : null;
}

function ReadyProbe({ label }: { label: string }) {
  const voice = useVoiceControl();
  useEffect(() => {
    void (voice.enable as (automatic: boolean) => Promise<void>)(true).catch(
      () => undefined,
    );
  }, [voice.enable]);
  return (
    <section aria-label={label}>
      <output aria-label="listener">{voice.listenerStatus}</output>
      {voice.listenerError ? <p role="alert">{voice.listenerError}</p> : null}
      <output aria-label="capture">{voice.captureState.status}</output>
      <output aria-label="target">{voice.targetRoomId}</output>
      <button onClick={() => void voice.startCapture()}>Start</button>
      <button onClick={() => void voice.stopCapture()}>Stop</button>
    </section>
  );
}
function UI({
  runtime,
  label,
}: {
  runtime: ReturnType<typeof createTestTeamHubRuntime>;
  label: string;
}) {
  return (
    <TeamHubRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <LiveKitVoiceControlProvider tenantId="tenant-northstar">
          <Probe label={label} />
        </LiveKitVoiceControlProvider>
      </MemoryRouter>
    </TeamHubRuntimeProvider>
  );
}
async function fixture() {
  const runtime = createTestTeamHubRuntime();
  acceptVoice(runtime);

  return runtime;
}

function servePolicy(
  runtime: TestTeamHubRuntime,
  answer: () => TeamHubVoiceMediaPolicy | Promise<TeamHubVoiceMediaPolicy>,
) {
  runtime.server.on("GET", "/v0/tenants/{tenantId}/voice-media-policy", answer);
}

async function startRecording(runtime: TestTeamHubRuntime, roomId: string) {
  const session = await teamHubData(
    runtime.client.api.POST("/v0/rooms/{roomId}/voice-sessions", {
      params: { path: { roomId } },
      body: { purpose: "hardware_control" },
    }),
  );
  return teamHubData(
    runtime.client.api.POST("/v0/voice-sessions/{voiceSessionId}/captures", {
      params: { path: { voiceSessionId: session.id } },
      body: { room_id: roomId, start_offset_ms: 0 },
    }),
  );
}

it("does not fall back to a different Room after active Room authorization fails", async () => {
  const runtime = await fixture();
  servePolicy(runtime, () => ({
    voice_media_supported: true,
    active_room_id: "inaccessible-room",
  }));
  runtime.server.on("GET", "/v0/rooms/{roomId}", () =>
    teamHubErrorResponse(403, "FORBIDDEN", "Room is unavailable"),
  );
  render(<UI runtime={runtime} label="forbidden" />);
  await waitFor(() =>
    expect(screen.getByLabelText("listener")).toHaveTextContent("error"),
  );
  expect(
    runtime.server.requestsTo("POST", "/v0/rooms/{roomId}/voice-sessions"),
  ).toEqual([]);
  expect(media.publish).not.toHaveBeenCalled();
});

it("observes a Stop saved by another page while automatic policy refresh was pending", async () => {
  const runtime = await fixture();
  const anotherMe = await teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
  const capture = await startRecording(runtime, anotherMe.room_id!);
  let release: (() => void) | undefined;
  servePolicy(
    runtime,
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            voice_media_supported: true,
            active_room_id: anotherMe.room_id,
          });
      }),
  );
  render(<UI runtime={runtime} label="pending-policy" />);
  await waitFor(() => expect(release).toBeDefined());
  await teamHubData(
    runtime.client.api.POST("/v0/voice-captures/{captureSessionId}/stop", {
      params: { path: { captureSessionId: capture.id } },
    }),
  );
  window.localStorage.setItem(
    "linger.voice.listening.tenant-northstar",
    JSON.stringify({
      captureId: capture.id,
      createdAt: capture.created_at,
      stopped: true,
    }),
  );
  await act(async () => release!());
  await waitFor(() =>
    expect(screen.getByLabelText("listener")).toHaveTextContent("disabled"),
  );
  expect(media.publish).not.toHaveBeenCalled();
});

it("refreshes the active Agent room when a previously waiting tab acquires the microphone", async () => {
  let held = true;
  vi.spyOn(publisherLease, "tryAcquireVoicePublisherLease").mockImplementation(
    async () => {
      if (held) return undefined;
      held = true;
      return () => {
        held = false;
      };
    },
  );
  const runtime = await fixture();
  render(
    <TeamHubRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <VoiceControlProvider tenantId="tenant-northstar">
          <Probe label="takeover" />
        </VoiceControlProvider>
      </MemoryRouter>
    </TeamHubRuntimeProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("listener")).toHaveTextContent("standby"),
  );
  const anotherMe = await teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
  const room = await teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}", {
      params: { path: { roomId: anotherMe.room_id! } },
    }),
  );
  runtime.server.on("GET", "/v0/rooms/{roomId}", () => ({
    ...room,
    id: "new-active-agent",
    direct_peer: { ...room.direct_peer!, kind: "agent", id: "general-agent" },
  }));
  servePolicy(runtime, () => ({
    voice_media_supported: true,
    active_room_id: "new-active-agent",
  }));
  const capture = await startRecording(runtime, "new-active-agent");
  held = false;
  await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("target")).toHaveTextContent(capture.room_id);
  expect(screen.getByLabelText("capture")).toHaveTextContent("recording");
});

it("keeps an explicitly stopped microphone disconnected after provider remount", async () => {
  const runtime = await fixture();
  const activeReads = () =>
    runtime.server.requestsTo("GET", "/v0/rooms/{roomId}/active-voice-capture")
      .length;
  const view = render(<UI runtime={runtime} label="first" />);
  await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
  const controls = within(screen.getByRole("region", { name: "first" }));
  fireEvent.click(controls.getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(controls.getByLabelText("capture")).toHaveTextContent("recording"),
  );
  fireEvent.click(controls.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(controls.getByLabelText("capture")).toHaveTextContent("completed"),
  );
  await waitFor(() =>
    expect(controls.getByLabelText("listener")).toHaveTextContent("disabled"),
  );
  const priorReads = activeReads();
  view.unmount();
  render(<UI runtime={runtime} label="remounted" />);
  await waitFor(() => expect(activeReads()).toBeGreaterThan(priorReads));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(media.publish).toHaveBeenCalledOnce();
  const restored = within(screen.getByRole("region", { name: "remounted" }));
  fireEvent.click(restored.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(media.publish).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(restored.getByLabelText("capture")).toHaveTextContent("recording"),
  );
});

it("does not republish from a standby provider after another provider completes Stop", async () => {
  let held = false;
  vi.spyOn(publisherLease, "tryAcquireVoicePublisherLease").mockImplementation(
    async () => {
      if (held) return undefined;
      held = true;
      return () => {
        held = false;
      };
    },
  );
  const runtime = await fixture();
  render(<UI runtime={runtime} label="owner" />);
  await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
  render(<UI runtime={runtime} label="standby" />);
  const owner = within(screen.getByRole("region", { name: "owner" }));
  const standby = within(screen.getByRole("region", { name: "standby" }));
  await waitFor(() =>
    expect(standby.getByLabelText("listener")).toHaveTextContent("standby"),
  );
  fireEvent.click(owner.getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(owner.getByLabelText("capture")).toHaveTextContent("recording"),
  );
  fireEvent.click(owner.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(owner.getByLabelText("capture")).toHaveTextContent("completed"),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2300)));
  expect(media.publish).toHaveBeenCalledOnce();
  expect(standby.getByLabelText("listener")).toHaveTextContent("disabled");
  fireEvent.click(standby.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(media.publish).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(standby.getByLabelText("capture")).toHaveTextContent("recording"),
  );
});

it("releases the current microphone when the Stop response is already finalized", async () => {
  const runtime = createTestTeamHubRuntime();
  const stopPath = "/v0/voice-captures/{captureSessionId}/stop";
  const acceptStop = acceptVoice(runtime)("POST", stopPath);
  runtime.server.on("POST", stopPath, async (request) => {
    const accepted = (await acceptStop(request)) as TeamHubVoiceCapture;
    return teamHubData(
      runtime.client.api.GET("/v0/voice-captures/{captureSessionId}", {
        params: { path: { captureSessionId: accepted.id } },
      }),
    );
  });
  render(<UI runtime={runtime} label="terminal" />);
  await waitFor(() => expect(media.publish).toHaveBeenCalledOnce());
  const controls = within(screen.getByRole("region", { name: "terminal" }));
  fireEvent.click(controls.getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(controls.getByLabelText("capture")).toHaveTextContent("recording"),
  );
  fireEvent.click(controls.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(controls.getByLabelText("capture")).toHaveTextContent("completed"),
  );
  await waitFor(() => expect(media.stop).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(controls.getByLabelText("listener")).toHaveTextContent("disabled"),
  );
});

it.each([false, true])(
  "restores the server active Agent room over a stale preference=%s",
  async (stale) => {
    const runtime = await fixture();
    const anotherMe = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    const originalRoom = await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: anotherMe.room_id! } },
      }),
    );
    if (stale)
      window.sessionStorage.setItem(
        "linger.voice.target.tenant-northstar",
        anotherMe.room_id!,
      );
    runtime.server.on("GET", "/v0/rooms/{roomId}", () => ({
      ...originalRoom,
      id: "active-agent-room",
      direct_peer: {
        ...originalRoom.direct_peer!,
        id: "general-agent",
        kind: "agent",
        display_name: "General Agent",
      },
    }));
    servePolicy(runtime, () => ({
      voice_media_supported: true,
      active_room_id: "active-agent-room",
    }));
    await startRecording(runtime, "active-agent-room");
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <VoiceControlProvider tenantId="tenant-northstar">
            <Probe label="server-active" />
          </VoiceControlProvider>
        </MemoryRouter>
      </TeamHubRuntimeProvider>,
    );
    await screen.findByRole("region", { name: "server-active" });
    await waitFor(() =>
      expect(screen.getByLabelText("target").textContent).not.toBe(""),
    );
    expect(screen.getByLabelText("target")).toHaveTextContent(
      "active-agent-room",
    );
    await waitFor(() =>
      expect(screen.getByLabelText("capture")).toHaveTextContent("recording"),
    );
    expect(media.publish).toHaveBeenCalledOnce();
  },
);
