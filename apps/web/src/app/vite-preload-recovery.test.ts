import { describe, expect, it, vi } from "vitest";

import { installVitePreloadRecovery } from "./vite-preload-recovery";

describe("Vite preload recovery", () => {
  it("reloads once when the current build loses a lazy chunk", () => {
    const eventTarget = new EventTarget();
    const reload = vi.fn();
    const storage = createStorage();
    const stop = installVitePreloadRecovery({
      buildId: "https://web.example/assets/index-build-a.js",
      eventTarget,
      reload,
      storage,
    });

    const firstFailure = createPreloadError(
      "Failed to fetch dynamically imported module: https://web.example/assets/wiki-build-a.js",
    );
    eventTarget.dispatchEvent(firstFailure);

    expect(firstFailure.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();

    const repeatedFailure = createPreloadError(
      "Failed to fetch dynamically imported module: https://web.example/assets/wiki-build-a.js",
    );
    eventTarget.dispatchEvent(repeatedFailure);

    expect(repeatedFailure.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    stop();
  });

  it("allows a later build to recover in the same browser tab", () => {
    const eventTarget = new EventTarget();
    const reload = vi.fn();
    const storage = createStorage();
    storage.setItem(
      "linger.web.vite-preload-recovery.v1",
      "https://web.example/assets/index-build-a.js",
    );

    installVitePreloadRecovery({
      buildId: "https://web.example/assets/index-build-b.js",
      eventTarget,
      reload,
      storage,
    });
    const failure = createPreloadError(
      "Failed to fetch dynamically imported module: https://web.example/assets/wiki-build-b.js",
    );

    eventTarget.dispatchEvent(failure);

    expect(failure.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves the error to the route boundary when session storage is unavailable", () => {
    const eventTarget = new EventTarget();
    const reload = vi.fn();
    const storage = createStorage();
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    installVitePreloadRecovery({
      buildId: "https://web.example/assets/index-build-a.js",
      eventTarget,
      reload,
      storage,
    });
    const failure = createPreloadError(
      "Failed to fetch dynamically imported module: https://web.example/assets/wiki-build-a.js",
    );

    eventTarget.dispatchEvent(failure);

    expect(failure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

function createPreloadError(message: string) {
  return Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new Error(message),
  });
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
