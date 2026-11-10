import { memoryDatabase } from "./database.js";
export interface MeetingRow {
  id: string;
  room_id: string;
  started_at: Date;
  updated_at: Date;
  recording_document_id: string;
  recording_version_id: string;
  recording_filename: string;
  transcript_document_id: string;
  transcript_version_id: string;
  transcript_sha256: string;
  transcript_created_at: Date;
}

// Use the same Document access boundary as Workspace. A Room membership alone
// is not sufficient, and revoked access must also hide the derived summary.
// A meeting the Human hid is gone from their own Meetings only.
export async function queryReadyMeetings(
  tenantId: string,
  ownerActorId: string,
  captureIds: string[] | null = null,
  sql = memoryDatabase(),
): Promise<MeetingRow[]> {
  return sql<MeetingRow[]>`
    SELECT id, room_id, started_at, updated_at, recording_document_id,
      recording_version_id, recording_filename, transcript_document_id,
      transcript_version_id, transcript_sha256, transcript_created_at
    FROM memory_source.finalized_meetings
    WHERE tenant_id = ${tenantId}
      AND (${captureIds}::text[] IS NULL OR id = ANY(${captureIds}::text[]))
      AND memory_source.human_can_read_document(${ownerActorId}, tenant_id, recording_document_id)
      AND memory_source.human_can_read_document(${ownerActorId}, tenant_id, transcript_document_id)
      AND NOT EXISTS (
        SELECT 1 FROM memory_source.hidden_meetings hidden
        WHERE hidden.tenant_id = finalized_meetings.tenant_id
          AND hidden.capture_session_id = finalized_meetings.id
      )
    ORDER BY started_at DESC, id
  `;
}
