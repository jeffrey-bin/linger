// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeSignIn } from "./RuntimeSignIn.js";
import { request } from "./api.js";
vi.mock("./api.js", () => ({ request: vi.fn() }));
beforeEach(() => {
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.resetAllMocks();
});
it("starts native login without a command and exposes official page and device code", async () => {
  vi.mocked(request).mockResolvedValue({
    state: "waiting_user",
    url: "https://auth.openai.com/codex/device",
    deviceCode: "ABCD-EFGHI",
  });
  render(
    <RuntimeSignIn instance="default" runtime="codex" onReady={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/runtime-login", {
      instance: "default",
    }),
  );
  expect(
    await screen.findByRole("link", { name: "Open sign-in page" }),
  ).toHaveProperty("href", "https://auth.openai.com/codex/device");
  expect(screen.getByText("ABCD-EFGHI")).toBeTruthy();
});
it("continues automatically only after native readiness is confirmed", async () => {
  vi.mocked(request).mockResolvedValue({ state: "ready" });
  const ready = vi.fn();
  render(<RuntimeSignIn instance="default" runtime="codex" onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalledOnce());
});

it.each([
  ["codex", "https://auth.openai.com/codex/device"],
  ["claude", "https://claude.com/cai/oauth/authorize?code=true&state=fixture"],
])(
  "opens the %s sign-in window on click and navigates when authorization is ready",
  async (runtime, url) => {
    const replace = vi.fn();
    const popup = {
      opener: window,
      closed: false,
      location: { replace },
      document: { title: "", body: { textContent: "" } },
    };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    vi.mocked(request).mockImplementation(async (url) =>
      url === "/runtime-login" ? await pending : { state: "idle" },
    );
    render(
      <RuntimeSignIn instance="default" runtime={runtime} onReady={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    resolve({
      state: "waiting_user",
      url,
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith(url));
  },
);
it("Pi offers only API key sign-in, never OAuth or a manual command", async () => {
  vi.mocked(request).mockResolvedValue({ state: "idle" });
  render(<RuntimeSignIn instance="default" runtime="pi" onReady={() => {}} />);
  expect(screen.queryByRole("button", { name: "Start sign-in" })).toBeNull();
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "private-test-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/runtime-login", {
      instance: "default",
      apiKey: "private-test-key",
      provider: "anthropic",
    }),
  );
  expect(window.open).not.toHaveBeenCalled();
  expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
});
it("offers API key as a secondary option for Codex", async () => {
  vi.mocked(request).mockResolvedValue({ state: "idle" });
  render(
    <RuntimeSignIn instance="default" runtime="codex" onReady={() => {}} />,
  );
  expect(screen.queryByLabelText("API key")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Use an API key instead" }),
  );
  expect(screen.getByLabelText("API key")).toBeTruthy();
});

it("connects Pi to an existing compatible model using only its form", async () => {
  vi.mocked(request).mockResolvedValue({ state: "idle" });
  render(<RuntimeSignIn instance="default" runtime="pi" onReady={() => {}} />);
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "openai-compatible" },
  });
  fireEvent.change(screen.getByLabelText("API base URL"), {
    target: { value: "http://127.0.0.1:18100/v1" },
  });
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "local-qwen" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/runtime-login", {
      instance: "default",
      provider: "openai-compatible",
      apiKey: "local",
      baseUrl: "http://127.0.0.1:18100/v1",
      model: "local-qwen",
    }),
  );
  expect(window.open).not.toHaveBeenCalled();
});

it("lets native Mac OAuth open its own browser without a duplicate blank popup", async () => {
  vi.mocked(request).mockResolvedValue({ state: "starting" });
  render(
    <RuntimeSignIn
      instance="default"
      runtime="codex"
      nativeBrowser
      onReady={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start sign-in" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/runtime-login", {
      instance: "default",
    }),
  );
  expect(window.open).not.toHaveBeenCalled();
});
