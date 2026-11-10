import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: Number(process.env.COMPUTER_TEST_TIMEOUT_MS ?? 5_000),
    include: ["tests/**/*.test.ts"],
  },
});
