package typedcard

import (
	"context"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// persistDecisionResultMessage writes the decision owner's visible result,
// linked to the card. A result is a record, not a request: it neither wakes
// nor obliges an Agent.
func persistDecisionResultMessage(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	roomID string,
	cardMessageID string,
	decisionOwner store.Actor,
	body string,
) (messagecreation.Persisted, error) {
	body = strings.TrimSpace(body)
	if body == "" || tenantID == "" || roomID == "" || cardMessageID == "" ||
		decisionOwner.ID == "" || decisionOwner.TenantID != tenantID || decisionOwner.Kind != "human" {
		return messagecreation.Persisted{}, ErrInvalid
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: body}})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	return messagecreation.Persist(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: roomID, Author: decisionOwner, Content: content,
		CardContextMessageID: cardMessageID, SuppressMentionSignals: true,
	})
}

// publishCardMessage projects the card of a persisted card Message, whose
// owner row now exists, and announces the Message carrying it.
func publishCardMessage(ctx context.Context, queries *store.Queries, message messagecreation.Persisted) (messagecreation.Result, error) {
	card, found, err := hydrateCard(ctx, queries, message.Message.ID)
	if err != nil {
		return messagecreation.Result{}, err
	}
	if !found {
		return messagecreation.Result{}, errors.New("typed card Message has no card projection")
	}
	message.Card = card
	return messagecreation.Publish(ctx, queries, message)
}
