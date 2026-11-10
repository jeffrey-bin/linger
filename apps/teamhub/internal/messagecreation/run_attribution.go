package messagecreation

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type runClaimKey struct{}

// WithRunClaim carries the Local Run an Agent request names in its Run
// header. The claim grants nothing: a Message keeps it only when
// ResolveRunClaim accepts it.
func WithRunClaim(ctx context.Context, runID string) context.Context {
	return context.WithValue(ctx, runClaimKey{}, runID)
}

// RunClaim is the Run a request names, before ResolveRunClaim checks it.
func RunClaim(ctx context.Context) string {
	claim, _ := ctx.Value(runClaimKey{}).(string)
	return claim
}

// ResolveRunClaim returns the request's claimed Run when it is running, is the
// author Agent's and shows its status in the collaboration Room of roomID.
// Anything else leaves the Message without a Run rather than failing it.
func ResolveRunClaim(ctx context.Context, queries *store.Queries, tenantID, agentActorID, roomID string) (pgtype.Text, error) {
	claim := RunClaim(ctx)
	if claim == "" {
		return pgtype.Text{}, nil
	}
	runID, err := queries.ResolveMessageRunClaim(ctx, store.ResolveMessageRunClaimParams{
		RunID: claim, TenantID: tenantID, AgentActorID: agentActorID, RoomID: roomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return pgtype.Text{}, nil
	}
	if err != nil {
		return pgtype.Text{}, err
	}
	return pgtype.Text{String: runID, Valid: true}, nil
}

func messageRun(ctx context.Context, queries *store.Queries, draft Draft) (pgtype.Text, error) {
	if draft.TrustedRunID != "" {
		return pgtype.Text{String: draft.TrustedRunID, Valid: true}, nil
	}
	return ResolveRunClaim(ctx, queries, draft.TenantID, draft.Author.ID, draft.RoomID)
}
