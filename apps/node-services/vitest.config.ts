import { configDefaults, defineConfig } from "vitest/config";

const AGENT_PROCESS_TEST = "tests/agent/executor/agent-manager-process.test.ts";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    // Real OCR workers run alongside the existing process tests.
    maxWorkers: 2,
    testTimeout: 5_000,
    environment: "node",
    // Memory's days follow the process time zone; pin one so dates in tests
    // hold on every machine. A test that needs another zone stubs TZ.
    env: { TZ: "Asia/Shanghai" },
    projects: [
      {
        extends: true,
        test: {
          name: "roles",
          include: ["tests/**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude,
            "tests/agent/**",
            "tests/document/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "agent",
          include: ["tests/agent/**/*.test.ts"],
          exclude: [...configDefaults.exclude, AGENT_PROCESS_TEST],
        },
      },
      {
        // Document Runtime tests drive real WebSocket and HTTP servers, so
        // they run one file at a time after the other roles' tests.
        extends: true,
        test: {
          name: "document",
          include: ["tests/document/**/*.test.ts"],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        // The real Agent Service process test runs alone, after every other
        // suite, so load from the parallel pool cannot delay its startup.
        extends: true,
        test: {
          name: "agent-process",
          include: [AGENT_PROCESS_TEST],
          fileParallelism: false,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
