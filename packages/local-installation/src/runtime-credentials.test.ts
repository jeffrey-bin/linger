import type { runLocalmodels } from "./localmodels-tool.js";
import { expect, test, vi } from "vitest";
import { saveRuntimeApiKey } from "./runtime-credentials.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
test("delegates credential verification and native profile writing upstream through private stdin", async () => {
  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: '{"schema":"localmodels.harness-auth/v1","saved":true}',
    stderr: "",
  }));
  await saveRuntimeApiKey(
    "/owned/instances/default",
    "pi",
    "openai-compatible",
    "private-key",
    { baseUrl: "http://127.0.0.1:18100/v1", model: "owner-model" },
    { localmodels },
  );
  expect(localmodels).toHaveBeenCalledWith(
    "/owned",
    [
      "harness",
      "auth",
      "--root",
      "/owned/runtime/harness",
      "--runtime",
      "pi",
      "--config-stdin",
      "--json",
    ],
    expect.objectContaining({
      input: JSON.stringify({
        provider: "openai-compatible",
        apiKey: "private-key",
        baseUrl: "http://127.0.0.1:18100/v1",
        modelId: "owner-model",
      }),
    }),
  );
  expect(JSON.stringify(localmodels.mock.calls[0]![1])).not.toContain(
    "private-key",
  );
});
test("redacts upstream rejection and does not write installer-owned profile files", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "credential-delegate-"));
  try {
    await expect(
      saveRuntimeApiKey(root, "claude", "anthropic", "private-key", undefined, {
        localmodels: vi.fn<typeof runLocalmodels>(async () => ({
          code: 1,
          stdout: "secret-provider-body",
          stderr: "private-key",
        })),
      }),
    ).rejects.toThrow("Runtime credential configuration failed");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("rejects malformed user input before upstream access", async () => {
  const localmodels = vi.fn();
  for (const [runtime, provider, key, model] of [
    ["claude", "openai", "key", undefined],
    ["pi", "openai", "key\nextra", undefined],
    [
      "pi",
      "openai-compatible",
      "key",
      { baseUrl: "http://169.254.169.254/latest", model: "model" },
    ],
  ] as const) {
    await expect(
      saveRuntimeApiKey(
        "/owned/instances/default",
        runtime,
        provider,
        key,
        model,
        { localmodels },
      ),
    ).rejects.toThrow();
  }
  expect(localmodels).not.toHaveBeenCalled();
});
