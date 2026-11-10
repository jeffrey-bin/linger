import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { readSetupChoice, writeSetupChoice } from "./setup-selection.js";
import type { Instance } from "./instance.js";
it("round trips only the exact selected mode in private instance state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "setup-choice-"));
  try {
    const instance = { root } as Instance;
    expect(await readSetupChoice(instance)).toBeUndefined();
    for (const choice of ["local-models", "codex", "claude", "pi"] as const) {
      await writeSetupChoice(instance, choice);
      expect(await readSetupChoice(instance)).toBe(choice);
    }
    await writeFile(
      path.join(root, "setup-choice.json"),
      JSON.stringify({ runtime: "codex" }),
      { mode: 0o600 },
    );
    await expect(readSetupChoice(instance)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("GPU sharing consent is explicit, private, and independently reversible", async () => {
  const { readGpuSharing, writeGpuSharing } =
    await import("./setup-selection.js");
  const root = await mkdtemp(path.join(tmpdir(), "gpu-consent-"));
  try {
    const instance = { root } as Instance;
    expect(await readGpuSharing(instance)).toBeUndefined();
    await writeGpuSharing(instance, true);
    expect(await readGpuSharing(instance)).toBe(true);
    await writeGpuSharing(instance, false);
    expect(await readGpuSharing(instance)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
