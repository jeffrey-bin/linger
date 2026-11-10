import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Real Vite/Rollup production builds run here, outside the jsdom unit suite.
export default defineConfig({
  plugins: [react()],
  test: {
    testTimeout: 120_000,
    environment: "node",
    include: ["src/**/*.build.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
