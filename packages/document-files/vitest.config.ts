import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 5_000,
    environment: "node",
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
