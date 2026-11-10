package workitem

import (
	"context"

	"github.com/jackc/pgx/v5"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// CreateTaskForApprovedCreation creates the Work Item side of an approved
// create_task request inside the caller's Decision transaction. Assignees come
// from the immutable approval snapshot; the initiating Agent is the creator but
// is not implicitly an assignee.
func CreateTaskForApprovedCreation(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	agent store.Actor,
	input CreateInput,
) (Item, error) {
	if agent.Kind != "agent" || len(input.AssigneeActorIDs) == 0 {
		return Item{}, ErrInvalid
	}
	normalized, err := normalizeCreate(input)
	if err != nil || normalized.Kind != "task" || len(normalized.AssigneeActorIDs) == 0 {
		return Item{}, ErrInvalid
	}
	if err := validateOriginLink(ctx, queries, agent.TenantID, agent.ID, normalized); err != nil {
		return Item{}, err
	}
	if _, err := resolveActors(ctx, queries, agent.TenantID, normalized.ReferencedActorIDs); err != nil {
		return Item{}, err
	}
	if _, err := resolveAssignableActors(ctx, queries, agent.TenantID, normalized.AssigneeActorIDs); err != nil {
		return Item{}, err
	}
	number, err := queries.AllocateTenantWorkItemNumber(ctx, agent.TenantID)
	if err != nil {
		return Item{}, err
	}
	record, err := queries.CreateTypedCardWorkItem(ctx, store.CreateTypedCardWorkItemParams{
		ID: idgen.New("workitem"), TenantID: agent.TenantID, Number: number,
		Kind: normalized.Kind, Title: normalized.Title, Description: normalized.Description,
		Priority: normalized.Priority, CreatedByActorID: agent.ID,
	})
	if err != nil {
		return Item{}, err
	}
	if err := createOriginLink(ctx, queries, record, agent.ID, normalized); err != nil {
		return Item{}, err
	}
	if err := createDescriptionReferences(ctx, queries, record, normalized.ReferencedActorIDs); err != nil {
		return Item{}, err
	}
	for _, actorID := range normalized.AssigneeActorIDs {
		if _, err := queries.CreateWorkItemAssignment(ctx, store.CreateWorkItemAssignmentParams{
			WorkItemID: record.ID, TenantID: record.TenantID,
			ActorID: actorID, AssignedByActorID: agent.ID,
		}); err != nil {
			return Item{}, err
		}
	}
	if err := createActivity(ctx, queries, record.ID, record.TenantID, "created", agent.ID, "", "", ""); err != nil {
		return Item{}, err
	}
	return LoadItem(ctx, queries, record)
}

// LoadItem projects one Work Item through the same public interface used by normal Work Item queries.
func LoadItem(ctx context.Context, queries *store.Queries, record store.WorkItem) (Item, error) {
	items, err := LoadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Item{}, err
	}
	return items[0], nil
}

// LoadItems projects a batch of Work Items with a fixed set of relation queries.
func LoadItems(ctx context.Context, queries *store.Queries, records []store.WorkItem) ([]Item, error) {
	return loadItems(ctx, queries, records)
}
