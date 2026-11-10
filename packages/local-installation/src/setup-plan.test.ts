import { expect, it, vi } from "vitest";
import { inspectSetup, assertLocalModelsEligible } from "./setup-plan.js";

const upstream = (available = true) => ({
  schema: "localmodels.setup-report/v1",
  facts: {
    platform: "linux",
    arch: "unusual",
    ram: { total_bytes: 7 },
    disk: { free_bytes: 9 },
    gpus: [{ index: 4, name: "upstream GPU", total_bytes: 6, free_bytes: 5 }],
  },
  stack: {
    available,
    reasons: available
      ? []
      : [{ code: "upstream_policy", message: "Upstream rejected this host" }],
    plan: available
      ? {
          llm: {
            model: { id: "upstream-model" },
            placement: { gpus: [{ index: 4 }] },
          },
          budget: {
            download_bytes: 11,
            disk_needed_bytes: 13,
            ram_needed_bytes: 17,
          },
        }
      : null,
  },
  harness: {
    schema: "localmodels.harness-status/v1",
    runtimes: ["codex", "claude", "pi"].map((runtime) => ({
      runtime,
      installed: runtime === "pi",
      authenticated: runtime === "pi",
    })),
  },
  recommendation: available ? "local-models" : "pi",
});
const runner = (value = upstream()) =>
  vi.fn(async () => ({ code: 0, stdout: JSON.stringify(value), stderr: "" }));
it("delegates all hardware policy, runtime detection, estimates and recommendation upstream", async () => {
  const localmodels = runner();
  const report = await inspectSetup({
    home: "/owned",
    localmodels,
  });
  expect(localmodels).toHaveBeenCalledWith(
    "/owned",
    [
      "setup",
      "inspect",
      "--root",
      "/owned/runtime/harness",
      "--model-base-dir",
      "/owned/runtime/localmodels/models",
      "--decision",
      "none",
      "--offline",
      "--defer-services",
      "--share-gpu",
      "--json",
    ],
    expect.objectContaining({ timeoutMs: 120000 }),
  );
  expect(report.hardware.totalMemoryBytes).toBe(7);
  expect(report.localModels).toMatchObject({
    eligible: true,
    selectedGpuIndex: 4,
    estimate: {
      model: "upstream-model",
      downloadBytes: 11,
      diskBytes: 13,
      memoryBytes: 17,
      durationSeconds: null,
    },
  });
  expect(report.localModels).not.toHaveProperty("minimum");
  expect(report.runtimes[2]).toMatchObject({
    installed: true,
    auth: "authenticated",
    estimate: {
      downloadBytes: null,
      diskBytes: null,
      memoryBytes: null,
      durationSeconds: null,
    },
  });
  expect(report.recommendation).toBe("local-models");
});
it("preserves upstream rejection and never substitutes downstream eligibility", async () => {
  const localmodels = runner(upstream(false));
  const report = await inspectSetup({ localmodels });
  expect(report.localModels.reasons).toEqual(["upstream_policy"]);
  expect(report.localModels.reasonMessages).toEqual([
    "Upstream rejected this host",
  ]);
  expect(report.recommendation).toBe("pi");
  expect(report.localModels.estimate.downloadBytes).toBeNull();
  await expect(assertLocalModelsEligible({ localmodels })).rejects.toThrow(
    "upstream_policy: Upstream rejected this host",
  );
});
it("fails explicitly and redacts tool output when upstream is unavailable or malformed", async () => {
  for (const response of [
    { code: 1, stdout: "private token", stderr: "secret" },
    { code: 0, stdout: "{}", stderr: "" },
  ]) {
    await expect(
      inspectSetup({ localmodels: vi.fn(async () => response) }),
    ).rejects.toMatchObject({ code: "LOCALMODELS_SETUP_UNAVAILABLE" });
  }
});
it("honors cancellation before invoking upstream", async () => {
  const localmodels = runner();
  await expect(
    inspectSetup({ signal: AbortSignal.abort(), localmodels }),
  ).rejects.toThrow();
  expect(localmodels).not.toHaveBeenCalled();
});

it("inspects with GPU sharing unless sharing was explicitly declined", async () => {
  const localmodels = vi.fn<
    (
      home: string,
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>
  >(async () => ({
    code: 0,
    stdout: JSON.stringify(upstream()),
    stderr: "",
  }));
  await inspectSetup({ localmodels, shareGpu: false });
  expect(localmodels.mock.calls[0]?.[1]).not.toContain("--share-gpu");
  await inspectSetup({ localmodels, shareGpu: true });
  expect(localmodels.mock.calls[1]?.[1]).toContain("--share-gpu");
  await inspectSetup({ localmodels });
  expect(localmodels.mock.calls[2]?.[1]).toContain("--share-gpu");
});
