import { contextHostRoot } from "../paths.js";
// Restores an earlier memory.md version as the newest one:
//   pnpm --filter @linger/node-services memory:user-memory:rollback <memory-subject-key> <version>
import { loadAnotherMeSubjects } from "./collector.js";
import { closeMemoryDatabase, memoryDatabase } from "./database.js";
import { postgresUserMemoryStore } from "./user-memory.js";
import { projectUserMemory } from "./user-memory-sync.js";

const [subjectKey, version] = process.argv.slice(2);
if (!subjectKey || !/^[1-9][0-9]*$/u.test(version ?? ""))
  throw new Error(
    "Usage: memory:user-memory:rollback <memory-subject-key> <version>",
  );
const subject = (await loadAnotherMeSubjects()).find(
  (candidate) => candidate.memorySubjectKey === subjectKey,
);
if (!subject) throw new Error(`No AnotherMe subject ${subjectKey}`);
const owner = {
  tenantId: subject.tenantId,
  ownerActorId: subject.representedHumanActorId,
};
try {
  const store = postgresUserMemoryStore(memoryDatabase());
  const restored = await store.rollback(owner, Number(version));
  await projectUserMemory(contextHostRoot(), subjectKey, owner, store);
  console.log(`memory.md restored from v${version} as v${restored.version}`);
} finally {
  await closeMemoryDatabase();
}
