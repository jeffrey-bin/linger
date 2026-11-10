package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// createVoiceLiveAgent creates a General Agent of the user, as the call's
// Agent's agent create does once its Sponsor approves the card: the user's
// spoken yes is that approval. Like the CLI, the Agent joins a group Room at
// once; a Direct Room has fixed members, so there it is only announced.
func (s *Service) createVoiceLiveAgent(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.CreateAgentArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	change := agentregistry.AgentProfileChange{
		Name: agentregistry.NormalizedAgentText(&args.Name), Description: agentregistry.NormalizedAgentText(&args.Description),
		Instructions: agentregistry.NormalizedAgentText(&args.Prompt),
	}
	if !agentregistry.ValidAgentProfileChange(change) {
		return voicelive.ErrorOutput("invalid_agent"), nil
	}
	// Only a General Agent or AnotherMe may create Agents, and only for its
	// own Sponsor: the Human on this call.
	caller, err := s.queries.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{ActorID: session.Agent.ID, TenantID: session.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (caller.Status != "active" || caller.CreatedByActorID != session.HumanActorID ||
		caller.AgentType != "general" && caller.AgentType != "anotherme") {
		return voicelive.ErrorOutput("agent_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	direct, err := s.queries.IsTenantDirectRoom(ctx, store.IsTenantDirectRoomParams{RoomID: session.RoomID, TenantID: session.TenantID})
	if err != nil {
		return "", err
	}
	summary := "Will create the Agent “" + *change.Name + "”"
	if *change.Description != "" {
		summary += ": " + voicelive.Snippet(*change.Description)
	}
	if !direct {
		summary += ", and add it to this room"
	}
	prompt := voicelive.NeedsConfirmation(summary)
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
		return prompt, err
	}
	encoded, err := json.Marshal(change)
	if err != nil {
		return "", err
	}
	// The same confirmed Agent in one turn is one Agent even under new call IDs.
	key, _ := voiceLiveTurnKey(session, request, encoded)
	actorID, err := s.agents.CreateSponsorAgent(ctx, session.AccountID, session.TenantID, session.Agent.ID, change, key)
	switch {
	case errors.Is(err, agentregistry.ErrAgentLimitReached):
		return voicelive.ErrorOutput("agent_limit"), nil
	case errors.Is(err, agentregistry.ErrAgentPlacementTargetUnavailable), errors.Is(err, collaboration.ErrAgentSponsorRequired):
		return voicelive.ErrorOutput("agent_unavailable"), nil
	case errors.Is(err, idempotency.ErrConflict):
		return voicelive.ErrorOutput("conflict"), nil
	case err != nil:
		return "", err
	}
	output := map[string]any{"status": "created", "actor_id": actorID, "name": *change.Name, "joined_room": false}
	if !direct {
		_, _, err := s.collaboration.PutRoomMember(ctx, session.AccountID, session.RoomID, actorID, httpapi.Member, collaboration.AddedByAgent{ActorID: session.Agent.ID, Created: true})
		if err != nil && s.logger != nil {
			s.logger.Warn("live Agent not added to Room", "voice_session_id", session.ID, "error_type", fmt.Sprintf("%T", err))
		}
		output["joined_room"] = err == nil
		return voicelive.Output(output), nil
	}
	if err := s.announceVoiceLiveAgent(ctx, session, actorID); err != nil && s.logger != nil {
		s.logger.Warn("live Agent creation not announced", "voice_session_id", session.ID, "error_type", fmt.Sprintf("%T", err))
	}
	return voicelive.Output(output), nil
}

// announceVoiceLiveAgent posts the notice an approved creation card posts,
// from the call's Agent, approved by the user.
func (s *Service) announceVoiceLiveAgent(ctx context.Context, session voicelive.Session, actorID string) error {
	actors := make([]store.Actor, 0, 2)
	for _, id := range []string{actorID, session.HumanActorID} {
		actor, err := s.queries.GetActor(ctx, store.GetActorParams{ID: id, TenantID: session.TenantID})
		if err != nil {
			return err
		}
		actors = append(actors, actor)
	}
	_, err := messagecreation.CreateNotice(ctx, s.queries, session.TenantID, session.RoomID, session.Agent, messagecreation.AgentCreated(actors[0], &actors[1]))
	return err
}
