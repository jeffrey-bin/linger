// The Memory/Wiki lifecycle on a small known history, every stage in the
// product's order, checked as it goes:
//   Day 0 (connect): the Profile builds memory.md; the connected files are
//     indexed and initialize the Wiki.
//   Day 1 daytime: Room chats and a finished meeting are staged and indexed;
//     the meeting refreshes the Wiki on its own.
//   Night 1: the Wiki takes in the day's chats; the day read writes memory.md
//     and the Daily (with the Pocket Note); Tracking Items; Monday's Weekly.
//   Day 2 and night 2: a file edit and more chats, a corrected preference.
//   Finally the Another Me (memory.md plus knowledge search) answers questions
//   about every source, and a judge grades them.
// Product code runs in this process against a disposable database; model
// calls go to the LLM gateway. TeamHub admission and publication, the
// scheduler, the Computer and the Web are not part of it. See README.md.
//
// From apps/node-services:
//   node --env-file=../../.env --import tsx scripts/memory-benchmark/lifecycle.ts \
//     --out .local/memory-benchmark/lifecycle/<name> \
//     --database-url postgresql://postgres@127.0.0.1:<port>/memory_benchmark \
//     [--model openai/gpt-5.6-luna] [--judge-model openai/gpt-5.6-luna]
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import type { WikiChangeSet, WikiInput } from "../../src/llm-wiki/backend.js";
import { renderSessionSource } from "../../src/llm-wiki/wiki-session-source.js";
import { collectAndPersistDaily } from "../../src/memory/daily-cli.js";
import { NO_YESTERDAY_BASELINE_TEXT } from "../../src/memory/daily-report.js";
import { runDayRead } from "../../src/memory/day-read.js";
import { walkFiles } from "../../src/memory/fs-utils.js";
import {
  agentMemoryRoot,
  logicalMemoryPath,
  memoryFilePath,
} from "../../src/memory/paths.js";
import { recordingCollection } from "../../src/memory/recording-collector.js";
import { ensureMemoryScaffold } from "../../src/memory/scaffold.js";
import {
  documentRawSource,
  profileRawSource,
  sessionSourceText,
} from "../../src/memory/search/source-store.js";
import {
  collectWeekly,
  hasCurrentWeekEvidence,
  stageSessionRawForWiki,
  writeWeeklyReport,
} from "../../src/memory/sync-runners.js";
import {
  trackingSessionPath,
  type TrackingItem,
  type TrackingItemStore,
  updateTrackingItems,
} from "../../src/memory/tracking-items.js";
import type {
  AnotherMeSubject,
  RoomMessage,
  SessionlyCollection,
} from "../../src/memory/types.js";
import {
  renderUserMemory,
  type UserMemoryRevision,
} from "../../src/memory/user-memory.js";
import {
  syncProfileMemory,
  syncWeeklyMemory,
} from "../../src/memory/user-memory-sync.js";
import type { ModelCall } from "../../src/runtime-model-call.js";
import { createGatewayModelCall } from "../gateway-model-call.js";
import { type AnswerRecord, answerQuestion } from "./answer.js";
import { type Case, sha256 } from "./datasets.js";
import { calibrateJudge, type Judgment, judge, judgePrompt } from "./judge.js";
import {
  identityOf,
  indexReports,
  indexWikiPages,
  openMemoryWorkspace,
  readPages,
  readReports,
  type Scope,
  step,
  type StepResult,
} from "./knowledge.js";
import {
  ASKED_AT,
  ATLAS_BRIEF_V2,
  ATLAS_ROOM,
  CONNECTED,
  DAY0,
  DAY1,
  DAY2,
  type FixtureDocument,
  HUMAN,
  MEETING,
  POCKET_NOTES,
  PRIVATE_ROOM,
  PROFILE,
  QUESTIONS,
  ROOMS,
  WEEK_END,
  WEEK_START,
} from "./lifecycle-fixture.js";
import { inMemoryUserMemoryStore } from "./product.js";

// Memory's days follow the process time zone; the fixture is Asia/Shanghai.
process.env.TZ = "Asia/Shanghai";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    "database-url": { type: "string" },
    model: { type: "string", default: "openai/gpt-5.6-luna" },
    "judge-model": { type: "string", default: "openai/gpt-5.6-luna" },
  },
});
if (!args.out) throw new Error("--out is required; see the header");
const databaseUrl =
  args["database-url"] ?? process.env.MEMORY_BENCHMARK_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "--database-url (or MEMORY_BENCHMARK_DATABASE_URL) is required",
  );
const out = path.resolve(args.out);
if ((await fs.readdir(out).catch(() => [])).length)
  throw new Error(`${out} is not empty; every lifecycle run starts fresh`);
await fs.mkdir(out, { recursive: true });
const started = performance.now();
const dataRoot = path.join(out, "memory");

const gateway = createGatewayModelCall({ model: args.model, concurrency: 4 });
const judgeGateway = createGatewayModelCall({
  model: args["judge-model"],
  concurrency: 4,
});
await calibrateJudge(judgeGateway.modelCall, "longmemeval");
const workspace = await openMemoryWorkspace({
  dataRoot,
  databaseUrl,
  modelCall: recorded(gateway.modelCall, path.join(out, "model-calls.jsonl")),
});
const { index, facts, wikiBackend } = workspace;

// One Another Me, unique to this run.
const suffix = sha256(out).slice(0, 24);
const scope: Scope = {
  tenant_id: `tenant_life_${suffix}`,
  user_artifact_owner_actor_id: `human_life_${suffix}`,
  agent_id: `agent_life_${suffix}`,
  agent_actor_id: `actor_life_${suffix}`,
};
const subject: AnotherMeSubject = {
  tenantId: scope.tenant_id,
  agentActorId: scope.agent_actor_id,
  agentManagementId: scope.agent_id,
  agentDisplayName: "Another Me",
  representedHumanActorId: scope.user_artifact_owner_actor_id,
  representedHumanDisplayName: HUMAN,
  representedHumanAccountId: null,
  memorySubjectKey: scope.agent_id,
  userProfileRevisionId: PROFILE.revisionId,
  userProfileMarkdown: PROFILE.markdown,
};
const owner = {
  tenantId: subject.tenantId,
  ownerActorId: subject.representedHumanActorId,
};
await ensureMemoryScaffold(dataRoot, [subject]);
// What TeamHub holds for this Human: the actor and the Pocket Note pages,
// which the nightly Daily reads from memory_source.pocket_notes.
await workspace.sql`
  INSERT INTO actors (id, tenant_id, kind, display_name)
  VALUES (${scope.user_artifact_owner_actor_id}, ${scope.tenant_id}, 'human', ${HUMAN})`;
for (const [date, body] of Object.entries(POCKET_NOTES))
  await workspace.sql`
    INSERT INTO pocket_notes (tenant_id, owner_actor_id, note_date, body)
    VALUES (${scope.tenant_id}, ${scope.user_artifact_owner_actor_id}, ${date}::date, ${body})`;
const revisions: UserMemoryRevision[] = [];
const memoryStore = inMemoryUserMemoryStore(revisions);
const tracking = new Map<string, TrackingItem>();
const trackingStore = inMemoryTrackingStore(tracking);

interface Check {
  stage: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const steps: { stage: string; name: string; result: StepResult }[] = [];

function check(stage: string, name: string, ok: boolean, detail: string) {
  checks.push({ stage, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${stage} · ${name}: ${detail}`);
}

async function run(stage: string, name: string, work: () => Promise<unknown>) {
  const result = await step(work);
  steps.push({ stage, name, result });
  check(
    stage,
    `${name} ran`,
    result.ok,
    result.ok
      ? `${result.seconds.toFixed(0)} s, ${result.attempts} attempt(s)`
      : (result.error ?? "failed"),
  );
  return result.ok;
}

const at = (date: string, time: string) => `${date}T${time}:00+08:00`;
const memoryText = () =>
  revisions.length ? renderUserMemory(revisions.at(-1)!.sections) : "";
const communication = () =>
  revisions.at(-1)?.sections.communication_and_working_style ?? [];

/** Asks the Another Me's search as its tool would; returns its items. */
async function searchKinds(query: string) {
  const response = await workspace.search(scope, { query });
  return response.items.map((item) => ({
    kind: item.source.kind,
    uri: String(item.metadata?.sourceUri ?? ""),
  }));
}

// --- Wiki publications -------------------------------------------------------

let wiki = path.join(out, "wiki", "0-empty");
let publications = 0;
await fs.mkdir(wiki, { recursive: true });
const inputs = path.join(out, "wiki-inputs");

/** One Wiki refresh over `changes`; a failure keeps the previous Wiki. */
async function refreshWiki(
  stage: string,
  label: string,
  changes: WikiChangeSet,
  publishedAt: string,
) {
  const next = path.join(out, "wiki", `${++publications}-${label}`);
  const mode = (await readPages(wiki)).length ? "update" : "initialize";
  const ok = await run(stage, `Wiki ${mode}`, async () => {
    await fs.rm(next, { recursive: true, force: true });
    await wikiBackend.generate({
      changes,
      generator: {
        tenantId: scope.tenant_id,
        agentActorId: scope.agent_actor_id,
      },
      existingOutputDirectory: wiki,
      inputsDirectory: inputs,
      mode,
      outputDirectory: next,
      generationId: `${label}-${publications}`,
    });
  });
  if (!ok) {
    await fs.rm(next, { recursive: true, force: true });
    await fs.cp(wiki, next, { recursive: true });
  }
  wiki = next;
  const pages = await readPages(wiki);
  await indexWikiPages(index, scope, pages, () => publishedAt);
  await fs.rm(inputs, { recursive: true, force: true });
  return pages;
}

async function documentInput(document: FixtureDocument): Promise<WikiInput> {
  const assetKey = `${document.documentId}_${document.versionId}`;
  await fs.mkdir(path.join(inputs, assetKey), { recursive: true });
  await fs.writeFile(
    path.join(inputs, assetKey, "document.md"),
    document.markdown,
  );
  return {
    assetKey,
    contentPath: `${assetKey}/document.md`,
    contentSha256: sha256(document.markdown),
    sourceUrl: `document://${document.documentId}/versions/${document.versionId}`,
    title: document.filename,
  };
}

async function sessionInput(
  collection: SessionlyCollection,
): Promise<WikiInput> {
  const room = collection.rooms[0]!;
  const recording = collection.recording;
  const { markdown, routing } = renderSessionSource(
    room.roomName,
    sessionSourceText(collection),
    {
      kind: recording ? "recording" : "room",
      date: collection.date,
      sessionId: recording ? recording.captureId : room.roomId,
      roomId: room.roomId,
      ...(recording
        ? {
            transcriptDocumentId: recording.documentId,
            transcriptDocumentVersionId: recording.documentVersionId,
          }
        : {}),
      representedHumanActorId: subject.representedHumanActorId,
      representedHumanDisplayName: subject.representedHumanDisplayName,
    },
  );
  const assetKey = recording
    ? recording.captureId
    : `${room.roomId}_${collection.date}`;
  await fs.mkdir(path.join(inputs, assetKey), { recursive: true });
  await fs.writeFile(path.join(inputs, assetKey, "document.md"), markdown);
  return {
    assetKey,
    contentPath: `${assetKey}/document.md`,
    contentSha256: sha256(markdown),
    sourceUrl: recording
      ? `document://${recording.documentId}/versions/${recording.documentVersionId}`
      : `document://${room.roomId}/versions/${collection.date}`,
    title: room.roomName,
    session: routing,
  };
}

// --- Sources -----------------------------------------------------------------

/** A connected file as Memory indexes it from TeamHub's document text. */
async function indexDocument(document: FixtureDocument, date: string) {
  const source = documentRawSource({
    identity: identityOf(scope),
    documentId: document.documentId,
    textSourceKind: "file_version",
    textSourceId: document.versionId,
    title: document.filename.replace(/\.\w+$/u, ""),
    filename: document.filename,
    mediaType: "text/markdown",
    markdown: document.markdown,
    date,
    originKind: document.origin,
  });
  await index.indexDatabaseSource(source, document.markdown);
}

/** One Room's messages of one day, as the Sessionly collector shapes them. */
function roomCollection(roomId: string, date: string): SessionlyCollection {
  const room = ROOMS.find((candidate) => candidate.roomId === roomId)!;
  const messages: RoomMessage[] = room.days[date]!.map((message, position) => {
    const human = message.author === "human";
    const agent = message.author === "agent";
    return {
      id: `message_${sha256(`${roomId}\0${date}\0${position}`).slice(0, 32)}`,
      roomId,
      authorActorId: human
        ? scope.user_artifact_owner_actor_id
        : agent
          ? scope.agent_actor_id
          : `actor_${sha256(message.author).slice(0, 24)}`,
      authorDisplayName: human ? HUMAN : agent ? "Another Me" : message.author,
      authorKind: agent ? "agent" : "human",
      messageKind: "text",
      body: message.text,
      createdAt: new Date(at(date, message.at)).toISOString(),
      attachments: [],
    };
  });
  const last = messages.at(-1)!;
  return {
    schemaVersion: 1,
    date,
    timeZone: "Asia/Shanghai",
    generatedAt: last.createdAt,
    source: { teamhubDatabaseUrlSet: false, memoryRoot: dataRoot },
    subjects: [subject],
    rooms: [
      {
        tenantId: scope.tenant_id,
        roomId,
        roomName: room.name,
        agentActorId: scope.agent_actor_id,
        agentManagementId: scope.agent_id,
        representedHumanActorId: scope.user_artifact_owner_actor_id,
        memorySubjectKey: scope.agent_id,
        relation: {
          agentIsMember: true,
          representedHumanIsMember: true,
          agentIsCreator: false,
          representedHumanIsCreator: true,
          includedBecause: ["represented_human_member"],
        },
        messages,
      },
    ],
    sourceCursor: {
      after: { messageId: last.id, createdAt: last.createdAt },
    },
  };
}

function meetingCollection(): SessionlyCollection {
  const transcript = MEETING.transcript;
  return recordingCollection(
    { memoryRoot: dataRoot },
    subject,
    {
      captureId: MEETING.captureId,
      documentId: MEETING.transcriptDocumentId,
      documentVersionId: MEETING.transcriptVersionId,
      sha256: sha256(transcript),
      startedAt: new Date(at(MEETING.date, MEETING.startedAt)).toISOString(),
      endedAt: new Date(at(MEETING.date, MEETING.endedAt)).toISOString(),
      readyAt: new Date(at(MEETING.date, MEETING.readyAt)).toISOString(),
      tenantId: scope.tenant_id,
      roomId: MEETING.roomId,
      roomName: MEETING.roomName,
      date: MEETING.date,
      sizeBytes: Buffer.byteLength(transcript),
      creatorId: scope.user_artifact_owner_actor_id,
      creatorName: HUMAN,
      agentIsMember: true,
      humanIsMember: true,
    },
    transcript,
  );
}

/** The Room-quiet and recording triggers: stage, then index Raw and facts. */
async function stageDaytime(collections: SessionlyCollection[]) {
  for (const collection of collections)
    await stageSessionRawForWiki(
      {
        date: collection.date,
        memoryRoot: dataRoot,
        memorySubjectKey: scope.agent_id,
        concurrency: 1,
      },
      collection,
    );
  await index.syncAgent(scope.agent_id);
  return facts.syncAgent(scope.agent_id);
}

// --- Nights ------------------------------------------------------------------

/**
 * The nightly `daily` step after the Wiki: the day read (memory.md, then the
 * Daily, with the day's Pocket Note), Tracking Items from the day's evidence,
 * and the indexing of the new report and the staged note.
 */
async function nightDaily(stage: string, date: string) {
  const options = {
    date,
    memoryRoot: dataRoot,
    memorySubjectKey: scope.agent_id,
    concurrency: 1,
    subject,
  };
  await run(stage, "day read (memory.md and Daily)", async () => {
    const collection = await collectAndPersistDaily(options);
    await runDayRead(options, collection, memoryStore);
  });
  await run(stage, "Tracking Items", async () => {
    const sessions: { path: string; content: string }[] = [];
    for await (const file of walkFiles(
      memoryFilePath(dataRoot, scope.agent_id, "evidence", date, "sessions"),
    ))
      if (file.endsWith(".md"))
        sessions.push({
          path: trackingSessionPath(
            logicalMemoryPath(dataRoot, scope.agent_id, file),
          ),
          content: await fs.readFile(file, "utf8"),
        });
    await updateTrackingItems(
      { owner, humanName: HUMAN, date, sessions },
      trackingStore,
    );
  });
  await index.syncAgent(scope.agent_id);
  await indexReports(
    index,
    scope,
    "daily",
    await readReports(timeline("daily")),
  );
}

const timeline = (collection: "daily" | "weekly") =>
  path.join(agentMemoryRoot(dataRoot, scope.agent_id), "timeline", collection);
const readReport = (collection: "daily" | "weekly", date: string) =>
  fs
    .readFile(path.join(timeline(collection), `${date}.md`), "utf8")
    .catch(() => "");
const mentions = (pages: { content: string }[], text: string) =>
  pages.filter((page) => page.content.includes(text)).length;
const openItems = () =>
  [...tracking.values()].filter((item) => item.status === "open");

// --- Day 0: connect ----------------------------------------------------------

console.log(`Day 0 ${DAY0}: connect`);
await index.indexDatabaseSource(
  profileRawSource({
    identity: identityOf(scope),
    revisionId: PROFILE.revisionId,
    date: DAY0,
    markdown: PROFILE.markdown,
  }),
  PROFILE.markdown,
);
await run("Day 0", "Profile → memory.md", () =>
  syncProfileMemory(dataRoot, subject, DAY0, memoryStore),
);
check(
  "Day 0",
  "memory.md built from the Profile",
  revisions.length === 1 &&
    revisions[0]!.baseProfileRevisionId === PROFILE.revisionId &&
    memoryText().includes("Lumen"),
  `version ${revisions.length}, base ${revisions[0]?.baseProfileRevisionId ?? "none"}, mentions Lumen: ${memoryText().includes("Lumen")}`,
);
for (const document of CONNECTED) await indexDocument(document, DAY0);
let pages = await refreshWiki(
  "Day 0",
  "init",
  {
    added: await Promise.all(CONNECTED.map(documentInput)),
    modified: [],
    removed: [],
  },
  at(DAY0, "18:00"),
);
check(
  "Day 0",
  "Wiki initialized from the connected files",
  pages.some((page) => /^projects\/.*atlas/iu.test(page.key)) &&
    mentions(pages, "Northwind") > 0 &&
    mentions(pages, "Hannah Lee") > 0,
  `${pages.length} pages: ${pages.map((page) => page.key).join(", ")}`,
);
check(
  "Day 0",
  "Wiki pages cite the connected files",
  CONNECTED.every((document) => mentions(pages, document.documentId) > 0),
  CONNECTED.map(
    (document) =>
      `${document.documentId} cited by ${mentions(pages, document.documentId)}`,
  ).join(", "),
);
const mailHits = await searchKinds("milestone payments statement of work");
check(
  "Day 0",
  "connected mail is searchable",
  mailHits.some((hit) => hit.kind === "mail"),
  mailHits.map((hit) => hit.kind).join(", ") || "no candidates",
);

// --- Day 1 daytime -----------------------------------------------------------

console.log(`Day 1 ${DAY1}: daytime`);
const day1Chats = [
  roomCollection(ATLAS_ROOM, DAY1),
  roomCollection(PRIVATE_ROOM, DAY1),
];
const meeting = meetingCollection();
const day1Facts = await stageDaytime([...day1Chats, meeting]);
const chatHits = await searchKinds("revised SOW milestone payments Wednesday");
check(
  "Day 1 daytime",
  "today's chat is searchable before the night",
  chatHits.some((hit) => hit.kind === "room" && hit.uri.includes(ATLAS_ROOM)),
  chatHits.map((hit) => `${hit.kind} ${hit.uri}`).join("; ") || "no candidates",
);
check(
  "Day 1 daytime",
  "Session facts extracted",
  JSON.stringify(day1Facts).includes('"failed":0') ||
    !JSON.stringify(day1Facts).includes('"failed"'),
  JSON.stringify(day1Facts),
);
pages = await refreshWiki(
  "Day 1 daytime",
  "meeting",
  { added: [await sessionInput(meeting)], modified: [], removed: [] },
  at(DAY1, "15:50"),
);
const meetingPage = `sessions/${DAY1}/${MEETING.captureId}.md`;
check(
  "Day 1 daytime",
  "the meeting has its Session page and entity pages",
  pages.some((page) => page.key === meetingPage) &&
    mentions(pages, "Priya") > 1,
  `${meetingPage}: ${pages.some((page) => page.key === meetingPage)}; pages mentioning Priya: ${mentions(pages, "Priya")}`,
);
check(
  "Day 1 daytime",
  "the meeting refresh leaves chats out",
  !pages.some(
    (page) => page.key.startsWith("sessions/") && page.key.includes("room_"),
  ) && mentions(pages, ATLAS_ROOM) === 0,
  `chat Session pages: ${pages.filter((page) => page.key.startsWith("sessions/") && page.key.includes("room_")).length}, pages citing the Atlas chat: ${mentions(pages, ATLAS_ROOM)}`,
);

// --- Night 1 -----------------------------------------------------------------

console.log(`Night 1 (${DAY1} closes)`);
pages = await refreshWiki(
  "Night 1",
  "night-1",
  {
    added: await Promise.all(day1Chats.map(sessionInput)),
    modified: [],
    removed: [],
  },
  at(DAY2, "00:30"),
);
check(
  "Night 1",
  "the Wiki takes in the day's chats without chat Session pages",
  mentions(pages, `teamhub://rooms/${ATLAS_ROOM}/messages`) > 0 &&
    !pages.some(
      (page) => page.key.startsWith("sessions/") && page.key.includes("room_"),
    ),
  `pages citing the Atlas chat: ${mentions(pages, `teamhub://rooms/${ATLAS_ROOM}/messages`)}`,
);
const memoryBeforeNight1 = revisions.length;
await nightDaily("Night 1", DAY1);
const daily1 = await readReport("daily", DAY1);
check(
  "Night 1",
  "Daily cites the day's Rooms, the meeting and the Pocket Note",
  daily1.includes(`teamhub://rooms/${ATLAS_ROOM}`) &&
    daily1.includes(`teamhub://pocket-notes/${DAY1}`) &&
    daily1.includes(MEETING.transcriptDocumentId),
  daily1
    ? (daily1.match(/resource: .*/gu) ?? []).join("; ")
    : "no Daily written",
);
check(
  "Night 1",
  "first Daily states it has no yesterday baseline",
  daily1.includes(NO_YESTERDAY_BASELINE_TEXT),
  daily1.includes(NO_YESTERDAY_BASELINE_TEXT) ? "present" : "missing",
);
check(
  "Night 1",
  "memory.md takes in the stated preference",
  revisions.length > memoryBeforeNight1 &&
    communication().some((entry) => /bullet/iu.test(entry.text)),
  `version ${revisions.length}; Communication: ${
    communication()
      .map((entry) => entry.text)
      .join(" | ") || "empty"
  }`,
);
check(
  "Night 1",
  "Tracking Items hold the SOW commitment",
  openItems().some((item) => /SOW|statement of work/iu.test(item.content)),
  openItems()
    .map((item) => item.content)
    .join(" | ") || "no open items",
);
const memoryBeforeWeekly = revisions.length;
let weeklyWritten = false;
// runWeeklyCli's steps for one Another Me, after the week's Dailies.
await run("Night 1", "Weekly (Monday)", async () => {
  const options = {
    date: DAY2,
    memoryRoot: dataRoot,
    memorySubjectKey: scope.agent_id,
    concurrency: 1,
    weekStart: WEEK_START,
  };
  const collection = await collectWeekly(options, scope.agent_id);
  if (!hasCurrentWeekEvidence(collection)) return;
  weeklyWritten = Boolean(
    await writeWeeklyReport("run", options, subject, collection),
  );
  if (weeklyWritten)
    await syncWeeklyMemory(
      dataRoot,
      subject,
      { start: WEEK_START, end: WEEK_END },
      memoryStore,
    );
});
await indexReports(
  index,
  scope,
  "weekly",
  await readReports(timeline("weekly")),
);
const weekly = await readReport("weekly", WEEK_START);
check(
  "Night 1",
  "Weekly written from the week's Daily",
  weeklyWritten && weekly.includes(DAY1),
  `written: ${weeklyWritten}; memory.md ${memoryBeforeWeekly} → ${revisions.length}`,
);

// --- Day 2 and night 2 -------------------------------------------------------

console.log(`Day 2 ${DAY2}: daytime and night`);
await indexDocument(ATLAS_BRIEF_V2, DAY2);
const day2Chats = [
  roomCollection(ATLAS_ROOM, DAY2),
  roomCollection(PRIVATE_ROOM, DAY2),
];
await stageDaytime(day2Chats);
pages = await refreshWiki(
  "Night 2",
  "night-2",
  {
    added: await Promise.all(day2Chats.map(sessionInput)),
    modified: [await documentInput(ATLAS_BRIEF_V2)],
    removed: [],
  },
  at("2026-11-03", "00:30"),
);
check(
  "Night 2",
  "the Wiki takes in the edited file",
  mentions(pages, ATLAS_BRIEF_V2.versionId) > 0 &&
    mentions(pages, "210,000") > 0,
  `pages citing the new version: ${mentions(pages, ATLAS_BRIEF_V2.versionId)}, mentioning 210,000: ${mentions(pages, "210,000")}`,
);
const memoryBeforeNight2 = revisions.length;
await nightDaily("Night 2", DAY2);
const daily2 = await readReport("daily", DAY2);
check(
  "Night 2",
  "second Daily compares with yesterday",
  Boolean(daily2) && !daily2.includes(NO_YESTERDAY_BASELINE_TEXT),
  daily2 ? "written with a baseline" : "no Daily written",
);
const negated = /\b(no|not|without|instead|stop|rather than|replac)/iu;
check(
  "Night 2",
  "memory.md replaces the corrected preference",
  revisions.length > memoryBeforeNight2 &&
    communication().some((entry) => /paragraph/iu.test(entry.text)) &&
    communication()
      .filter((entry) => /bullet/iu.test(entry.text))
      .every((entry) => negated.test(entry.text)),
  `version ${revisions.length}; Communication: ${
    communication()
      .map((entry) => entry.text)
      .join(" | ") || "empty"
  }`,
);
check(
  "Night 2",
  "the signed SOW closes its Tracking Item",
  !openItems().some((item) => /SOW|statement of work/iu.test(item.content)),
  `open: ${
    openItems()
      .map((item) => item.content)
      .join(" | ") || "none"
  }`,
);

// --- Questions ---------------------------------------------------------------

console.log(`Questions at ${ASKED_AT}`);
const memory = { version: revisions.length, markdown: memoryText() };
const answers: {
  id: string;
  source: string;
  question: string;
  gold: string;
  record?: AnswerRecord;
  judgment?: Judgment;
  error?: string;
}[] = [];
await Promise.all(
  QUESTIONS.map(async (question) => {
    const item: Case = {
      id: question.id,
      benchmark: "longmemeval",
      type: question.type,
      question: question.question,
      askedAt: new Date(ASKED_AT).toISOString(),
      answer: question.answer,
      unanswerable: question.unanswerable ?? false,
      corpus: { id: "lifecycle", sessions: [] },
    };
    const entry: (typeof answers)[number] = {
      id: question.id,
      source: question.source,
      question: question.question,
      gold: question.answer,
    };
    try {
      entry.record = await answerQuestion({
        item,
        arm: "product",
        prepared: { scope, wiki_scope: scope, memory },
        product: workspace,
        model: args.model,
      });
      entry.judgment = await judge(
        judgeGateway.modelCall,
        `lifecycle:${question.id}`,
        judgePrompt(item, entry.record.answer),
      );
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    answers.push(entry);
    check(
      "Questions",
      `${question.id} (${question.source})`,
      entry.judgment?.correct === true,
      entry.error ??
        `${entry.record!.tool_calls.length} tool calls; ${entry.judgment!.reason}`,
    );
  }),
);
answers.sort(
  (a, b) =>
    QUESTIONS.findIndex((q) => q.id === a.id) -
    QUESTIONS.findIndex((q) => q.id === b.id),
);
await workspace.close();

// --- Report ------------------------------------------------------------------

const failed = checks.filter((item) => !item.ok);
const seconds = (performance.now() - started) / 1000;
await fs.writeFile(path.join(out, "memory.md"), memoryText() || "(empty)\n");
await fs.writeFile(
  path.join(out, "tracking.json"),
  JSON.stringify([...tracking.values()], null, 2),
);
await fs.writeFile(
  path.join(out, "summary.json"),
  JSON.stringify(
    {
      checks,
      steps,
      answers,
      memory_versions: revisions.length,
      wiki_pages: pages.map((page) => page.key),
      model_usage: { product: gateway.usage, judge: judgeGateway.usage },
      seconds,
    },
    null,
    2,
  ),
);
const escape = (text: string) =>
  text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
const lines = [
  `# Memory lifecycle: ${checks.length - failed.length}/${checks.length} checks passed`,
  "",
  `- Model ${args.model}, judge ${args["judge-model"]}; ${Math.round(seconds)} s; ${gateway.usage.calls} product model calls`,
  `- Final Wiki: ${pages.length} pages; memory.md version ${revisions.length}; ${tracking.size} Tracking Items`,
  "",
  "| Stage | Check | Result | Detail |",
  "| --- | --- | --- | --- |",
  ...checks.map(
    (item) =>
      `| ${item.stage} | ${escape(item.name)} | ${item.ok ? "pass" : "**fail**"} | ${escape(item.detail.slice(0, 300))} |`,
  ),
  "",
  "## Answers",
  "",
  ...answers.flatMap((entry) => [
    `### ${entry.id} (${entry.source}): ${entry.judgment?.correct ? "correct" : "wrong"}`,
    "",
    `- Question: ${entry.question}`,
    `- Expected: ${entry.gold}`,
    `- Answer: ${escape(entry.record?.answer ?? entry.error ?? "")}`,
    "",
  ]),
];
await fs.writeFile(path.join(out, "report.md"), `${lines.join("\n")}\n`);
console.log(
  `\n${lines.slice(0, 3).join("\n")}\nWrote ${path.join(out, "report.md")}`,
);
process.exitCode = failed.length ? 1 : 0;

function inMemoryTrackingStore(
  items: Map<string, TrackingItem>,
): TrackingItemStore {
  let ids = 0;
  return {
    list: async () => [...items.values()],
    apply: async (_owner, changes) => {
      const now = new Date().toISOString();
      const applied: TrackingItem[] = [];
      for (const create of changes.create) {
        const { idempotency_key: _key, ...fields } = create;
        const item: TrackingItem = {
          ...fields,
          id: `t${++ids}`,
          status: "open",
          created_at: now,
          updated_at: now,
          revision: 1,
          routines: [],
        };
        items.set(item.id, item);
        applied.push(item);
      }
      for (const update of changes.update) {
        const current = items.get(update.id);
        if (!current) continue;
        const { expected_revision: _revision, ...fields } = update;
        const item = {
          ...current,
          ...fields,
          updated_at: now,
          revision: current.revision + 1,
        };
        items.set(item.id, item);
        applied.push(item);
      }
      for (const removed of changes.delete) items.delete(removed.id);
      return {
        items: applied,
        deleted: changes.delete.map((removed) => removed.id),
      };
    },
    plan: async () => undefined,
  };
}

/** Appends every structured call's key, input and output to `file`. */
function recorded(inner: ModelCall, file: string): ModelCall {
  const record = async <T extends { output: unknown }>(
    key: string,
    request: { schemaName: string; instructions?: string; input: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    const result = await run();
    await fs.appendFile(
      file,
      `${JSON.stringify({ key, schema: request.schemaName, instructions: request.instructions, input: request.input, output: result.output })}\n`,
    );
    return result;
  };
  return {
    ...inner,
    call: (request) => record(request.key, request, () => inner.call(request)),
    chain: (spec, body) =>
      inner.chain(spec, (chain) =>
        body({
          ...chain,
          call: (request) =>
            record(`${spec.key}/${request.step}`, request, () =>
              chain.call(request),
            ),
        }),
      ),
  };
}
