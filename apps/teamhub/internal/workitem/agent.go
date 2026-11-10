package workitem

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) ListForAgent(ctx context.Context, agentManagementID string, filter ListFilter) (Page, error) {
	if filter.Limit < 1 || filter.Limit > 200 || len(filter.Cursor) > 512 ||
		!validOptional(filter.Kind, "issue", "task") ||
		!validOptional(filter.State, "open", "in_progress", "resolved") {
		return Page{}, ErrInvalid
	}
	cursorTime, cursorID, err := decodePageCursor(filter.Cursor)
	if err != nil {
		return Page{}, ErrInvalid
	}
	queries := store.New(s.pool)
	actor, err := agentActor(ctx, queries, agentManagementID)
	if err != nil {
		return Page{}, err
	}
	records, err := queries.ListWorkItemsForAgent(ctx, store.ListWorkItemsForAgentParams{
		TenantID: actor.TenantID, AgentActorID: actor.ID, StateFilter: filter.State, KindFilter: filter.Kind,
		WorkRoomID: filter.WorkRoomID, IncludeArchived: filter.IncludeArchived, HasCursor: filter.Cursor != "",
		CursorUpdatedAt: pgtype.Timestamptz{Time: cursorTime, Valid: filter.Cursor != ""},
		CursorID:        cursorID, PageLimit: filter.Limit + 1,
	})
	if err != nil {
		return Page{}, err
	}
	hasMore := len(records) > int(filter.Limit)
	if hasMore {
		records = records[:filter.Limit]
	}
	items, err := loadItems(ctx, queries, records)
	if err != nil {
		return Page{}, err
	}
	page := Page{Items: items, HasMore: hasMore}
	if hasMore {
		page.NextCursor = encodePageCursor(records[len(records)-1])
	}
	return page, nil
}

func (s *Service) GetForAgent(ctx context.Context, agentManagementID, workItemID string) (Item, error) {
	queries := store.New(s.pool)
	actor, err := agentActor(ctx, queries, agentManagementID)
	if err != nil {
		return Item{}, err
	}
	record, err := queries.GetWorkItemForAgent(ctx, store.GetWorkItemForAgentParams{
		ID: workItemID, TenantID: actor.TenantID, AgentActorID: actor.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	items, err := loadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Item{}, err
	}
	return items[0], nil
}

func (s *Service) CreateForAgent(ctx context.Context, agentManagementID, key string, input CreateInput) (Result[Item], error) {
	normalized, err := normalizeCreate(input)
	if err != nil {
		return Result[Item]{}, err
	}
	if normalized.Kind == "task" {
		return Result[Item]{}, ErrUnavailable
	}
	if (normalized.AssigneeActorIDsSet || len(normalized.AssigneeActorIDs) > 0) && normalized.OriginRoomID == "" {
		return Result[Item]{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result[Item]{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	actor, err := agentActor(ctx, queries, agentManagementID)
	if err != nil {
		return Result[Item]{}, err
	}
	tenantID := actor.TenantID
	operation := "create:" + tenantID
	hash := requestHash(normalized)
	if err := idempotency.Lock(ctx, tx, idempotency.ActorKey(actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, tx, actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, tx, replay)
	}
	if normalized.OriginRoomID != "" {
		if err := roomcreation.LockMembership(ctx, queries, normalized.OriginRoomID); err != nil {
			return Result[Item]{}, err
		}
	}
	if err := validateOriginLink(ctx, queries, tenantID, actor.ID, normalized); err != nil {
		return Result[Item]{}, err
	}
	if _, err := resolveActors(ctx, queries, tenantID, normalized.ReferencedActorIDs); err != nil {
		return Result[Item]{}, err
	}
	if _, err := resolveAgentCreateAssignees(ctx, queries, tenantID, normalized); err != nil {
		return Result[Item]{}, err
	}
	number, err := queries.AllocateTenantWorkItemNumber(ctx, tenantID)
	if err != nil {
		return Result[Item]{}, err
	}
	record, err := queries.CreateWorkItem(ctx, store.CreateWorkItemParams{
		ID: idgen.New("workitem"), TenantID: tenantID, Number: number, Kind: normalized.Kind,
		Title: normalized.Title, Description: normalized.Description, Priority: normalized.Priority,
		CreatedByActorID: actor.ID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if err := createOriginLink(ctx, queries, record, actor.ID, normalized); err != nil {
		return Result[Item]{}, err
	}
	if err := createDescriptionReferences(ctx, queries, record, normalized.ReferencedActorIDs); err != nil {
		return Result[Item]{}, err
	}
	for _, actorID := range normalized.AssigneeActorIDs {
		if _, err := queries.CreateWorkItemAssignment(ctx, store.CreateWorkItemAssignmentParams{
			WorkItemID: record.ID, TenantID: tenantID, ActorID: actorID, AssignedByActorID: actor.ID,
		}); err != nil {
			return Result[Item]{}, err
		}
	}
	if err := createActivity(ctx, queries, record.ID, tenantID, "created", actor.ID, "", "", ""); err != nil {
		return Result[Item]{}, err
	}
	items, err := loadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Result[Item]{}, err
	}
	result := Result[Item]{Value: items[0]}
	if result.Value.OriginRoomID != nil {
		if err := appendChangedEvents(ctx, queries, result.Value, actor.ID); err != nil {
			return Result[Item]{}, err
		}
	}
	if err := createReplay(ctx, tx, actor.ID, operation, key, hash, record.ID, http.StatusCreated, result.Value); err != nil {
		return Result[Item]{}, err
	}
	return result, commitResult(ctx, tx, result)
}

func resolveAgentCreateAssignees(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	input CreateInput,
) (map[string]store.Actor, error) {
	actors := make(map[string]store.Actor, len(input.AssigneeActorIDs))
	for _, actorID := range input.AssigneeActorIDs {
		actor, err := queries.GetRoomActorMember(ctx, store.GetRoomActorMemberParams{
			RoomID:  input.OriginRoomID,
			ActorID: actorID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if actor.TenantID != tenantID {
			return nil, ErrNotFound
		}
		actors[actorID] = actor
	}
	return actors, nil
}

func (s *Service) TransitionForAgent(ctx context.Context, agentManagementID, workItemID, key string, input TransitionInput) (Result[Item], error) {
	if input.ExpectedVersion < 1 || !validRequired(input.State, "open", "in_progress", "resolved") {
		return Result[Item]{}, ErrInvalid
	}
	if input.State != "resolved" && input.Resolution != nil || input.Resolution != nil && !validRequired(*input.Resolution, "completed", "failed", "not_planned", "duplicate") {
		return Result[Item]{}, ErrInvalid
	}
	command, err := s.beginAgentCommentCommand(ctx, agentManagementID, workItemID)
	if err != nil {
		return Result[Item]{}, err
	}
	defer command.tx.Rollback(ctx)
	operation := "transition:" + workItemID
	hash := requestHash(input)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	assigned, err := command.queries.IsWorkItemAssignedToActor(ctx, store.IsWorkItemAssignedToActorParams{
		WorkItemID: workItemID, ActorID: command.actor.ID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if !assigned {
		return Result[Item]{}, ErrForbidden
	}
	if command.item.Kind == "task" && command.item.TaskExecutionGeneration.Valid {
		return Result[Item]{}, ErrConflict
	}
	if command.item.Version != input.ExpectedVersion || !transitionAllowed(command.item.State, input.State) {
		return Result[Item]{}, ErrConflict
	}
	resolution := pgtype.Text{}
	if input.State == "resolved" && input.Resolution != nil {
		resolution = optionalText(*input.Resolution)
	}
	record, err := command.queries.TransitionWorkItem(ctx, store.TransitionWorkItemParams{
		State: input.State, Resolution: resolution, UpdatedByActorID: command.actor.ID,
		ID: workItemID, TenantID: command.item.TenantID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if err := document.RecomputeTaskAllActorAccess(
		ctx, command.tx, command.item.TenantID, workItemID, command.actor.ID,
	); err != nil {
		return Result[Item]{}, err
	}
	if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, "state_transitioned", command.actor.ID, command.item.State, input.State, ""); err != nil {
		return Result[Item]{}, err
	}
	result, err := itemCommandResult(ctx, command.queries, record, command.actor.ID)
	if err != nil {
		return Result[Item]{}, err
	}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, workItemID, http.StatusOK, result.Value); err != nil {
		return Result[Item]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func createDescriptionReferences(ctx context.Context, queries *store.Queries, item store.WorkItem, orderedActorIDs []string) error {
	for ordinal, actorID := range orderedActorIDs {
		if err := queries.CreateWorkItemDescriptionReference(ctx, store.CreateWorkItemDescriptionReferenceParams{
			WorkItemID: item.ID, TenantID: item.TenantID, ActorID: actorID, Ordinal: int32(ordinal),
		}); err != nil {
			return err
		}
	}
	return nil
}

func agentActor(ctx context.Context, queries *store.Queries, agentManagementID string) (store.Actor, error) {
	actor, err := queries.GetActiveWorkItemAgentAuthority(ctx, agentManagementID)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Actor{}, ErrNotFound
	}
	return actor, err
}
