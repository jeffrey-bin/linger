package agentruntimestate

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Cancellation facts commit in the same transaction as their Message, so a
// reader that sees the Message also sees its cancellation and needs no lock.
// Claim still checks them because trusted ingress may have accepted an input
// before its Room notification was normalized.
func runHasCanceledRoomMessages(ctx context.Context, db store.DBTX, runID, agentID string) (bool, error) {
	var canceled bool
	err := db.QueryRow(ctx, `SELECT EXISTS (
        SELECT 1 FROM agent_local_run_inputs link
        JOIN agent_runtime_inputs input ON input.context_key=link.context_key AND input.input_id=link.input_id
        CROSS JOIN LATERAL (
            SELECT input.source_message_id AS message_id
            UNION
            SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(input.payload->'invocationMessageIds')='array'
                THEN input.payload->'invocationMessageIds' ELSE '[]'::jsonb END)
        ) source
        JOIN room_agent_message_cancellations cancellation ON cancellation.agent_actor_id=$2
          AND cancellation.message_id=source.message_id
        WHERE link.run_id=$1
    )`, runID, agentID).Scan(&canceled)
	return canceled, err
}
