import { performance } from "node:perf_hooks";
import { createTiming } from "./timing.js";

const entryAt = performance.now();
const timing = createTiming(process.env);
timing?.record("node_to_entry", entryAt);
const bundleStarted = performance.now();
const { runCli } = await import("./cli.js");
timing?.record("bundle_load", performance.now() - bundleStarted);

// Stream write callbacks report EPIPE; leave it to runCli to retain the receipt.
process.stdout.on("error", () => undefined);
// Optional diagnostics cannot turn an emitted business success into failure.
if (timing) process.stderr.on("error", () => undefined);

const commandStarted = performance.now();
process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  fetch: globalThis.fetch,
  timing,
  stdout: (value) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(value, (error) =>
        error ? reject(error) : resolve(),
      );
    }),
  stderr: (value) => {
    process.stderr.write(value);
  },
});
timing?.record("command", performance.now() - commandStarted, {
  outcome: process.exitCode === 0 ? "success" : "failure",
});
if (timing && !(await timing.flush())) {
  try {
    process.stderr.write("TeamHub timing output could not be saved.\n");
  } catch {
    /* A closed diagnostic stream is not a business failure. */
  }
}
