import { afterEach, vi } from "vitest";

import { resetComposerAttachmentDraftsForTest } from "@/features/rooms/chat/composer-attachment-drafts";
import { setRoomDiagnosticsEnabledForTest } from "@/lib/room-diagnostics";
import { assertNoUnhandledTestRoutes } from "@/test/teamhub-test-server";

// Tests assert the Room timing diagnostics, which are off by default in browsers.
setRoomDiagnosticsEnabledForTest(true);

// Pure logic tests opt into Node and do not need the React/DOM harness.
let cleanupRenderedComponents: (() => void) | undefined;
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  // motion-utils owns the global config motion/react reads; loading all of
  // motion/react here cost every DOM test file ~0.1 s though few render it.
  const { MotionGlobalConfig } = await import("motion-utils");
  const { cleanup, configure } = await import("@testing-library/react");
  // Testing Library findBy/waitFor and vi.waitFor share the 5s budget. They resolve
  // as soon as the condition holds, so this only bounds how long a genuinely
  // failing wait takes; first-use lazy chunk transforms can exceed 1s on a loaded machine.
  configure({ asyncUtilTimeout: 5_000 });
  MotionGlobalConfig.skipAnimations = true;
  cleanupRenderedComponents = cleanup;

  // jsdom has no layout observer. Geometry tests supply measured entries;
  // other component tests only need the browser API's lifecycle.
  if (typeof ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // Browsers stamp animation frames with the performance.now() clock. jsdom uses
  // its own clock, which starts when the window is created, while performance is
  // Node's, which starts with the process. Under the threads pool that is the
  // shared Vitest process, so frame-driven animations ran for minutes and kept
  // re-rendering until they starved pending Suspense retries.
  const stampAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.requestAnimationFrame = (callback) =>
    stampAnimationFrame(() => callback(performance.now()));

  if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  }

  if (
    typeof HTMLElement !== "undefined" &&
    !HTMLElement.prototype.scrollIntoView
  ) {
    HTMLElement.prototype.scrollIntoView = () => undefined;
  }
}

// vi.waitFor defaults to a 1s wall-clock budget; align it with the Testing Library wait.
const waitForWithDefault = vi.waitFor;
vi.waitFor = (callback, options) =>
  waitForWithDefault(
    callback,
    typeof options === "number" ? options : { timeout: 5_000, ...options },
  );

afterEach(() => {
  try {
    cleanupRenderedComponents?.();
  } finally {
    vi.unstubAllEnvs();
    resetComposerAttachmentDraftsForTest();
    assertNoUnhandledTestRoutes();
  }
});
