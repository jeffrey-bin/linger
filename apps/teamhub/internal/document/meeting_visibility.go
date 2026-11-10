package document

// Meetings is a virtual reading view, not a new placement or access grant.
// A Capture-linked source recording always belongs to Meetings, independent of
// processing status. Final audio/transcript move only while both are active.
const excludeMeetingDocumentsSQL = `
 AND NOT EXISTS (
   SELECT 1 FROM capture_sessions capture
   WHERE capture.tenant_id=document.tenant_id
     AND capture.source_audio_document_id=document.id
 )
 AND NOT EXISTS (
   SELECT 1 FROM capture_sessions capture
   JOIN rooms room ON room.id=capture.room_id AND room.tenant_id=capture.tenant_id AND room.deleted_at IS NULL
   JOIN document_versions audio ON audio.id=capture.document_version_id AND audio.document_id=capture.document_id AND audio.tenant_id=capture.tenant_id
   JOIN documents audio_document ON audio_document.id=audio.document_id AND audio_document.status='active'
   JOIN document_versions transcript ON transcript.id=capture.transcript_document_version_id AND transcript.document_id=capture.transcript_document_id AND transcript.tenant_id=capture.tenant_id
   JOIN documents transcript_document ON transcript_document.id=transcript.document_id AND transcript_document.status='active'
   WHERE capture.tenant_id=document.tenant_id AND capture.status='finalized'
     AND document.id IN (capture.document_id,capture.transcript_document_id)
 )
`
