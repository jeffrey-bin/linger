import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["acceptance/live-audio/**/*.test.ts"],
    testTimeout: 180_000,
    // Each scenario holds a real-time call; several run side by side.
    maxConcurrency: 4,
    env: { TZ: "Asia/Shanghai" },
  },
});
