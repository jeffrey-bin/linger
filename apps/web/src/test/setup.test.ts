// @vitest-environment jsdom
import { expect, it } from "vitest";

it("stamps animation frames with the performance.now() clock", async () => {
  const lag = (request: typeof requestAnimationFrame) =>
    new Promise<number>((resolve) =>
      request((timestamp) => resolve(performance.now() - timestamp)),
    );

  for (const request of [requestAnimationFrame, window.requestAnimationFrame]) {
    const elapsed = await lag(request);
    // jsdom's own frame clock trails performance.now() by the time between
    // process start and window creation, which is never this short.
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(50);
  }
});

it("skips animations through the same config object motion/react reads", async () => {
  const { MotionGlobalConfig } = await import("motion/react");
  const { MotionGlobalConfig: setupConfig } = await import("motion-utils");
  expect(setupConfig).toBe(MotionGlobalConfig);
  expect(MotionGlobalConfig.skipAnimations).toBe(true);
});
