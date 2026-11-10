// Runs the live scenarios against xAI and reports aggregated metrics only.
// Transcripts go to the ignored runtime root for review.
//   LIVE_CONTEXT_FILE=<dump> XAI_TEST_API_KEY=... tsx acceptance/live-scenarios/cli.ts [reps] [filter]
// XAI_TEST_API_KEY keeps test traffic off the key real calls use: parallel
// test sessions on that key coincided with slow replies in real calls.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scenarioJobs, type Row } from "./scenarios.js";
import { loadContext, Session } from "./session.js";

const testKey = process.env.XAI_TEST_API_KEY?.trim();
const apiKey =
  testKey ||
  process.env.VOICE_RUNTIME_XAI_LIVE_API_KEY?.trim() ||
  process.env.XAI_API_KEY?.trim();
if (apiKey && !testKey)
  console.error(
    "XAI_TEST_API_KEY is not set: these scenarios share the key real Live calls use",
  );
const contextFile = process.env.LIVE_CONTEXT_FILE?.trim();
if (!apiKey || !contextFile) {
  console.error(
    "XAI_TEST_API_KEY (or XAI_API_KEY) and LIVE_CONTEXT_FILE are required",
  );
  process.exit(2);
}
const [repsArg = "3", filter = ""] = process.argv.slice(2);
const reps = Math.max(1, Number(repsArg) || 3);
const context = loadContext(contextFile);
const rows: Row[] = [];
const jobs = scenarioJobs(
  () => Session.open(apiKey, context),
  (row) => rows.push(row),
)
  .filter(([id]) => id.includes(filter))
  .flatMap(([id, run]) =>
    Array.from({ length: reps }, (_, rep) => ({ id, run, rep })),
  );
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      try {
        await job.run(job.rep);
      } catch (error) {
        rows.push({
          scenario: job.id,
          caseId: "error",
          rep: job.rep,
          transcript: [String(error)],
          metrics: {},
        });
      }
    }
  }),
);
rows.sort(
  (a, b) =>
    (a.scenario + a.caseId).localeCompare(b.scenario + b.caseId) ||
    a.rep - b.rep,
);
const out = join(
  process.cwd(),
  "../../.linger-runtime/live-scenarios",
  `${new Date().toISOString().replaceAll(":", "-")}.json`,
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(rows, null, 1));

const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.scenario} · ${row.caseId}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
for (const [key, group] of groups) {
  const summary: string[] = [];
  const names = [
    ...new Set(group.flatMap((row) => Object.keys(row.metrics))),
  ].sort();
  for (const name of names) {
    const values = group
      .map((row) => row.metrics[name])
      .filter((value) => value !== undefined);
    if (values.every((value) => typeof value === "boolean"))
      summary.push(`${name} ${values.filter(Boolean).length}/${values.length}`);
    else if (values.every((value) => typeof value === "number")) {
      const sorted = values.sort((a, b) => a - b);
      summary.push(
        `${name} med ${sorted[Math.floor((sorted.length - 1) / 2)]}`,
      );
    } else
      summary.push(
        `${name} ${values.map((value) => JSON.stringify(value)).join("|")}`,
      );
  }
  console.log(`${key} (${group.length}): ${summary.join("; ")}`);
}
console.log(`Transcripts: ${out}`);
