package document

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// AgentMentionCandidate is an Agent the Human can @mention in a Document
// comment, with whether the Human sponsors it.
type AgentMentionCandidate struct {
	Actor             Actor
	AgentManagementID string
	Relationship      string
}

// AgentMentionCandidatePage is one page of mention candidates ordered by
// Actor ID.
type AgentMentionCandidatePage struct {
	Items      []AgentMentionCandidate
	NextCursor string
	HasMore    bool
}

// ListAgentMentionCandidates lists the Agents the Human can @mention on a
// Document. Every Agent has its Human's Document access, so a mention needs no
// authorization step and every visible Agent is a candidate.
func (s *Service) ListAgentMentionCandidates(ctx context.Context, accountID, documentID, cursor string, limit int) (AgentMentionCandidatePage, error) {
	if accountID == "" || documentID == "" || limit < 1 || limit > 100 {
		return AgentMentionCandidatePage{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return AgentMentionCandidatePage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, accountID, documentID)
	if err != nil || value.Status != "active" {
		return AgentMentionCandidatePage{}, err
	}
	callerActorID, err := resolveActiveHumanActorTx(ctx, tx, accountID, value.TenantID)
	if err != nil {
		return AgentMentionCandidatePage{}, err
	}
	rows, err := tx.Query(ctx, `SELECT actor.id,actor.kind,actor.display_name,registration.agent_management_id,
		registration.created_by_actor_id
		FROM agent_registrations registration
		JOIN actors actor ON actor.id=registration.actor_id AND actor.tenant_id=registration.tenant_id
		WHERE registration.tenant_id=$1 AND registration.status='active' AND actor.id>$2
		  AND (registration.created_by_actor_id=$3 OR registration.visibility_scope='workspace')
		ORDER BY actor.id LIMIT $4`, value.TenantID, cursor, callerActorID, limit+1)
	if err != nil {
		return AgentMentionCandidatePage{}, err
	}
	defer rows.Close()
	items := make([]AgentMentionCandidate, 0, limit+1)
	for rows.Next() {
		var item AgentMentionCandidate
		var sponsorActorID string
		if err := rows.Scan(&item.Actor.ID, &item.Actor.Kind, &item.Actor.DisplayName,
			&item.AgentManagementID, &sponsorActorID); err != nil {
			return AgentMentionCandidatePage{}, err
		}
		item.Actor.TenantID = value.TenantID
		item.Relationship = "ordinary_direct"
		if sponsorActorID == callerActorID {
			item.Relationship = "sponsor"
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return AgentMentionCandidatePage{}, err
	}
	page := AgentMentionCandidatePage{Items: items}
	if len(page.Items) > limit {
		page.HasMore = true
		page.Items = page.Items[:limit]
		page.NextCursor = page.Items[len(page.Items)-1].Actor.ID
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentMentionCandidatePage{}, err
	}
	return page, nil
}
