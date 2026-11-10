package collaboration

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// Identity and resource membership are read in the same database snapshot. No
// Context, Run or topology copy supplies execution or resource authority.
func readAgentContext[T any](ctx context.Context, s *Service, token string, read func(agentcredential.Principal, *store.Queries) (T, error)) (T, error) {
	var zero T
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return zero, internal("start Agent collaboration read", err)
	}
	defer tx.Rollback(ctx)
	principal, err := agentcredential.AuthenticateInTx(ctx, tx, token)
	if err != nil {
		return zero, err
	}
	result, err := read(principal, store.New(tx))
	if err != nil {
		return zero, err
	}
	if err = tx.Commit(ctx); err != nil {
		return zero, internal("commit Agent collaboration read", err)
	}
	return result, nil
}

// AgentRoomMembers lists the members of a Room or Thread Inbox the Agent
// credential's Agent belongs to. Credential failures report
// agentcredential.ErrForbidden or agentcredential.ErrInvalid.
func (s *Service) AgentRoomMembers(ctx context.Context, token, inboxID string) (api.AgentRoomMembersResponse, error) {
	return readAgentContext(ctx, s, token, func(p agentcredential.Principal, q *store.Queries) (api.AgentRoomMembersResponse, error) {
		room, err := q.GetAgentContextReadRoom(ctx, store.GetAgentContextReadRoomParams{TenantID: p.TenantID, ActorID: p.AgentActorID, InboxID: inboxID})
		if err != nil {
			return api.AgentRoomMembersResponse{}, err
		}
		rows, err := q.ListAgentContextReadRoomMembers(ctx, store.ListAgentContextReadRoomMembersParams{TenantID: p.TenantID, RoomID: room.RoomID})
		if err != nil {
			return api.AgentRoomMembersResponse{}, err
		}
		members := make([]api.AgentContextMember, 0, len(rows))
		for _, row := range rows {
			member := api.AgentContextMember{ActorId: row.ActorID, Kind: api.AgentContextMemberKind(row.Kind), DisplayName: row.DisplayName}
			if row.AgentType != "" {
				agentType := api.AgentContextMemberAgentType(row.AgentType)
				member.AgentType, member.Description = &agentType, &row.Description
			}
			members = append(members, member)
		}
		return api.AgentRoomMembersResponse{InboxId: inboxID, RoomId: room.RoomID, MembershipRevision: room.MembershipRevision, Members: members}, nil
	})
}

// AgentTeamMd reads the team document of a Room or Thread Inbox the Agent
// credential's Agent belongs to.
func (s *Service) AgentTeamMd(ctx context.Context, token, inboxID string) (api.AgentTeamMdResponse, error) {
	return readAgentContext(ctx, s, token, func(p agentcredential.Principal, q *store.Queries) (api.AgentTeamMdResponse, error) {
		room, err := q.GetAgentContextReadRoom(ctx, store.GetAgentContextReadRoomParams{TenantID: p.TenantID, ActorID: p.AgentActorID, InboxID: inboxID})
		if err != nil {
			return api.AgentTeamMdResponse{}, err
		}
		team, err := q.GetRoomTeamDocument(ctx, store.GetRoomTeamDocumentParams{TenantID: p.TenantID, RoomID: room.MembershipRoomID})
		if err != nil {
			return api.AgentTeamMdResponse{}, err
		}
		return api.AgentTeamMdResponse{RoomId: room.MembershipRoomID, RawMarkdown: team.RawMarkdown, Revision: team.Revision, UpdatedAt: team.UpdatedAt.Time}, nil
	})
}

// AgentThreadRoom resolves a Thread the Agent may post into: its Room and
// the parent Room the Thread belongs to.
func (s *Service) AgentThreadRoom(ctx context.Context, tenantID, agentActorID, threadID string) (store.GetAgentSendMessageThreadRoomRow, error) {
	return s.queries.GetAgentSendMessageThreadRoom(ctx, store.GetAgentSendMessageThreadRoomParams{
		ThreadID: threadID, TenantID: tenantID, AgentActorID: agentActorID,
	})
}

// CurrentDirectRoom returns the Human's current Direct Room with the Agent.
// It reports pgx.ErrNoRows when there is none.
func (s *Service) CurrentDirectRoom(ctx context.Context, tenantID, humanActorID, agentActorID string) (string, error) {
	return s.queries.GetCurrentDirectRoom(ctx, store.GetCurrentDirectRoomParams{
		TenantID: tenantID, HumanActorID: humanActorID, AgentActorID: agentActorID,
	})
}
