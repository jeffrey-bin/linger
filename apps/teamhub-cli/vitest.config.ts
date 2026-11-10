import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 5_000,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // These suites exercise real filesystem locks, fsync, and recovery journals.
    // Bound disk contention on shared CI runners without extending deadlines.
    maxWorkers: 2,
  },
});
