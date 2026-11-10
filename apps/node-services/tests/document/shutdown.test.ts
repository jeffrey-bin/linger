import { describe, expect, it, vi } from "vitest";

import { drainDocumentRuntime } from "../../src/document/shutdown.js";

describe("Document Runtime shutdown", () => {
  it("aborts a stuck drain at the global deadline and returns a failure status", async () => {
    let drainSignal: AbortSignal | undefined;
    const closeAllConnections = vi.fn();
    const reportError = vi.fn();
    const status = await drainDocumentRuntime({
      runtime: {
        beginDrain(signal) {
          drainSignal = signal;
        },
        destroy: () => new Promise<void>(() => undefined),
        httpServer: { closeAllConnections },
      },
      timeoutMs: 10,
      reportError,
    });

    expect(status).toBe(1);
    expect(drainSignal?.aborted).toBe(true);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      "Document Runtime drain deadline expired",
    );
  });

  it("returns success when realtime drains", async () => {
    const status = await drainDocumentRuntime({
      runtime: {
        beginDrain() {},
        destroy: async () => undefined,
        httpServer: { closeAllConnections: vi.fn() },
      },
      timeoutMs: 100,
    });

    expect(status).toBe(0);
  });
});
