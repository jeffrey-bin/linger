package workitem

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// InitializeTaskWorkRoomInboxCursors runs in the binding transaction after its
// current generation is persisted, under the caller's Task lock. The Work Room
// is new, so every eligible Context starts at 0 and its initial message stays
// unread.
func InitializeTaskWorkRoomInboxCursors(ctx context.Context, tx pgx.Tx, tenantID, taskID string) error {
	if tenantID == "" || taskID == "" {
		return ErrInvalid
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_context_inbox_cursors(context_key,inbox_id,committed_through_seq,cursor_encoding)
 SELECT context.context_key,'task:'||$1::text,0,'room_event_v1'
 FROM agent_execution_contexts context
 WHERE context.tenant_id=$2 AND (agent_context_can_receive_inbox(context.context_key,'task:'||$1::text)
  OR EXISTS(SELECT 1 FROM agent_context_inbox_cursors task_cursor WHERE task_cursor.context_key=context.context_key AND task_cursor.inbox_id='task:'||$1::text))
 ON CONFLICT(context_key,inbox_id) DO UPDATE SET committed_through_seq=0,cursor_encoding='room_event_v1',updated_at=clock_timestamp()`, taskID, tenantID)
	return err
}
