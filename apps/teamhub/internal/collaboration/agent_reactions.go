package collaboration

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagereaction"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// SendAgentEmoji puts the credential's Agent's official Reaction on a Message
// in a Room the Agent belongs to and its Context may target. It returns the
// reacted Message's ID. A repeated Reaction changes nothing and needs no
// separate replay record.
func (s *Service) SendAgentEmoji(ctx context.Context, authorizer agentauth.Authorizer, token, messageID, emoji string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	authorization, err := authorizer.AuthorizeInTx(ctx, tx, token, "send_emoji")
	if err != nil {
		return "", err
	}
	queries := store.New(tx)
	authority, err := queries.GetAgentMessageReactionAuthority(ctx, store.GetAgentMessageReactionAuthorityParams{
		AgentActorID: authorization.AgentActorID, MessageID: messageID, TenantID: authorization.TenantID,
	})
	if err != nil {
		return "", err
	}
	if !agentauth.AllowsRoomTarget(authorization, authority.MembershipRoomID) {
		return "", agentauth.ErrForbidden
	}
	if !authority.Supported {
		return "", messagereaction.ErrUnsupported
	}
	if err := messagereaction.Apply(ctx, queries, messagereaction.Mutation{
		TenantID: authority.TenantID, RoomID: authority.RoomID, MessageID: authority.MessageID,
		ActorID: authorization.AgentActorID, ReactionID: emoji, Put: true,
	}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return authority.MessageID, nil
}
