import type { runLocalmodels } from "./localmodels-tool.js";
import { expect, it, vi } from "vitest";
import { checkRuntimeModel, configureManagedCodex } from "./managed-codex.js";
it("delegates Responses probing and Codex model profile construction upstream via stdin", async () => {
  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: '{"saved":true}',
    stderr: "",
  }));
  await configureManagedCodex(
    "/owned/instances/default",
    {
      baseUrl: "https://gateway.example/v1",
      model: "owner-model",
      apiKey: "private-key",
    },
    new AbortController().signal,
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
      "codex",
      "--config-stdin",
      "--json",
    ],
    expect.objectContaining({
      input: JSON.stringify({
        provider: "openai-compatible",
        apiKey: "private-key",
        baseUrl: "https://gateway.example/v1",
        modelId: "owner-model",
        wireApi: "responses",
      }),
    }),
  );
  expect(JSON.stringify(localmodels.mock.calls[0]![1])).not.toContain(
    "private-key",
  );
});
it("does not return upstream errors or credentials when configuration fails", async () => {
  await expect(
    configureManagedCodex(
      "/owned/instances/default",
      {
        baseUrl: "https://gateway.example/v1",
        model: "owner-model",
        apiKey: "private-key",
      },
      new AbortController().signal,
      {
        localmodels: vi.fn<typeof runLocalmodels>(async () => ({
          code: 1,
          stdout: "private-key",
          stderr: "secret",
        })),
      },
    ),
  ).rejects.toThrow("Runtime model configuration failed");
});

it("delegates read-only model checks without saving a profile", async () => {
  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: '{"verified":true}',
    stderr: "",
  }));
  await checkRuntimeModel(
    {
      baseUrl: "https://gateway.example/v1",
      model: "owner-model",
      apiKey: "private-key",
    },
    new AbortController().signal,
    { home: "/owned", localmodels },
  );
  expect(localmodels.mock.calls[0]![1]).toContain("--check");
});
