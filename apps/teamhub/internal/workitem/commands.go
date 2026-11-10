package workitem

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type humanItemCommand struct {
	tx      pgx.Tx
	queries *store.Queries
	actor   store.Actor
	item    store.WorkItem
}

// lockDeliveryScope takes the Work Item's Rooms and then its bound Documents,
// before any Account lock: Rooms -> Documents -> delivery Accounts.
func lockDeliveryScope(ctx context.Context, tx pgx.Tx, queries *store.Queries, item store.WorkItem) error {
	if err := queries.LockWorkItemDeliveryRooms(ctx, store.LockWorkItemDeliveryRoomsParams{
		TenantID: item.TenantID, WorkItemID: item.ID,
	}); err != nil {
		return err
	}
	return document.LockTaskBoundDocuments(ctx, tx, item.TenantID, item.ID)
}

func (s *Service) UpdateForHuman(ctx context.Context, accountID, workItemID, key string, input UpdateInput) (Result[Item], error) {
	normalized, err := normalizeUpdate(input)
	if err != nil {
		return Result[Item]{}, err
	}
	operation := "update:" + workItemID
	hash := requestHash(normalized)
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Item]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	if err := lockDeliveryScope(ctx, command.tx, command.queries, command.item); err != nil {
		return Result[Item]{}, err
	}
	if command.item.Version != normalized.ExpectedVersion {
		return Result[Item]{}, ErrConflict
	}
	title, description, priority := command.item.Title, command.item.Description, command.item.Priority
	if normalized.Title != nil {
		title = *normalized.Title
	}
	if normalized.Description != nil {
		description = *normalized.Description
	}
	if normalized.Priority != nil {
		priority = *normalized.Priority
	}
	var referenceActors map[string]store.Actor
	var affectedReferenceAgentIDs []string
	if normalized.ReferencedActorIDs != nil {
		previous, listErr := command.queries.ListWorkItemDescriptionReferencesByItems(ctx, []string{workItemID})
		if listErr != nil {
			return Result[Item]{}, listErr
		}
		affectedIDs := make(map[string]struct{}, len(previous)+len(*normalized.ReferencedActorIDs))
		for _, reference := range previous {
			affectedIDs[reference.ActorID] = struct{}{}
		}
		for _, actorID := range *normalized.ReferencedActorIDs {
			affectedIDs[actorID] = struct{}{}
		}
		orderedAffectedIDs := make([]string, 0, len(affectedIDs))
		for actorID := range affectedIDs {
			orderedAffectedIDs = append(orderedAffectedIDs, actorID)
		}
		sort.Strings(orderedAffectedIDs)
		affectedActors, resolveErr := resolveActors(
			ctx, command.queries, command.item.TenantID, orderedAffectedIDs,
		)
		if resolveErr != nil {
			return Result[Item]{}, resolveErr
		}
		referenceActors = make(map[string]store.Actor, len(*normalized.ReferencedActorIDs))
		for _, actorID := range *normalized.ReferencedActorIDs {
			referenceActors[actorID] = affectedActors[actorID]
		}
		for _, actorID := range orderedAffectedIDs {
			if affectedActors[actorID].Kind == "agent" {
				affectedReferenceAgentIDs = append(affectedReferenceAgentIDs, actorID)
			}
		}
	}
	record, err := command.queries.UpdateWorkItemMetadata(ctx, store.UpdateWorkItemMetadataParams{
		Title: title, Description: description, Priority: priority,
		UpdatedByActorID: command.actor.ID, ID: workItemID, TenantID: command.item.TenantID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if normalized.ReferencedActorIDs != nil {
		if err := command.queries.DeleteWorkItemDescriptionReferences(ctx, workItemID); err != nil {
			return Result[Item]{}, err
		}
		if err := createDescriptionReferences(ctx, command.queries, record, *normalized.ReferencedActorIDs); err != nil {
			return Result[Item]{}, err
		}
		for _, actorID := range affectedReferenceAgentIDs {
			if err := document.RecomputeTaskActorAccess(
				ctx, command.tx, command.item.TenantID, workItemID, actorID, command.actor.ID,
			); err != nil {
				return Result[Item]{}, err
			}
		}
	}
	if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, "metadata_updated", command.actor.ID, "", "", ""); err != nil {
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

func (s *Service) TransitionForHuman(ctx context.Context, accountID, workItemID, key string, input TransitionInput) (Result[Item], error) {
	if input.ExpectedVersion < 1 || !validRequired(input.State, "open", "in_progress", "resolved") {
		return Result[Item]{}, ErrInvalid
	}
	if input.State != "resolved" && input.Resolution != nil || input.Resolution != nil && !validRequired(*input.Resolution, "completed", "failed", "not_planned", "duplicate") {
		return Result[Item]{}, ErrInvalid
	}
	operation := "transition:" + workItemID
	hash := requestHash(input)
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Item]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
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

func (s *Service) SetArchivedForHuman(ctx context.Context, accountID, workItemID, key string, input VersionInput, archived bool) (Result[Item], error) {
	if input.ExpectedVersion < 1 {
		return Result[Item]{}, ErrInvalid
	}
	action := "unarchive"
	activityKind := "unarchived"
	if archived {
		action = "archive"
		activityKind = "archived"
	}
	operation := action + ":" + workItemID
	hash := requestHash(input)
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Item]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Item]{}, err
	}
	if replay, found, err := lookupReplay[Item](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Item]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	if err := lockDeliveryScope(ctx, command.tx, command.queries, command.item); err != nil {
		return Result[Item]{}, err
	}
	if command.item.Version != input.ExpectedVersion || command.item.ArchivedAt.Valid == archived {
		return Result[Item]{}, ErrConflict
	}
	record, err := command.queries.SetWorkItemArchived(ctx, store.SetWorkItemArchivedParams{
		Archived: archived, UpdatedByActorID: command.actor.ID, ID: workItemID, TenantID: command.item.TenantID,
	})
	if err != nil {
		return Result[Item]{}, err
	}
	if command.item.Kind == "task" {
		if err := agentruntimestate.ReconcileAlterEgoContextsForTaskArchive(ctx, command.queries, workItemID, archived); err != nil {
			return Result[Item]{}, err
		}
	}
	if err := document.RecomputeTaskAllActorAccess(
		ctx, command.tx, command.item.TenantID, workItemID, command.actor.ID,
	); err != nil {
		return Result[Item]{}, err
	}
	if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, activityKind, command.actor.ID, "", "", ""); err != nil {
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

func (s *Service) beginHumanItemCommand(ctx context.Context, accountID, workItemID string) (humanItemCommand, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return humanItemCommand{}, err
	}
	queries := store.New(tx)
	item, err := queries.GetWorkItemForHumanForUpdate(ctx, store.GetWorkItemForHumanForUpdateParams{ID: workItemID, AccountID: accountID})
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return humanItemCommand{}, ErrNotFound
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		return humanItemCommand{}, err
	}
	actor, err := humanActor(ctx, queries, accountID, item.TenantID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return humanItemCommand{}, err
	}
	return humanItemCommand{tx: tx, queries: queries, actor: actor, item: item}, nil
}

func itemCommandResult(ctx context.Context, queries *store.Queries, record store.WorkItem, actorID string) (Result[Item], error) {
	items, err := loadItems(ctx, queries, []store.WorkItem{record})
	if err != nil {
		return Result[Item]{}, err
	}
	if err := appendChangedEvents(ctx, queries, items[0], actorID); err != nil {
		return Result[Item]{}, err
	}
	return Result[Item]{Value: items[0]}, nil
}

func normalizeUpdate(input UpdateInput) (UpdateInput, error) {
	if input.ExpectedVersion < 1 || input.Title == nil && input.Description == nil && input.ReferencedActorIDs == nil && input.Priority == nil {
		return UpdateInput{}, ErrInvalid
	}
	if input.Title != nil {
		trimmed := strings.TrimSpace(*input.Title)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > 240 {
			return UpdateInput{}, ErrInvalid
		}
		input.Title = &trimmed
	}
	if input.Description != nil && utf8.RuneCountInString(*input.Description) > 50000 {
		return UpdateInput{}, ErrInvalid
	}
	if input.Priority != nil && !validRequired(*input.Priority, "low", "medium", "high", "urgent") {
		return UpdateInput{}, ErrInvalid
	}
	if input.ReferencedActorIDs != nil {
		normalized, err := normalizedActorIDs(*input.ReferencedActorIDs)
		if err != nil {
			return UpdateInput{}, err
		}
		input.ReferencedActorIDs = &normalized
	}
	return input, nil
}

func transitionAllowed(from, to string) bool {
	switch from {
	case "open":
		return to == "in_progress" || to == "resolved"
	case "in_progress":
		return to == "open" || to == "resolved"
	case "resolved":
		return to == "open"
	default:
		return false
	}
}
