package agentsendmessage

import (
	"context"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
)

// AgentPresentationSequence is an Another Me's request to send a paced
// sequence of Messages into its current Room.
type AgentPresentationSequence struct {
	InboxID, InvocationID, SourceMessageID string
	Items                                  []PresentationItem
}

// CreateForAgent authorizes the credential's Another Me in its current Room
// and stores the sequence in one transaction. A new sequence delivers its
// first item at once; the worker is woken either way, since it sleeps until
// its next known due item.
func (s *PresentationSequenceService) CreateForAgent(ctx context.Context, authorizer agentauth.Authorizer, token string, request AgentPresentationSequence) (PresentationSequenceResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	defer tx.Rollback(ctx)
	authorization, err := authorizer.AuthorizeInTx(ctx, tx, token, "send_message_sequence")
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	roomID := strings.TrimPrefix(request.InboxID, "room:")
	if authorization.AgentType != "anotherme" ||
		(authorization.ParticipantTaskID != "" || authorization.Target.Kind == "document") || authorization.RoomID == "" ||
		authorization.RoomID != roomID || !agentauth.AllowsRoomTarget(authorization, roomID) {
		return PresentationSequenceResult{}, agentauth.ErrForbidden
	}
	result, err := s.CreateAuthorizedInTx(ctx, tx, AuthorizedPresentationSequenceInput{
		RoomID: roomID, TenantID: authorization.TenantID, AgentActorID: authorization.AgentActorID,
		AgentManagementID: authorization.AgentID, IdempotencyKey: request.InvocationID,
		SourceMessageID: request.SourceMessageID, Items: request.Items,
	})
	if err != nil {
		return PresentationSequenceResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PresentationSequenceResult{}, err
	}
	if !result.Replay {
		_, err := s.RunOnce(ctx, 1)
		s.Wake()
		if err != nil {
			return PresentationSequenceResult{}, err
		}
	}
	return result, nil
}
