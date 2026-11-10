// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App.js";
import type { EnvironmentReport, InstallationJob } from "./api.js";
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof import("./api.js")>()),
  watchJob: vi.fn(async () => {}),
}));
const environment: EnvironmentReport = {
  platform: "darwin",
  arch: "arm64",
  releaseAvailable: true,
  checks: [
    { id: "docker", title: "Docker", state: "ready", detail: "Started" },
  ],
};
const completed: InstallationJob = {
  id: "job-1",
  instance: "default",
  state: "succeeded",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastSequence: 17,
  stages: [],
};
const persist = vi.fn();
let jobs: InstallationJob[];
let env: EnvironmentReport;
let accountExists: boolean;
let computerConnected: boolean | undefined;
let runtimeStatus: string;
let savedModel:
  | { baseUrl: string; model: string; keySaved: boolean }
  | undefined;
let savedRuntimeModel:
  | { baseUrl: string; model: string; keySaved: boolean }
  | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.removeItem("linger.runtime-sign-in-later");
  jobs = [];
  accountExists = false;
  savedModel = undefined;
  savedRuntimeModel = undefined;
  computerConnected = undefined;
  runtimeStatus = "logged_out";
  env = structuredClone(environment);
  history.replaceState(null, "", "/");
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname;
    const instance = parsed.searchParams.get("instance") ?? "default";
    const data =
      path === "/api/setup"
        ? {
            hardware: {
              platform: "darwin",
              arch: "arm64",
              totalMemoryBytes: 16 * 1024 ** 3,
              diskFreeBytes: 100 * 1024 ** 3,
              gpus: [],
            },
            choices: ["local-models", "codex", "claude", "pi"],
            recommendation: "codex",
            localModels: {
              eligible: false,
              reasons: ["linux_required", "ram_below_minimum"],
              selectedGpuIndex: null,
              estimate: {
                model: "qwen3.8-27b",
                downloadBytes: 22 * 1024 ** 3,
                diskBytes: 60 * 1024 ** 3,
                memoryBytes: 60 * 1024 ** 3,
                durationSeconds: { min: 1800, max: 7200 },
                assumption: "Estimate",
              },
            },
            runtimes: ["codex", "claude", "pi"].map((choice) => ({
              choice,
              installed: false,
              auth: "unknown",
              estimate: {
                downloadBytes: 100000000,
                diskBytes: 1000000000,
                memoryBytes: null,
                durationSeconds: { min: 30, max: 300 },
                assumption: "Estimate",
              },
            })),
          }
        : path === "/api/environment"
          ? env
          : path === "/api/config"
            ? {
                instance,
                email: "local@example.com",
                computerName: "My computer",
                accountExists: accountExists || instance === "existing",
                ...(savedModel ? { model: savedModel } : {}),
                ...(savedRuntimeModel
                  ? { runtimeModel: savedRuntimeModel }
                  : {}),
                releaseAvailable: true,
              }
            : path === "/api/instances"
              ? { items: [] }
              : path === "/api/jobs"
                ? options?.method === "POST"
                  ? { ...completed, state: "running" }
                  : { items: jobs }
                : path === "/api/jobs/job-1/retry"
                  ? { ...completed, state: "running" }
                  : path === "/api/jobs/job-1"
                    ? (jobs.find((job) => job.id === "job-1") ?? completed)
                    : path.endsWith("/login")
                      ? {
                          email: "local@example.com",
                          password: "Owner-visible-secret",
                          origin: "http://127.0.0.1:8080",
                        }
                      : path.endsWith("/status")
                        ? {
                            origin: "http://127.0.0.1:8080",
                            services: [{ service: "web", ready: true }],
                            computer: {
                              state: "action_required",
                              ...(computerConnected === undefined
                                ? {}
                                : { connected: computerConnected }),
                              detail: "Login required",
                              runtimes: [
                                { type: "Codex", status: runtimeStatus },
                              ],
                            },
                            knowledge: "unconfigured",
                          }
                        : { ok: true };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  vi.stubGlobal("sessionStorage", { setItem: persist });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("shows harness choices immediately and removes configuration and management modules", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  render(<App />);
  await screen.findByRole("radio", { name: /Codex/ });
  expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Pi/ })).toBeTruthy();
  for (const label of [
    "Customize deployment",
    "Advanced settings",
    "Install dependencies",
    "Open Docker",
    "Download service package",
    "Adjust configuration",
    "Stop local services",
    "Open data directory",
  ])
    expect(screen.queryByText(label)).toBeNull();
  expect(screen.queryByLabelText("Email")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Pi/ }));
  fireEvent.click(screen.getByRole("button", { name: "Install Linger" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs",
      expect.objectContaining({
        body: JSON.stringify({
          instance: "default",
          setupChoice: "pi",
        }),
      }),
    ),
  );
});
it("restores completion with visible credentials and only the product action", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  jobs = [completed];
  render(<App />);
  await screen.findByText("Owner-visible-secret");
  expect(screen.getByRole("link", { name: "Open Linger" })).toBeTruthy();
  for (const label of [
    "Check and start again",
    "Adjust configuration",
    "Open data directory",
    "Stop local services",
    "Connection and service details",
  ])
    expect(screen.queryByText(label)).toBeNull();
});
it("exchanges and clears the one-use fragment before loading", async () => {
  history.replaceState(null, "", "/#token=one-time-secret");
  render(<App />);
  await screen.findByRole("button", { name: "Install Linger" });
  expect(location.hash).toBe("");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/session",
    expect.objectContaining({
      body: JSON.stringify({ token: "one-time-secret" }),
    }),
  );
});
it("installs the desktop client's plan without asking again", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  history.replaceState(
    null,
    "",
    "/#token=one-time-secret&start=1&choice=claude",
  );
  render(<App />);
  await screen.findByText("Installing Linger");
  expect(location.hash).toBe("");
  expect(screen.queryByRole("button", { name: "Install Linger" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/jobs",
    expect.objectContaining({
      body: JSON.stringify({
        instance: "default",
        setupChoice: "claude",
      }),
    }),
  );
});
it("uses the recommendation for a plan without a known harness", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  history.replaceState(null, "", "/#start=1&choice=local-models");
  render(<App />);
  await screen.findByText("Installing Linger");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/jobs",
    expect.objectContaining({
      body: JSON.stringify({
        instance: "default",
        setupChoice: "codex",
      }),
    }),
  );
});
it("leaves a blocked plan for the user to resolve", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  env.checks = [
    {
      id: "disk",
      title: "Disk",
      state: "action_required",
      detail: "Free at least 20 GiB.",
    },
  ];
  history.replaceState(null, "", "/#start=1&choice=claude");
  render(<App />);
  expect(
    await screen.findByRole("button", { name: "Install Linger" }),
  ).toHaveProperty("disabled", true);
  expect(
    fetchMock.mock.calls.some(
      ([url, options]) => url === "/api/jobs" && options?.method === "POST",
    ),
  ).toBe(false);
});
it("keeps prerequisite failures beside the primary action", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  env.checks = [
    {
      id: "disk",
      title: "Disk",
      state: "action_required",
      detail: "Free at least 20 GiB.",
    },
  ];
  render(<App />);
  expect(
    await screen.findByRole("button", { name: "Install Linger" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("status", { name: "Before installation" }).textContent,
  ).toContain("20 GiB");
});
it("lets runtime sign-in be skipped without retrying or blocking the product", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  jobs = [
    {
      ...completed,
      state: "waiting_user",
      origin: "http://localhost:3000",
      errorCode: "RUNTIME_AUTH_REQUIRED",
      runtimeAuth: { runtime: "codex", loginCommand: "codex login" },
    },
  ];
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in later and continue" }),
  );
  await screen.findByRole("link", { name: "Open Linger" });
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/retry")),
  ).toBe(false);
});
it("does not call a saved job ready when current services are stopped", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  jobs = [completed];
  const original = fetchMock.getMockImplementation()! as (
    url: string,
    options?: RequestInit,
  ) => Promise<Response>;
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    String(url).endsWith("/status")
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              services: [{ service: "web", ready: false }],
              computer: { runtimes: [] },
            }),
          ),
        )
      : original(url, options),
  );
  render(<App />);
  await screen.findByText("Service startup needs attention");
  expect(
    screen.queryByRole("heading", { name: "Your Linger is ready" }),
  ).toBeNull();
});
it.each(["pending", "rejected"])(
  "never announces readiness while current status is %s",
  async (mode) => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
    jobs = [completed];
    const original = fetchMock.getMockImplementation()! as (
      url: string,
      options?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation((url: string, options?: RequestInit) =>
      String(url).endsWith("/status")
        ? mode === "pending"
          ? new Promise(() => {})
          : Promise.reject(new Error("Status unavailable"))
        : original(url, options),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Checking services…" });
    expect(
      screen.queryByRole("heading", { name: "Your Linger is ready" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Open Linger" })).toBeNull();
  },
);
it("checks current business health before restoring the runtime sign-in page", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
  jobs = [
    {
      ...completed,
      state: "waiting_user",
      origin: "http://localhost:3000",
      errorCode: "RUNTIME_AUTH_REQUIRED",
      runtimeAuth: { runtime: "codex", loginCommand: "codex login" },
    },
  ];
  const original = fetchMock.getMockImplementation()! as (
    url: string,
    options?: RequestInit,
  ) => Promise<Response>;
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    String(url).endsWith("/status")
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              services: [{ service: "web", ready: false }],
              computer: { runtimes: [] },
            }),
          ),
        )
      : original(url, options),
  );
  render(<App />);
  await screen.findByText("Service startup needs attention");
  expect(screen.queryByRole("button", { name: "Start sign-in" })).toBeNull();
});

it("does not restore another instance's most recent installation", async () => {
  jobs = [{ ...completed, instance: "unrelated", state: "running" }];
  render(<App />);
  await screen.findByRole("radiogroup");
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("identifies native source in the same setup flow", async () => {
  env.checks = [
    {
      id: "source-native",
      title: "Source checkout",
      state: "ready",
      detail: "Native source ready",
    },
  ];
  render(<App />);
  await screen.findByText(/Source development · Native/);
  expect(screen.queryByRole("button", { name: "Open Docker" })).toBeNull();
});

it("leaves GPU sharing to the installer default without a checkbox", async () => {
  render(<App />);
  await screen.findByRole("radiogroup");
  expect(screen.queryByRole("checkbox", { name: /GPU/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Install Linger/ }));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/api/jobs") && init?.method === "POST",
    );
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("shareGpu");
  });
});
