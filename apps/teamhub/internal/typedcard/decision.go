package typedcard

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// decisionOutcome is what a decision announces: result and handoff Messages
// to publish once the card has changed.
type decisionOutcome struct {
	messages []messagecreation.Persisted
}

// decideCard runs one Human decision on a card. It takes its locks in one
// order: the card Room's membership lock, the
// decision and card rows, then the card's Room row, before anything that
// takes Documents or delivery Accounts. The card's change and the decision's
// Messages are published last, so clients see the changed card before the
// result.
func (s *Service) decideCard(ctx context.Context, step *decisionAnswerStep) (CreateResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	location, err := queries.LocateDecision(ctx, step.id)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrNotFound
	}
	if err != nil {
		return CreateResult{}, err
	}
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+location.RoomID); err != nil {
		return CreateResult{}, err
	}
	if err := step.authorize(ctx, queries); err != nil {
		return CreateResult{}, err
	}
	if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{
		TenantID: location.TenantID, RoomIds: []string{location.RoomID},
	}); err != nil {
		return CreateResult{}, err
	}
	outcome, err := step.apply(ctx, tx, queries)
	if err != nil {
		return CreateResult{}, err
	}
	messageID := step.authority.MessageID
	if err := messagecreation.AdvanceCards(ctx, queries, location.TenantID, step.authority.CallerActorID, []string{messageID}); err != nil {
		return CreateResult{}, err
	}
	// Result Messages follow card.changed so clients see the terminal card first.
	for _, message := range outcome.messages {
		if _, err := messagecreation.Publish(ctx, queries, message); err != nil {
			return CreateResult{}, err
		}
	}
	response, err := loadTypedCardMessageResponse(ctx, queries, messageID)
	if err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Status: http.StatusOK, Body: response}, nil
}
