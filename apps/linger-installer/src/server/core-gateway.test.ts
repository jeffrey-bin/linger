import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instance: { root: "/test/instances/default", mode: "source-native" },
  runtime: "pi",
  locked: false,
  lockTail: Promise.resolve(),
  prepare: vi.fn(),
  stopGateway: vi.fn(),
  stopComputer: vi.fn(),
  stopNative: vi.fn(),
  saveKey: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  managedEnvironment: vi.fn(),
  localModelsEnvironment: vi.fn(),
}));
vi.mock("@linger/local-installation/managed-codex", () => ({
  managedRuntimeEnvironment: mocks.managedEnvironment,
  readManagedModel: async () => undefined,
}));
vi.mock("@linger/local-installation/local-models", () => ({
  localModelsEnvironment: mocks.localModelsEnvironment,
}));
vi.mock("@linger/local-installation/model-gateway", () => ({
  prepareModelGateway: mocks.prepare,
  stopModelGateway: mocks.stopGateway,
}));
vi.mock("@linger/local-installation/instance", () => ({
  loadInstance: async () => mocks.instance,
  withInstanceLock: async (
    _instance: unknown,
    action: () => Promise<unknown>,
  ) => {
    const previous = mocks.lockTail;
    let release!: () => void;
    mocks.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    expect(mocks.locked).toBe(false);
    mocks.locked = true;
    try {
      return await action();
    } finally {
      mocks.locked = false;
      release();
    }
  },
}));
vi.mock("@linger/local-installation/setup-selection", () => ({
  DEFAULT_GPU_SHARING: true,
  readSetupChoice: async () => mocks.runtime,
}));
vi.mock("@linger/local-installation/runtime-credentials", () => ({
  saveRuntimeApiKey: mocks.saveKey,
}));
vi.mock("@linger/local-installation/computer", () => ({
  stopComputer: mocks.stopComputer,
}));
vi.mock("@linger/local-installation/native-source", () => ({
  stopNativeSource: mocks.stopNative,
}));
vi.mock("./runtime-login.js", () => ({
  RuntimeLoginManager: class {
    status = mocks.status;
    start = mocks.start;
    close() {}
  },
}));
import { coreAdapter } from "./core.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runtime = "pi";
  mocks.locked = false;
  mocks.lockTail = Promise.resolve();
  mocks.status.mockResolvedValue({ state: "ready" });
  mocks.start.mockResolvedValue({ state: "waiting_user" });
  mocks.stopGateway.mockImplementation(async () => {
    expect(mocks.locked).toBe(true);
  });
});

it("saves a Pi API key under the instance lock and prepares no gateway", async () => {
  mocks.saveKey.mockImplementation(async () => {
    expect(mocks.locked).toBe(true);
  });
  const adapter = coreAdapter("/test", "/checkout");
  await expect(
    adapter.runtimeLogin("default", true, undefined, {
      provider: "openai",
      apiKey: "fake-test-key",
    }),
  ).resolves.toEqual({ state: "ready" });
  expect(mocks.saveKey).toHaveBeenCalledOnce();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.stopComputer).not.toHaveBeenCalled();
});

it.each(["codex", "claude"])(
  "completes %s sign-in without preparing a gateway",
  async (runtime) => {
    mocks.runtime = runtime;
    const adapter = coreAdapter("/test", "/checkout");
    await expect(adapter.runtimeLogin("default", true)).resolves.toEqual({
      state: "waiting_user",
    });
    await expect(adapter.runtimeLogin("default")).resolves.toEqual({
      state: "ready",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  },
);

it("has no runtime sign-in for local models", async () => {
  mocks.runtime = "local-models";
  await expect(
    coreAdapter("/test", "/checkout").runtimeLogin("default", true),
  ).resolves.toEqual({ state: "idle" });
  expect(mocks.start).not.toHaveBeenCalled();
});

it("stops the instance's native services", async () => {
  await expect(coreAdapter("/test", "/checkout").stop("default")).resolves.toBe(
    true,
  );
  expect(mocks.stopNative).toHaveBeenCalledWith(
    mocks.instance,
    expect.any(AbortSignal),
  );
});

it("reports the selected runtime's paths for an external Computer, never other variables", async () => {
  mocks.runtime = "codex";
  mocks.managedEnvironment.mockResolvedValue({
    LINGER_CODEX_PATH: "/home/me/.linger/runtime/harness/tools/codex",
    CODEX_HOME: "/home/me/.linger/runtime/harness/codex-home",
    OPENAI_API_KEY: "fake-test-key",
    CLAUDE_CONFIG_DIR: "relative/profile",
  });
  mocks.localModelsEnvironment.mockResolvedValue({});
  await expect(
    coreAdapter("/test", "/checkout").runtime("default"),
  ).resolves.toEqual({
    setupChoice: "codex",
    environment: {
      LINGER_CODEX_PATH: "/home/me/.linger/runtime/harness/tools/codex",
      CODEX_HOME: "/home/me/.linger/runtime/harness/codex-home",
    },
  });
});

it("reports the local model's Pi for local models", async () => {
  mocks.runtime = "local-models";
  mocks.managedEnvironment.mockResolvedValue({});
  mocks.localModelsEnvironment.mockResolvedValue({
    LINGER_PI_PATH: "/test/runtime/localmodels/pi",
    PI_CODING_AGENT_DIR: "/test/runtime/localmodels/pi-agent",
    LINGER_LOCAL_MODELS_REVISION: "abc",
  });
  await expect(
    coreAdapter("/test", "/checkout").runtime("default"),
  ).resolves.toEqual({
    setupChoice: "local-models",
    environment: {
      LINGER_PI_PATH: "/test/runtime/localmodels/pi",
      PI_CODING_AGENT_DIR: "/test/runtime/localmodels/pi-agent",
    },
  });
});
