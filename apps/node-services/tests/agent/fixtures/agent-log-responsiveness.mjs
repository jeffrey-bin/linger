import * as logs from "../../../src/agent/observability/agent-log.ts";

logs.setAgentLogDirectory(process.env.FIXTURE_LOG_DIRECTORY);
const started = performance.now();
const tick = new Promise((resolve) =>
  setTimeout(() => resolve(performance.now() - started), 0),
);
for (let index = 0; index < 10; index++)
  logs.logAgentEvent("info", "cold_restore.context", { index });
const timerMs = await tick;
const flushed =
  (await logs.closeAgentLogs?.(
    Number(process.env.FIXTURE_FLUSH_TIMEOUT_MS ?? 5_000),
  )) ?? true;
console.log(JSON.stringify({ probe: "responsiveness", timerMs, flushed }));
