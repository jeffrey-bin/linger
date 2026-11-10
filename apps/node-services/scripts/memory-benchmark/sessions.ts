// A benchmark history as the product would see it: each public session is one
// Room-day of messages, shaped like the TeamHub Sessionly collector's output.
// The owner (represented Human) is LongMemEval's user, or the first LoCoMo
// speaker; LongMemEval's assistant turns come from the owner's Another Me.
import type {
  AnotherMeSubject,
  RoomMessage,
  SessionlyCollection,
} from "../../src/memory/types.js";
import {
  type Corpus,
  type HistorySession,
  datasetClock,
  sha256,
} from "./datasets.js";
import type { Scope } from "./knowledge.js";

/** The identities one corpus is stored under, unique to its run state. */
export function corpusScope(stateRoot: string, corpus: Corpus): Scope {
  const suffix = sha256(`${stateRoot}\0${corpus.id}`).slice(0, 24);
  return {
    tenant_id: `tenant_bench_${suffix}`,
    user_artifact_owner_actor_id: `human_bench_${suffix}`,
    agent_id: `agent_bench_${suffix}`,
    agent_actor_id: `actor_bench_${suffix}`,
  };
}

/** The owner's display name: LongMemEval's user, or LoCoMo's first speaker. */
export function ownerName(corpus: Corpus): string {
  const first = corpus.sessions.flatMap((session) => session.turns)[0];
  return first?.role === "user" && first.speaker !== "user"
    ? first.speaker
    : "User";
}

export function anotherMeSubject(
  scope: Scope,
  corpus: Corpus,
): AnotherMeSubject {
  return {
    tenantId: scope.tenant_id,
    agentActorId: scope.agent_actor_id,
    agentManagementId: scope.agent_id,
    agentDisplayName: "Another Me",
    representedHumanActorId: scope.user_artifact_owner_actor_id,
    representedHumanDisplayName: ownerName(corpus),
    representedHumanAccountId: null,
    memorySubjectKey: scope.agent_id,
  };
}

/** A session's start as Asia/Shanghai wall time, so its date stays the dataset day. */
export function sessionStart(session: HistorySession): number {
  const { date, hour, minute } = datasetClock(session.date);
  return Date.parse(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  );
}

/** One non-empty public session as one Room-day collection. */
export function sessionCollection(
  scope: Scope,
  corpus: Corpus,
  position: number,
): SessionlyCollection {
  const session = corpus.sessions[position]!;
  if (!session.turns.length) throw new Error("A Room-day needs messages");
  const subject = anotherMeSubject(scope, corpus);
  const owner = subject.representedHumanDisplayName;
  const roomId = `room_${sha256(`${corpus.id}\0${position}\0${session.id}`).slice(0, 40)}`;
  const start = sessionStart(session);
  const messages: RoomMessage[] = session.turns.map((turn, index) => {
    const ownTurn =
      turn.speaker === owner || (owner === "User" && turn.role === "user");
    return {
      id: `message_${sha256(`${roomId}\0${index}`).slice(0, 32)}`,
      roomId,
      authorActorId:
        turn.role === "assistant"
          ? scope.agent_actor_id
          : ownTurn
            ? scope.user_artifact_owner_actor_id
            : `actor_${sha256(`${scope.tenant_id}\0${turn.speaker}`).slice(0, 24)}`,
      authorDisplayName:
        turn.role === "assistant"
          ? subject.agentDisplayName
          : ownTurn
            ? owner
            : turn.speaker,
      authorKind: turn.role === "assistant" ? "agent" : "human",
      messageKind: "text",
      body: turn.text,
      createdAt: new Date(start + index * 1000).toISOString(),
      attachments: [],
    };
  });
  const speakers = [...new Set(messages.map((m) => m.authorDisplayName))];
  const last = messages.at(-1)!;
  return {
    schemaVersion: 1,
    date: datasetClock(session.date).date,
    timeZone: "Asia/Shanghai",
    generatedAt: new Date(start).toISOString(),
    source: { teamhubDatabaseUrlSet: false, memoryRoot: "" },
    subjects: [subject],
    rooms: [
      {
        tenantId: scope.tenant_id,
        roomId,
        roomName: speakers.join(" & "),
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
