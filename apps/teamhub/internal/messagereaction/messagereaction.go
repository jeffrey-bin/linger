// Package messagereaction owns public emoji Reactions on conversation Messages.
// A Reaction is not a Message: it never advances read state, writes Account
// Deliveries, queues Agent Runs or enters the tenant projection, so it cannot
// change unread counts, recent ordering, notifications or Agent wakeups. Each effective change commits one Room Event carrying the Message's
// complete Reaction aggregate.
package messagereaction

import (
	"context"
	_ "embed"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	EventType              = "message.reactions.changed"
	maxReactionsPerMessage = 1000
)

var (
	ErrInvalidReaction = errors.New("message reaction ID is invalid")
	ErrUnsupported     = errors.New("message does not support reactions")
	ErrCapacity        = errors.New("message reaction capacity reached")
)

type Reaction struct {
	ReactionID string
	ActorIDs   []string
}

// Mutation identifies an already authorized Actor and Message.
type Mutation struct {
	TenantID, RoomID, MessageID, ActorID, ReactionID string
	Put                                              bool
}

// reactionIDs is the official library shared with Web and Agents: every emoji
// ID of @emoji-mart/data 1.2.1 set 15, in category order. Regenerate with
//
//	node -e 'const d=require("@emoji-mart/data/sets/15/native.json");console.log(d.categories.flatMap(c=>c.emojis).join("\n"))'
//
//go:embed reaction-ids.txt
var reactionIDList string

var reactionIDs = func() map[string]struct{} {
	ids := strings.Fields(reactionIDList)
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}()

func ValidReactionID(reactionID string) bool {
	_, found := reactionIDs[reactionID]
	return found
}

// Apply adds or removes one Reaction inside the caller's transaction. Repeating
// the same mutation changes nothing and appends no event, so retries never flip
// state or emit a second event.
func Apply(ctx context.Context, queries *store.Queries, mutation Mutation) error {
	if !ValidReactionID(mutation.ReactionID) {
		return ErrInvalidReaction
	}
	var changed int64
	var err error
	if mutation.Put {
		count, countErr := queries.CountMessageReactions(ctx, mutation.MessageID)
		if countErr != nil {
			return countErr
		}
		if count >= maxReactionsPerMessage {
			exists, existsErr := queries.MessageReactionExists(ctx, store.MessageReactionExistsParams{
				MessageID: mutation.MessageID, ActorID: mutation.ActorID, ReactionID: mutation.ReactionID,
			})
			if existsErr != nil {
				return existsErr
			}
			if !exists {
				return ErrCapacity
			}
		}
		changed, err = queries.PutMessageReaction(ctx, store.PutMessageReactionParams{
			MessageID: mutation.MessageID, TenantID: mutation.TenantID, RoomID: mutation.RoomID,
			ActorID: mutation.ActorID, ReactionID: mutation.ReactionID,
		})
	} else {
		changed, err = queries.DeleteMessageReaction(ctx, store.DeleteMessageReactionParams{
			MessageID: mutation.MessageID, ActorID: mutation.ActorID, ReactionID: mutation.ReactionID,
		})
	}
	if err != nil || changed == 0 {
		return err
	}
	grouped, err := ListForMessages(ctx, queries, []string{mutation.MessageID})
	if err != nil {
		return err
	}
	reactions := Models(grouped[mutation.MessageID])
	if reactions == nil {
		reactions = []httpapi.MessageReaction{}
	}
	_, err = roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: mutation.TenantID, RoomID: mutation.RoomID, EventType: EventType,
		ActorID: mutation.ActorID, ResourceID: mutation.MessageID,
		Payload: httpapi.MessageReactionsChangedPayload{
			Kind: EventType, MessageId: mutation.MessageID, Reactions: reactions,
		},
	})
	return err
}

// ListForMessages groups Reactions by Message and Reaction ID in first-reacted order.
func ListForMessages(ctx context.Context, queries *store.Queries, messageIDs []string) (map[string][]Reaction, error) {
	result := make(map[string][]Reaction)
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := queries.ListMessageReactionsForMessages(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		reactions := result[row.MessageID]
		index := -1
		for i := range reactions {
			if reactions[i].ReactionID == row.ReactionID {
				index = i
				break
			}
		}
		if index < 0 {
			reactions = append(reactions, Reaction{ReactionID: row.ReactionID})
			index = len(reactions) - 1
		}
		reactions[index].ActorIDs = append(reactions[index].ActorIDs, row.ActorID)
		result[row.MessageID] = reactions
	}
	return result, nil
}

func Models(reactions []Reaction) []httpapi.MessageReaction {
	if len(reactions) == 0 {
		return nil
	}
	models := make([]httpapi.MessageReaction, len(reactions))
	for i, reaction := range reactions {
		models[i] = httpapi.MessageReaction{
			ReactionId: reaction.ReactionID, ActorIds: reaction.ActorIDs,
		}
	}
	return models
}
