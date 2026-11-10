import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 5_000,
    maxWorkers: process.env.CI ? 4 : undefined,
    // Security fixtures require physical roots; macOS /var aliases /private/var.
    env: { TMPDIR: realpathSync(tmpdir()) },
    exclude: [
      ...configDefaults.exclude,
      ".worktrees/**",
      ".orchestrator/**",
      ".linger-runtime/**",
      ".pnpm-store/**",
    ],
  },
});
