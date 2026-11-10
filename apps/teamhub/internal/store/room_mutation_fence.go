package store

import "context"

// LockActiveRoomForMutation serializes a mutation's final commit gate with Room deletion.
// The active-state check must be a separate statement so READ COMMITTED observes deletion
// committed while the shared lifecycle fence was waiting.
func (q *Queries) LockActiveRoomForMutation(ctx context.Context, roomID string) (string, error) {
	if err := q.AcquireRoomMutationFence(ctx, roomID); err != nil {
		return "", err
	}
	return q.GetActiveRoomForMutation(ctx, roomID)
}
