package messagecreation

// Card changes: a card's version rises and its Room records card.changed, and
// a hidden handoff Message wakes the Agent the change concerns. Every card
// writer goes through AdvanceCards and CardHandoff, so each takes the same
// locks in the same order.

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// AdvanceCards raises the version of each card and records card.changed in its
// Room. It first locks every Room the caller may next write, in id order: the
// cards' Rooms and their Work Items' linked Rooms, for a result or handoff
// Message or a fan-out. A Room whose deletion has started keeps the raised
// version without recording the change.
func AdvanceCards(ctx context.Context, queries *store.Queries, tenantID, actorID string, messageIDs []string) error {
	if len(messageIDs) == 0 {
		return nil
	}
	if err := queries.LockCardRooms(ctx, store.LockCardRoomsParams{
		TenantID: tenantID, MessageIds: messageIDs,
	}); err != nil {
		return err
	}
	cards, err := queries.AdvanceCardVersions(ctx, store.AdvanceCardVersionsParams{
		TenantID: tenantID, MessageIds: messageIDs,
	})
	if err != nil {
		return err
	}
	for _, card := range cards {
		if !card.RoomLive {
			continue
		}
		if _, err := roomevent.Append(ctx, queries, roomevent.Input{
			TenantID: tenantID, RoomID: card.RoomID, EventType: "card.changed",
			ActorID: actorID, ResourceID: card.MessageID,
			Payload: map[string]any{"kind": "card.changed", "message_id": card.MessageID, "version": card.Version},
		}); err != nil {
			return err
		}
	}
	return nil
}

// CardHandoff persists the hidden agent_runtime Message in which a card's change
// wakes the Agent it names. TeamHub writes and bounds the text, and the card's
// authority, not the Agent's current membership, names the Agent. The caller
// announces it with Publish after AdvanceCards, so clients see the
// changed card first.
func CardHandoff(ctx context.Context, queries *store.Queries, draft Draft, agent store.Actor, text string) (Persisted, error) {
	mention := MentionToken(agent.DisplayName)
	draft.Kind, draft.Validated, draft.Mentions = "agent_runtime", true, []store.Actor{agent}
	draft.Content = Content{RawMessage: mention + text, Segments: []Segment{
		{Type: "reference", Content: mention, Target: agent.ID, TargetType: "agent"},
		{Type: "text", Content: text},
	}}
	return Persist(ctx, queries, draft)
}
