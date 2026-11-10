import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { hugeiconsPerIconImports } from "./vitest.hugeicons-imports";

export default defineConfig({
  plugins: [react(), hugeiconsPerIconImports()],
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    setupFiles: ["src/test/setup.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.build.test.ts"],
    // Four workers leave room for the dev stack.
    maxWorkers: 4,
    // Threads share one process: about half the system CPU of forks.
    pool: "threads",
    // Logic tests (.ts) skip the jsdom environment; a .ts file that needs the
    // DOM opts in with `// @vitest-environment jsdom`.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
