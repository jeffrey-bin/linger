import { createWikiIndex } from "./wiki-index.js";
import { FlashbackService } from "./flashback/service.js";
import { readMemoryConfig } from "./config.js";
import {
  isRebuildStep,
  MEMORY_SCHEDULER_FALLBACK_MS,
  MemoryScheduler,
  type MemoryPeriodicWork,
} from "./scheduler.js";
import {
  openPostgresCalendarStore,
  postgresSessionTriggerStore,
} from "./scheduler-state.js";
import { rebuildHoldsOwner, runRebuildStep } from "./rebuild.js";
import { setMemoryLogger, writeMemoryLog } from "./run-telemetry.js";
import { SessionTriggerMonitor } from "./session-triggers.js";
import { startMemoryServer } from "./server.js";
import { runMemoryTask } from "./tasks.js";
import {
  CHUNK_SYNC_INTERVAL_MS,
  createMemoryChunkIndexFromEnvironment,
} from "./chunk-index.js";
import { createSessionFactIndexFromEnvironment } from "./session-fact-index.js";
import { closeMemoryDatabase, memoryDatabase } from "./database.js";
import { migrateMemoryLayout } from "./migrate-memory-layout.js";
import { pruneMemoryFiles } from "./file-retention.js";
import type { Flashback } from "../flashback.js";
import type { ModelCall } from "../runtime-model-call.js";
import { setMemoryModelCall } from "./llm.js";
import { updatePocketNoteTrackingItems } from "./tracking-items.js";
import { syncProfileMemoryForOwner } from "./user-memory-sync.js";
import type { HttpHost } from "../http-host.js";
import { type JsonLogger } from "@linger/service-kit/node";

export async function startMemoryService({
  http,
  logger,
  modelCall,
}: {
  http: HttpHost;
  logger: JsonLogger;
  /** The agent role's model call once it has started in this process. */
  modelCall: () => ModelCall | undefined;
}): Promise<{
  /** Another Me flashback, which the host hands to the agent role. */
  flashback: Flashback;
  stop(): Promise<void>;
}> {
  setMemoryLogger(logger);
  setMemoryModelCall(modelCall);
  const config = readMemoryConfig();
  // Every Memory source and the scheduler's own state live in TeamHub's
  // database, so the role does not start without it.
  const calendar = await openPostgresCalendarStore(memoryDatabase());
  await migrateMemoryLayout(config.dataRoot);
  const chunkIndex = createMemoryChunkIndexFromEnvironment(config.dataRoot);
  // The published Wiki and the Daily and Weekly reports are sources of the
  // same index.
  const wikiIndex = createWikiIndex(chunkIndex, config.dataRoot);
  const sessionFacts = createSessionFactIndexFromEnvironment();
  chunkIndex.factIndex = sessionFacts;
  // Session facts are extracted from indexed Raw, beside Wiki generation.
  chunkIndex.afterAgentSync = async (agentId) =>
    writeMemoryLog("memory_session_facts_synced", {
      agent_id: agentId,
      ...(await sessionFacts.syncAgent(agentId)),
    });
  const triggers: SessionTriggerMonitor = new SessionTriggerMonitor(
    config.dataRoot,
    postgresSessionTriggerStore(memoryDatabase()),
    (input, period, reason, isReady) =>
      scheduler.runTarget(input, period, reason, isReady),
  );
  // The scheduler's one timer drives every periodic Memory pass.
  const periodic: MemoryPeriodicWork[] = [
    {
      name: "session_triggers",
      everyMs: MEMORY_SCHEDULER_FALLBACK_MS,
      run: (now) => triggers.poll(now),
    },
    {
      name: "file_retention",
      everyMs: 24 * 60 * 60_000,
      run: async () => {
        try {
          await pruneMemoryFiles(config.dataRoot);
        } catch (error) {
          logger.log("error", "memory.file_retention_failed", { error });
        }
      },
    },
    {
      name: "report_reconcile",
      everyMs: MEMORY_SCHEDULER_FALLBACK_MS,
      run: () => wikiIndex.reconcile(),
    },
    {
      name: "raw_chunk_sync",
      everyMs: CHUNK_SYNC_INTERVAL_MS,
      run: async () => {
        await chunkIndex.syncAll();
      },
    },
  ];
  const scheduler: MemoryScheduler = new MemoryScheduler(
    config.schedule,
    (input, reason, subjectLane, period) =>
      isRebuildStep(input)
        ? runRebuildStep(input, { raw: chunkIndex, wiki: wikiIndex })
        : runMemoryTask(config.dataRoot, input, undefined, undefined, {
            indexSessionRaw: (agentId) => chunkIndex.syncRawSources(agentId),
            rebuild: reason === "rebuild",
            nightly: reason === "hourly" && period.endsWith("T00"),
            subjectLane,
            // The scheduler's periodic report reconciliation retries a
            // failure, so a failed index does not fail the report task.
            indexPeriodReports: (memorySubjectKey, kind) =>
              wikiIndex
                .indexReports(memorySubjectKey, kind)
                .catch((error: unknown) =>
                  logger.log("error", "memory.report_index_failed", {
                    memory_subject_key: memorySubjectKey,
                    collection: kind,
                    error,
                  }),
                ),
          }),
    periodic,
    calendar,
  );
  const indexHold = (agentId: string) => scheduler.rebuildHolds().has(agentId);
  chunkIndex.indexHold = indexHold;
  wikiIndex.indexHold = indexHold;
  const flashback = new FlashbackService(config.dataRoot);
  scheduler.start();
  const server = await startMemoryServer({
    dataRoot: config.dataRoot,
    http,
    scheduler,
    serviceToken: config.serviceToken,
    chunkSearch: chunkIndex,
    chunkFailures: chunkIndex,
    onPocketNoteChanged: async (change) => {
      // A rebuilding Human gets Tracking Items from its replayed Dailies.
      if (
        await rebuildHoldsOwner(scheduler.rebuildHolds(), change.owner_actor_id)
      ) {
        writeMemoryLog("memory_rebuild_index_hold_skipped", {
          owner_actor_id: change.owner_actor_id,
          index: "pocket_note_tracking",
        });
        return;
      }
      await updatePocketNoteTrackingItems(
        change.tenant_id,
        change.owner_actor_id,
        change.date,
      );
    },
    // A rebuild replays days onto memory.md without resetting it, so a
    // Profile published meanwhile is taken in at once; versions keep the two
    // writers apart.
    onProfilePublished: async (change) => {
      await syncProfileMemoryForOwner(
        config.dataRoot,
        change.tenant_id,
        change.owner_actor_id,
      );
    },
    onWikiPublished: async (publication) => {
      // A rebuilding Human is indexed once more by its final rebuild step.
      if (
        await rebuildHoldsOwner(
          scheduler.rebuildHolds(),
          publication.owner_actor_id,
        )
      ) {
        writeMemoryLog("memory_rebuild_index_hold_skipped", {
          owner_actor_id: publication.owner_actor_id,
          index: "published_wiki",
        });
        return;
      }
      await wikiIndex.indexWiki(
        publication.tenant_id,
        publication.owner_actor_id,
      );
    },
    clearRebuildIndexes: (subject) =>
      wikiIndex.clearOwner(subject.tenantId, subject.representedHumanActorId),
  });

  const stop = async () => {
    scheduler.stop();
    await server.close();
    await wikiIndex.close();
    await chunkIndex.close();
    await closeMemoryDatabase();
  };
  return { flashback, stop };
}
