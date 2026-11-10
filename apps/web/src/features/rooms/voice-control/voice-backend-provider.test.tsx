import { fetchDouble } from "@/features/teamhub/teamhub-client-test-support";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";
import { VoiceControlProvider } from "./voice-backend-provider";
import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";

import {
  VoiceCapabilitiesContext,
  VoiceControlContext,
  useOptionalVoiceControl,
  type VoiceControlContextValue,
} from "./voice-control-context";
import { requestUrlText } from "@linger/service-kit";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
} from "@/test/teamhub-test-server";

const fixture = vi.hoisted(() => ({
  engineGate: null as Promise<void> | null,
  policy: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));
// The policy double answers TeamHub errors as their envelope; any other
// rejection fails the request like a lost connection.
const client = createHttpTeamHubClient({
  baseUrl: "https://voice.test",
  fetchRequest: new TeamHubTestServer().on(
    "GET",
    "/v0/tenants/{tenantId}/voice-media-policy",
    async () => {
      try {
        return await fixture.policy();
      } catch (error) {
        if (!(error instanceof TeamHubError)) throw error;
        return teamHubErrorResponse(error.status, error.code, error.message);
      }
    },
  ).fetch,
  onAuthenticationRequired: () => undefined,
});
let httpClient: TeamHubClient | undefined;
vi.mock("@/features/teamhub/teamhub-runtime", () => ({
  useTeamHubRuntime: () => ({ client: httpClient ?? client }),
}));
vi.mock("./voice-control-provider", () => ({
  LiveKitVoiceControlProvider: ({
    children,
    tenantId,
  }: {
    children: ReactNode;
    tenantId: string;
  }) => {
    const [target, setTarget] = useState("first");
    useEffect(() => {
      fixture.mounted(tenantId);
      return () => fixture.unmounted(tenantId);
    }, [tenantId]);
    // Suspense suspends a component by throwing a Promise.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional Suspense signal
    if (fixture.engineGate) throw fixture.engineGate;
    return (
      <VoiceControlContext
        value={{ targetRoomId: target } as VoiceControlContextValue}
      >
        <section aria-label={`livekit:${tenantId}`}>
          <button onClick={() => setTarget("next")}>Change voice target</button>
          {children}
        </section>
      </VoiceControlContext>
    );
  },
}));

const livekitPolicy = {
  voice_media_supported: true,
  active_room_id: "active-room",
};
const httpError = (status: number) =>
  new TeamHubError({
    status,
    code: "UNAVAILABLE",
    message: "Fixture unavailable",
  });
const ui = (tenantId = "tenant-a", text = "Room content") => (
  <VoiceControlProvider tenantId={tenantId}>
    <p>{text}</p>
  </VoiceControlProvider>
);
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  httpClient = undefined;
  fixture.engineGate = null;
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.policy.mockReset().mockResolvedValue(livekitPolicy);
  vi.stubGlobal("indexedDB", {});
});

function hangingHttpRead() {
  const aborted = vi.fn();
  let hang = true;
  let signal: AbortSignal | null | undefined;
  const transport = vi.fn<typeof fetch>(async (input, options) => {
    const path = new URL(requestUrlText(input)).pathname;
    const isPolicy = path.endsWith("voice-media-policy");
    if (hang && isPolicy) {
      hang = false;
      signal = options?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted();
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify(livekitPolicy), {
      headers: { "content-type": "application/json" },
    });
  });
  httpClient = createHttpTeamHubClient({
    baseUrl: "https://voice.test",
    fetchRequest: fetchDouble((url, init) => transport(url, init)),
  });
  return { aborted, transport, signal: () => signal };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function VoiceProbe() {
  const livekit = useOptionalVoiceControl();
  return <p>Target: {livekit?.targetRoomId ?? "loading"}</p>;
}

function CapabilitiesProbe() {
  const capabilities = useContext(VoiceCapabilitiesContext);
  return (
    <p>
      Capabilities:{" "}
      {capabilities ? `media=${capabilities.voiceMedia}` : "loading"}
    </p>
  );
}

describe("voice backend bootstrap recovery", () => {
  it("preserves the composer while the LiveKit engine suspends", async () => {
    let release!: () => void;
    fixture.engineGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      <VoiceControlProvider tenantId="tenant-a">
        <input aria-label="Draft" />
        <VoiceProbe />
      </VoiceControlProvider>,
    );
    await advance();
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, {
      target: { value: "draft during engine load" },
    });
    expect(screen.getByText("Target: loading")).toBeVisible();
    fixture.engineGate = null;
    await act(async () => release());
    await advance();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("draft during engine load");
    expect(screen.getByText("Target: first")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Change voice target" }),
    );
    await advance();
    expect(screen.getByText("Target: next")).toBeVisible();
    expect(fixture.mounted).toHaveBeenCalledTimes(1);
    expect(fixture.policy).toHaveBeenCalledTimes(1);
  });

  it("loads no engine and settles the composer when the deployment has no voice media", async () => {
    fixture.policy.mockResolvedValue({
      voice_media_supported: false,
    });
    render(
      <VoiceControlProvider tenantId="tenant-a">
        <CapabilitiesProbe />
      </VoiceControlProvider>,
    );
    expect(screen.getByText("Capabilities: loading")).toBeVisible();
    await advance();
    expect(screen.getByText("Capabilities: media=false")).toBeVisible();
    expect(fixture.mounted).not.toHaveBeenCalled();
  });

  it("keeps the same editable content mounted while voice policy loads and becomes ready", async () => {
    let resolvePolicy!: (policy: typeof livekitPolicy) => void;
    fixture.policy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    render(
      <VoiceControlProvider tenantId="tenant-a">
        <input aria-label="Draft" />
        <div
          role="region"
          aria-label="Messages"
          style={{ overflow: "auto", height: 100 }}
        >
          History
        </div>
      </VoiceControlProvider>,
    );
    await advance();
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const messages = screen.getByRole("region", { name: "Messages" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    draft.focus();
    messages.scrollTop = 80;
    await act(async () => resolvePolicy(livekitPolicy));
    await advance();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep my draft");
    expect(draft).toHaveFocus();
    expect(screen.getByRole("region", { name: "Messages" })).toBe(messages);
    expect(messages.scrollTop).toBe(80);
    expect(fixture.mounted).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung policy read and recovers the current tenant", async () => {
    const request = hangingHttpRead();
    render(ui());
    await advance();
    await advance(4_999);
    expect(request.aborted).not.toHaveBeenCalled();
    await advance(1);
    expect(request.aborted).toHaveBeenCalledTimes(1);
    expect(request.signal()?.aborted).toBe(true);
    await advance(500);
    expect(
      screen.getByRole("region", {
        name: "livekit:tenant-a",
      }),
    ).toBeVisible();
    expect(request.transport).toHaveBeenCalledTimes(2);
  });

  it("aborts a pending policy read on unmount without retrying", async () => {
    const request = hangingHttpRead();
    const view = render(ui());
    await advance();
    view.unmount();
    await advance(10_000);
    expect(request.aborted).toHaveBeenCalledTimes(1);
    expect(request.transport).toHaveBeenCalledTimes(1);
    expect(fixture.mounted).not.toHaveBeenCalled();
  });

  it("aborts the old tenant HTTP request before establishing the new tenant provider", async () => {
    const request = hangingHttpRead();
    const view = render(ui());
    await advance();
    view.rerender(ui("tenant-b"));
    await advance();
    expect(request.aborted).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "livekit:tenant-b" }),
    ).toBeVisible();
    await advance(10_000);
    expect(request.transport).toHaveBeenCalledTimes(2);
  });

  it("recovers a transient 503 without changing client or tenant or remounting on presentation changes", async () => {
    fixture.policy.mockRejectedValueOnce(httpError(503));
    const view = render(ui());
    await advance();
    expect(fixture.policy).toHaveBeenCalledTimes(1);
    view.rerender(ui("tenant-a", "Updated Room content"));
    await advance(500);
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("region", { name: "livekit:tenant-a" }),
    ).toBeVisible();
    expect(screen.getByText("Updated Room content")).toBeVisible();
    view.rerender(ui("tenant-a", "Another presentation"));
    await advance(5_000);
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(fixture.mounted).toHaveBeenCalledTimes(1);
    expect(fixture.unmounted).not.toHaveBeenCalled();
  });

  it.each([httpError(429), new TeamHubTransportError("Connection lost")])(
    "retries a recoverable %s without falling back to legacy",
    async (error) => {
      fixture.policy.mockRejectedValueOnce(error);
      render(ui());
      await advance();
      expect(
        screen.queryByRole("region", { name: "legacy:tenant-a" }),
      ).not.toBeInTheDocument();
      await advance(500);
      expect(fixture.policy).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("region", { name: "livekit:tenant-a" }),
      ).toBeVisible();
    },
  );

  it("bounds retry intervals and cancels the scheduled retry on unmount", async () => {
    fixture.policy.mockRejectedValue(httpError(503));
    const view = render(ui());
    await advance();
    for (const [index, delay] of [500, 1_000, 2_000, 5_000, 5_000].entries()) {
      await advance(delay - 1);
      expect(fixture.policy).toHaveBeenCalledTimes(index + 1);
      await advance(1);
      expect(fixture.policy).toHaveBeenCalledTimes(index + 2);
    }
    view.unmount();
    await advance(10_000);
    expect(fixture.policy).toHaveBeenCalledTimes(6);
  });

  it("keeps permanent failures explicit and allows one manual retry", async () => {
    fixture.policy.mockRejectedValue(httpError(403));
    render(ui());
    await advance(10_000);
    expect(fixture.policy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "legacy:tenant-a" }),
    ).not.toBeInTheDocument();
    fixture.policy.mockResolvedValue(livekitPolicy);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry voice connection" }),
    );
    await advance();
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "livekit:tenant-a" }),
    ).toBeVisible();
  });

  it("keeps a missing voice policy endpoint unavailable", async () => {
    fixture.policy.mockRejectedValue(httpError(404));
    render(ui());
    await advance();
    expect(screen.getByRole("alert")).toBeVisible();
    expect(fixture.mounted).not.toHaveBeenCalled();
    await advance(10_000);
    expect(fixture.policy).toHaveBeenCalledTimes(1);
  });

  it("fences a late policy response when resource identity changes", async () => {
    let resolveOld!: (policy: typeof livekitPolicy) => void;
    fixture.policy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = render(ui());
    await advance();
    view.rerender(ui("tenant-b"));
    await advance();
    expect(
      screen.getByRole("region", { name: "livekit:tenant-b" }),
    ).toBeVisible();
    await act(async () => resolveOld(livekitPolicy));
    await advance(10_000);
    expect(
      screen.getByRole("region", { name: "livekit:tenant-b" }),
    ).toBeVisible();
    expect(fixture.policy).toHaveBeenCalledTimes(2);
    expect(fixture.mounted).toHaveBeenCalledTimes(1);
  });
});
