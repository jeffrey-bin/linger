import { runServiceProcess } from "../../../src/process-lifecycle.js";
import {
  closeAgentLogs,
  flushAgentLogs,
  logAgentEvent,
  setAgentLogDirectory,
} from "../../../src/agent/observability/agent-log.js";

const mode = process.argv[2];
setAgentLogDirectory(process.env.FIXTURE_LOG_DIRECTORY);
await runServiceProcess(async ({ signal, progress, onExit }) => {
  // The Agent role registers the same drain (src/agent/main.ts).
  onExit((budgetMs) => closeAgentLogs(budgetMs));
  // Deliberately retain a handle: success and timeout must actually exit.
  setInterval(() => undefined, 1_000);
  if (mode === "success") {
    logAgentEvent("info", "fixture.started");
    if (!(await flushAgentLogs(5_000)))
      throw new Error("Fixture log startup failed");
  }
  console.log("fixture-ready");
  if (mode === "startup") {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
  }
  return {
    close: async () => {
      progress("fixture", "started");
      console.log("fixture-closing");
      if (mode === "hang") await new Promise(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "failure") throw new Error("fixture cleanup failed");
      progress("fixture", "completed");
      for (let i = 0; i < (mode === "slow-log" ? 10 : 1); i++)
        logAgentEvent("info", "fixture.closed");
    },
  };
}, 300);
