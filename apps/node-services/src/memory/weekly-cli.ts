import { closeMemoryDatabase } from "./database.js";
import { runWeeklyCli } from "./sync-runners.js";

runWeeklyCli(process.argv.slice(2))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeMemoryDatabase);
