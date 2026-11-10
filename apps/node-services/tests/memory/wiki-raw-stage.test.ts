import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseOptions } from "../../src/memory/options.js";
import { readSessionlyCheckpoint } from "../../src/memory/sessionly-checkpoint.js";
import { stageSessionRawForWiki } from "../../src/memory/sync-runners.js";
import {
  listRawSourcesForAgent,
  readRawSource,
} from "../../src/memory/search/source-store.js";
import type { SessionlyCollection } from "../../src/memory/types.js";

describe("unified Wiki Session ingestion", () => {
  it("stages complete Room Raw with each message's identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-raw-stage-"));
    try {
      const date = "2026-09-28";
      const subjectKey = "agent_alice";
      const collection: SessionlyCollection = {
        schemaVersion: 1,
        date,
        timeZone: "Asia/Shanghai",
        generatedAt: "2026-09-28T00:00:00Z",
        source: {
          teamhubDatabaseUrlSet: false,
          memoryRoot: root,
        },
        subjects: [
          {
            tenantId: "tenant_acme",
            agentActorId: "actor_agent",
            agentManagementId: subjectKey,
            agentDisplayName: "Alice agent",
            representedHumanActorId: "actor_alice",
            representedHumanDisplayName: "Alice",
            representedHumanAccountId: null,
            memorySubjectKey: subjectKey,
          },
        ],
        rooms: [
          {
            tenantId: "tenant_acme",
            roomId: "room_one",
            roomName: "Planning",
            agentActorId: "actor_agent",
            agentManagementId: subjectKey,
            representedHumanActorId: "actor_alice",
            memorySubjectKey: subjectKey,
            relation: {
              agentIsMember: true,
              representedHumanIsMember: true,
              agentIsCreator: false,
              representedHumanIsCreator: true,
              includedBecause: ["represented_human_member"],
            },
            messages: [
              {
                id: "message_one",
                roomId: "room_one",
                authorActorId: "actor_alice",
                authorDisplayName: "Alice",
                authorKind: "human",
                messageKind: "conversation",
                body: "Client Acme approved the launch plan.",
                createdAt: "2026-09-28T01:00:00Z",
                attachments: [],
              },
            ],
          },
        ],
        sourceCursor: {
          after: {
            messageId: "message_one",
            createdAt: "2026-09-28T01:00:00Z",
          },
        },
      };
      const options = parseOptions([
        "--date",
        date,
        "--memory-root",
        root,
        "--memory-subject-key",
        subjectKey,
      ]);
      const mismatched = structuredClone(collection);
      mismatched.rooms[0]!.representedHumanActorId = "actor_bob";
      await expect(stageSessionRawForWiki(options, mismatched)).rejects.toThrow(
        "Session evidence identity does not match its subject",
      );
      expect(await fs.readdir(root)).toEqual([]);
      collection.rooms[0]!.messages.push(
        {
          ...collection.rooms[0]!.messages[0]!,
          id: "message_other",
          authorActorId: "actor_bob",
          // Same display name must not erase the distinct author identity.
          body: "I prefer weekly reviews.",
        },
        {
          ...collection.rooms[0]!.messages[0]!,
          id: "message_agent",
          authorActorId: "actor_agent",
          authorKind: "agent",
          body: "I recommend Alice adopt weekly reviews.",
        },
      );
      await stageSessionRawForWiki(options, collection);

      const checkpoint = await readSessionlyCheckpoint(root, {
        date,
        memorySubjectKey: subjectKey,
        roomId: "room_one",
      });
      expect(checkpoint?.lastMessage.messageId).toBe("message_one");
      // The Wiki reads this Raw from the index as the Room's Session.
      const workspace = path.join(root, subjectKey);
      const [source] = await listRawSourcesForAgent(workspace, subjectKey);
      expect(source).toMatchObject({
        date,
        sourceKind: "room_message",
        sourceUri: "teamhub://rooms/room_one/messages",
        metadata: { room_id: "room_one" },
      });
      const raw = await readRawSource(workspace, source!);
      expect(raw).toContain("Client Acme approved the launch plan.");
      for (const [id, actor, kind] of [
        ["message_one", "actor_alice", "human"],
        ["message_other", "actor_bob", "human"],
        ["message_agent", "actor_agent", "agent"],
      ]) {
        expect(raw).toContain(
          `Message metadata: ${JSON.stringify({ message_id: id, author_actor_id: actor, author_kind: kind })}`,
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
