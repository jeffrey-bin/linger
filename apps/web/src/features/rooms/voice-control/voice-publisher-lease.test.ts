import { afterEach, describe, expect, it, vi } from "vitest";
import { tryAcquireVoicePublisherLease } from "./voice-publisher-lease";

afterEach(() => vi.unstubAllGlobals());

describe("voice publisher ownership", () => {
  it("lets a second tab acquire only after the current publisher releases", async () => {
    let held = false;
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          name: string,
          options: { ifAvailable?: boolean; steal?: boolean },
          callback: (lock: { name: string } | null) => Promise<void>,
        ) => {
          expect(options.steal).not.toBe(true);
          if (held) return callback(null);
          held = true;
          try {
            await callback({ name });
          } finally {
            held = false;
          }
        },
      },
    });
    const release = await tryAcquireVoicePublisherLease("tenant");
    expect(release).toBeTypeOf("function");
    expect(await tryAcquireVoicePublisherLease("tenant")).toBeUndefined();
    release!();
    await vi.waitFor(() => expect(held).toBe(false));
    const next = await tryAcquireVoicePublisherLease("tenant");
    expect(next).toBeTypeOf("function");
    next!();
  });
});
