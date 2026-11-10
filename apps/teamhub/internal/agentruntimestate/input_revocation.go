package agentruntimestate

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Membership revocation already holds its authority and Context locks and
// closes the Room's Meta Context, so every queued Input and Run is canceled.
// The caller owns the transaction, including Runtime terminal intent.
func closeContextInputsForMembershipRevocation(ctx context.Context, queries *store.Queries, contextKey string) error {
	if queries == nil || strings.TrimSpace(contextKey) == "" {
		return ErrInvalid
	}
	runIDs, err := queries.ListUnfinishedAgentContextLocalRuns(ctx, contextKey)
	if err != nil {
		return err
	}
	if _, err := TerminateLocalRuns(ctx, queries, runIDs, json.RawMessage(`{"type":"canceled","reason":"room_membership_revoked"}`)); err != nil {
		return err
	}
	_, err = queries.SettleAgentContextInputsForMembershipRevocation(ctx, contextKey)
	return err
}
