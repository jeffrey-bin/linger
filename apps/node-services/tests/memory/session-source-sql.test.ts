import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoryRooms } from "../../src/memory/collector.js";
import { queryRoomActivity } from "../../src/memory/session-triggers.js";
import { queryRecordingCandidates } from "../../src/memory/recording-collector.js";
import type { AnotherMeSubject } from "../../src/memory/types.js";

// Explicit opt-in to a disposable database that TeamHub migrations created
// (`TEAMHUB_DATABASE_URL=... go run ./cmd/migrate`). Memory reads it only
// through the memory_source views, so fixtures go into the TeamHub tables.
const testDatabase = process.env.MEMORY_SOURCE_TEST_DATABASE_URL;
const subject: AnotherMeSubject = {
  tenantId: "tenant_1",
  agentActorId: "agent_actor",
  agentManagementId: "agent_1",
  agentDisplayName: "Agent",
  representedHumanActorId: "human_1",
  representedHumanDisplayName: "Alice",
  representedHumanAccountId: "account_1",
  memorySubjectKey: "agent_1",
};
const segments = (text: string) =>
  JSON.stringify([{ type: "text", text }]).replaceAll("'", "''");

describe.runIf(Boolean(testDatabase))(
  "Session source PostgreSQL queries",
  () => {
    let sql: postgres.Sql;
    beforeEach(async () => {
      const url = new URL(testDatabase!);
      if (
        url.pathname !== "/memory_source_test" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      )
        throw new Error(
          "Use an isolated localhost memory_source_test database",
        );
      sql = postgres(testDatabase!, { max: 1, onnotice: () => undefined });
      const message = (
        id: string,
        room: string,
        author: string,
        at: string,
        kind = "conversation",
      ) =>
        `('${id}','tenant_1','${room}','${author}','${id}','${segments(id)}','${at}','${kind}')`;
      await sql.unsafe(`
      TRUNCATE accounts, actors CASCADE;
      INSERT INTO accounts(id,email,password_hash) VALUES ('account_1','memory-alice@example.com','x'), ('account_2','memory-bob@example.com','x');
      INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
        ('human_1','tenant_1','human','Alice','account_1',NULL), ('human_2','tenant_1','human','Bob','account_2',NULL),
        ('agent_actor','tenant_1','agent','Agent',NULL,'memory-agent'), ('agent_actor_2','tenant_1','agent','Agent 2',NULL,'memory-agent-2');
      INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id) VALUES
        ('agent_actor','tenant_1','agent_1','active','Remember.','test-model','human_1','anotherme','human_1','computer_1','codex','grant_1'),
        ('agent_actor_2','tenant_1','agent_2','active','Remember.','test-model','human_2','anotherme','human_2','computer_1','codex','grant_2');
      INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES ('room_1','tenant_1','One','human_1'), ('room_2','tenant_1','Two','human_2'), ('room_private','tenant_1','Private','human_2'), ('room_deleted','tenant_1','Deleted','human_1');
      INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
        ('room_1','tenant_1','human_1','owner','human_1'), ('room_2','tenant_1','human_2','owner','human_2'), ('room_2','tenant_1','agent_actor','member','human_2'),
        ('room_private','tenant_1','human_2','owner','human_2'), ('room_deleted','tenant_1','human_1','owner','human_1');
      INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,created_at,message_kind) VALUES
        ${message("message_a", "room_1", "human_1", "2026-09-15T10:00:00+08:00")}, ${message("message_z", "room_1", "human_1", "2026-09-15T10:00:00+08:00")},
        ${message("runtime", "room_1", "agent_actor", "2026-09-15T10:09:00+08:00", "agent_runtime")}, ${message("terminal", "room_1", "agent_actor", "2026-09-15T10:10:00+08:00", "task_terminal_notice")},
        ${message("next_day", "room_1", "human_1", "2026-09-16T00:01:00+08:00")}, ${message("room_two_message", "room_2", "human_2", "2026-09-15T10:00:00+08:00")},
        ${message("private_message", "room_private", "human_2", "2026-09-15T10:00:00+08:00")}, ${message("deleted_message", "room_deleted", "human_1", "2026-09-15T10:00:00+08:00")};
      UPDATE rooms SET deletion_started_at=now(), deletion_started_by_actor_id='human_1',
        deleted_at=now(), deleted_by_actor_id='human_1' WHERE id='room_deleted';
      INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status,created_at) VALUES
        ('transcript_1','tenant_1','One','markdown','human_1','human','human_1','human','active','2026-09-15T10:00:00+08:00'),
        ('transcript_2','tenant_1','Two','markdown','human_1','human','human_1','human','active','2026-09-15T10:01:00+08:00');
      INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,created_at) VALUES
        ('version_1','tenant_1','transcript_1',1,'one.md','markdown','text/markdown',100,repeat('a',64),'object_1','ordinary_upload','human_1','2026-09-15T10:00:00+08:00'),
        ('version_2','tenant_1','transcript_2',1,'two.md','markdown','text/markdown',200,repeat('b',64),'object_2','ordinary_upload','human_1','2026-09-15T10:01:00+08:00');
      INSERT INTO voice_sessions(id,tenant_id,room_id,created_by_actor_id,status,purpose,provider_room_name,participant_identity,closed_at)
      SELECT 'voice_' || capture, 'tenant_1', room, 'human_1', 'closed', 'hardware_control', capture, capture, now()
      FROM (VALUES ('capture_1','room_1'), ('capture_2','room_1'), ('capture_recovering','room_1'), ('capture_private','room_private')) capture(capture, room);
      INSERT INTO capture_sessions(id,tenant_id,room_id,created_by_actor_id,status,voice_session_id,document_id,document_version_id,transcript_document_id,transcript_document_version_id,transcript_start_offset_ms,transcript_end_offset_ms,requested_transcript_start_offset_ms,created_at,updated_at) VALUES
        ('capture_1','tenant_1','room_1','human_1','finalized','voice_capture_1','transcript_1','version_1','transcript_1','version_1',0,900000,0,'2026-09-14T23:55:00+08:00','2026-09-14T23:55:00+08:00'),
        ('capture_2','tenant_1','room_1','human_1','finalized','voice_capture_2','transcript_2','version_2','transcript_2','version_2',0,120000,0,'2026-09-15T09:00:00+08:00','2026-09-15T09:00:00+08:00'),
        ('capture_recovering','tenant_1','room_1','human_1','recovering','voice_capture_recovering',NULL,NULL,'transcript_2','version_2',0,120000,0,'2026-09-15T09:00:00+08:00','2026-09-15T09:00:00+08:00'),
        ('capture_private','tenant_1','room_private','human_1','finalized','voice_capture_private','transcript_2','version_2','transcript_2','version_2',0,120000,0,'2026-09-15T09:00:00+08:00','2026-09-15T09:00:00+08:00');
    `);
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await sql?.end({ timeout: 5 });
    });

    it("uses the Memory conversation cursor and latest whole-Room activity across midnight", async () => {
      const targets = await queryRoomActivity(
        sql,
        subject,
        "2026-09-15T00:00:00+08:00",
      );
      expect(
        targets.map((value) => [value.roomId, value.date, value.messageId]),
      ).toEqual([
        ["room_1", "2026-09-15", "message_z"],
        ["room_1", "2026-09-16", "next_day"],
        ["room_2", "2026-09-15", "room_two_message"],
      ]);
      expect(targets[0]!.lastActivityAt).toBe("2026-09-15T16:01:00.000Z");
      expect(
        await queryRoomActivity(
          sql,
          { ...subject, agentManagementId: "agent_unknown" },
          "2026-09-15T00:00:00Z",
        ),
      ).toEqual([]);
    });

    it("groups Room activity by the process time zone's days", async () => {
      vi.stubEnv("TZ", "America/New_York");
      const targets = await queryRoomActivity(
        sql,
        subject,
        "2026-09-14T00:00:00Z",
      );
      expect(
        targets.map((value) => [value.roomId, value.date, value.messageId]),
      ).toEqual([
        ["room_1", "2026-09-14", "message_z"],
        ["room_1", "2026-09-15", "next_day"],
        ["room_2", "2026-09-14", "room_two_message"],
      ]);
    });

    it("filters the target Room before collecting snapshots or attachments", async () => {
      const rooms = await loadMemoryRooms(
        sql,
        [subject],
        "2026-09-15",
        "room_2",
      );
      expect(rooms.map((room) => room.room_id)).toEqual(["room_2"]);
      expect(rooms[0]).toMatchObject({
        memory_subject_key: "agent_1",
        agent_is_member: true,
        represented_human_is_member: false,
      });
      expect(
        await loadMemoryRooms(sql, [subject], "2026-09-15", "room_private"),
      ).toEqual([]);
    });

    it("discovers each ready Capture independently of Room message activity", async () => {
      const captures = await queryRecordingCandidates(
        sql,
        subject,
        "2026-09-15T00:00:00+08:00",
      );
      expect(captures.map((value) => value.captureId)).toEqual([
        "capture_1",
        "capture_2",
      ]);
      expect(captures[0]).toMatchObject({
        date: "2026-09-15",
        documentVersionId: "version_1",
        startedAt: "2026-09-14T15:55:00.000Z",
        endedAt: "2026-09-14T16:10:00.000Z",
        humanIsMember: true,
        agentIsMember: false,
      });
      expect(
        await queryRecordingCandidates(
          sql,
          subject,
          "2026-09-16T00:00:00+08:00",
        ),
      ).toEqual([]);
      expect(
        await queryRecordingCandidates(
          sql,
          subject,
          "2026-09-16T00:00:00+08:00",
          "capture_1",
        ),
      ).toHaveLength(1);
    });

    it("rechecks Room membership before reading a recording", async () => {
      await sql`DELETE FROM room_members WHERE room_id = 'room_1'`;
      expect(
        await queryRecordingCandidates(
          sql,
          subject,
          "2026-09-15T00:00:00+08:00",
          "capture_1",
        ),
      ).toEqual([]);
    });

    it("discovers delayed finalization without moving the stable Session date", async () => {
      await sql`UPDATE capture_sessions SET updated_at = '2026-09-20T12:00:00+08:00' WHERE id = 'capture_1'`;
      const [recording] = await queryRecordingCandidates(
        sql,
        subject,
        "2026-09-20T00:00:00+08:00",
      );
      expect(recording).toMatchObject({
        captureId: "capture_1",
        date: "2026-09-15",
        readyAt: "2026-09-20T04:00:00.000Z",
      });
    });

    it("adds only the recorder's private context and rediscovers later Ask questions and requests", async () => {
      expect(
        await queryRecordingCandidates(
          sql,
          subject,
          "2026-09-21T00:00:00+08:00",
        ),
      ).toEqual([]);
      await sql.unsafe(`
        UPDATE capture_sessions SET requested_transcript_start_offset_ms = 60000 WHERE id = 'capture_1';
        INSERT INTO voice_capture_questions (id,capture_session_id,kind,question,answer,answered,cutoff_offset_ms,sources,task_title,created_at) VALUES
          ('q1','capture_1','answer','Budget?','37.5k USD',true,180000,'[]','','2026-09-21T10:00:00+08:00'),
          ('q2','capture_1','task','Prepare the follow-up','','false',180000,'[]','Prepare the follow-up','2026-09-21T10:01:00+08:00');
        INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES ('room_1','tenant_1','human_2','member','human_1');
      `);
      const [recording] = await queryRecordingCandidates(
        sql,
        subject,
        "2026-09-21T00:00:00+08:00",
      );
      expect(recording?.captureId).toBe("capture_1");
      expect(recording?.privateContext).toContain("Q: Budget?");
      expect(recording?.privateContext).toContain(
        "- [02:00] Prepare the follow-up (not sent)",
      );
      expect(recording?.privateContext).toContain(
        "(based on the recording up to 02:00)",
      );
      const other = await queryRecordingCandidates(
        sql,
        { agentManagementId: "agent_2" },
        "2026-09-15T00:00:00+08:00",
        "capture_1",
      );
      expect(other).toHaveLength(1);
      expect(other[0]?.privateContext).toBeUndefined();
    });
  },
);
