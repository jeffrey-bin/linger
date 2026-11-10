import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 5_000,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
