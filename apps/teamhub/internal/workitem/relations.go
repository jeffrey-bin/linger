package workitem

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) PutAssignmentForHuman(ctx context.Context, accountID, workItemID, targetActorID, key string) (Result[Assignment], error) {
	operation := "put-assignment:" + workItemID + ":" + targetActorID
	hash := requestHash(struct{ WorkItemID, TargetActorID string }{workItemID, targetActorID})
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[Assignment]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[Assignment]{}, err
	}
	if replay, found, err := lookupReplay[Assignment](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[Assignment]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	actors, err := resolveAssignableActors(ctx, command.queries, command.item.TenantID, []string{targetActorID})
	if err != nil {
		return Result[Assignment]{}, err
	}
	record, err := command.queries.GetWorkItemAssignment(ctx, store.GetWorkItemAssignmentParams{WorkItemID: workItemID, ActorID: targetActorID})
	created := false
	if errors.Is(err, pgx.ErrNoRows) {
		record, err = command.queries.CreateWorkItemAssignment(ctx, store.CreateWorkItemAssignmentParams{
			WorkItemID: workItemID, TenantID: command.item.TenantID, ActorID: targetActorID, AssignedByActorID: command.actor.ID,
		})
		created = err == nil
	}
	if err != nil {
		return Result[Assignment]{}, err
	}
	assignedBy, err := command.queries.GetActor(ctx, store.GetActorParams{ID: record.AssignedByActorID, TenantID: command.item.TenantID})
	if err != nil {
		return Result[Assignment]{}, err
	}
	result := Result[Assignment]{Value: Assignment{
		Actor: actorValue(actors[targetActorID]), AssignedBy: actorValue(assignedBy), AssignedAt: record.AssignedAt.Time,
	}}
	if created {
		if err := document.RecomputeTaskActorAccess(
			ctx, command.tx, command.item.TenantID, workItemID, targetActorID, command.actor.ID,
		); err != nil {
			return Result[Assignment]{}, err
		}
		if err := command.queries.TouchWorkItem(ctx, store.TouchWorkItemParams{ID: workItemID, TenantID: command.item.TenantID, UpdatedByActorID: command.actor.ID}); err != nil {
			return Result[Assignment]{}, err
		}
		if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, "assignment_added", command.actor.ID, "", "", targetActorID); err != nil {
			return Result[Assignment]{}, err
		}
		if err := appendActorRelationChangedRoomEvents(ctx, command.queries, workItemID, command.actor.ID, "assignment"); err != nil {
			return Result[Assignment]{}, err
		}
	}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, workItemID, http.StatusOK, result.Value); err != nil {
		return Result[Assignment]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func (s *Service) DeleteAssignmentForHuman(ctx context.Context, accountID, workItemID, targetActorID, key string) (Result[struct{}], error) {
	return s.deleteActorRelationForHuman(ctx, accountID, workItemID, targetActorID, key, "assignment")
}

func (s *Service) PutAccessGrantForHuman(ctx context.Context, accountID, workItemID, targetActorID, key string) (Result[AccessGrant], error) {
	operation := "put-access-grant:" + workItemID + ":" + targetActorID
	hash := requestHash(struct{ WorkItemID, TargetActorID string }{workItemID, targetActorID})
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[AccessGrant]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[AccessGrant]{}, err
	}
	if replay, found, err := lookupReplay[AccessGrant](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[AccessGrant]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	actors, err := resolveActors(ctx, command.queries, command.item.TenantID, []string{targetActorID})
	if err != nil {
		return Result[AccessGrant]{}, err
	}
	if actors[targetActorID].Kind != "agent" {
		return Result[AccessGrant]{}, ErrInvalid
	}
	record, err := command.queries.GetWorkItemAccessGrant(ctx, store.GetWorkItemAccessGrantParams{WorkItemID: workItemID, ActorID: targetActorID})
	created := false
	if errors.Is(err, pgx.ErrNoRows) {
		record, err = command.queries.CreateWorkItemAccessGrant(ctx, store.CreateWorkItemAccessGrantParams{
			WorkItemID: workItemID, TenantID: command.item.TenantID, ActorID: targetActorID, GrantedByActorID: command.actor.ID,
		})
		created = err == nil
	}
	if err != nil {
		return Result[AccessGrant]{}, err
	}
	grantedBy, err := command.queries.GetActor(ctx, store.GetActorParams{ID: record.GrantedByActorID, TenantID: command.item.TenantID})
	if err != nil {
		return Result[AccessGrant]{}, err
	}
	result := Result[AccessGrant]{Value: AccessGrant{
		Actor: actorValue(actors[targetActorID]), GrantedBy: actorValue(grantedBy), GrantedAt: record.GrantedAt.Time,
	}}
	if created {
		if err := document.RecomputeTaskActorAccess(
			ctx, command.tx, command.item.TenantID, workItemID, targetActorID, command.actor.ID,
		); err != nil {
			return Result[AccessGrant]{}, err
		}
		if err := command.queries.TouchWorkItem(ctx, store.TouchWorkItemParams{ID: workItemID, TenantID: command.item.TenantID, UpdatedByActorID: command.actor.ID}); err != nil {
			return Result[AccessGrant]{}, err
		}
		if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, "access_grant_added", command.actor.ID, "", "", targetActorID); err != nil {
			return Result[AccessGrant]{}, err
		}
		if err := appendActorRelationChangedRoomEvents(ctx, command.queries, workItemID, command.actor.ID, "access-grant"); err != nil {
			return Result[AccessGrant]{}, err
		}
	}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, workItemID, http.StatusOK, result.Value); err != nil {
		return Result[AccessGrant]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func (s *Service) DeleteAccessGrantForHuman(ctx context.Context, accountID, workItemID, targetActorID, key string) (Result[struct{}], error) {
	return s.deleteActorRelationForHuman(ctx, accountID, workItemID, targetActorID, key, "access-grant")
}

func (s *Service) deleteActorRelationForHuman(ctx context.Context, accountID, workItemID, targetActorID, key, relation string) (Result[struct{}], error) {
	operation := "delete-" + relation + ":" + workItemID + ":" + targetActorID
	hash := requestHash(struct{ WorkItemID, TargetActorID string }{workItemID, targetActorID})
	command, err := s.beginHumanItemCommand(ctx, accountID, workItemID)
	if err != nil {
		return Result[struct{}]{}, err
	}
	defer command.tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, command.tx, idempotency.ActorKey(command.actor.ID, operation, key)); err != nil {
		return Result[struct{}]{}, err
	}
	if replay, found, err := lookupReplay[struct{}](ctx, command.tx, command.actor.ID, operation, key, hash); err != nil {
		return Result[struct{}]{}, err
	} else if found {
		return replay, commitResult(ctx, command.tx, replay)
	}
	actors, err := resolveActors(ctx, command.queries, command.item.TenantID, []string{targetActorID})
	if err != nil {
		return Result[struct{}]{}, err
	}
	var rows int64
	activityKind := "assignment_removed"
	if relation == "access-grant" {
		if actors[targetActorID].Kind != "agent" {
			return Result[struct{}]{}, ErrInvalid
		}
		rows, err = command.queries.DeleteWorkItemAccessGrant(ctx, store.DeleteWorkItemAccessGrantParams{WorkItemID: workItemID, ActorID: targetActorID})
		activityKind = "access_grant_removed"
	} else {
		rows, err = command.queries.DeleteWorkItemAssignment(ctx, store.DeleteWorkItemAssignmentParams{WorkItemID: workItemID, ActorID: targetActorID})
	}
	if err != nil {
		return Result[struct{}]{}, err
	}
	if rows > 0 {
		if err := document.RecomputeTaskActorAccess(
			ctx, command.tx, command.item.TenantID, workItemID, targetActorID, command.actor.ID,
		); err != nil {
			return Result[struct{}]{}, err
		}
		if err := command.queries.TouchWorkItem(ctx, store.TouchWorkItemParams{ID: workItemID, TenantID: command.item.TenantID, UpdatedByActorID: command.actor.ID}); err != nil {
			return Result[struct{}]{}, err
		}
		if err := createActivity(ctx, command.queries, workItemID, command.item.TenantID, activityKind, command.actor.ID, "", "", targetActorID); err != nil {
			return Result[struct{}]{}, err
		}
	}
	result := Result[struct{}]{Value: struct{}{}}
	if rows > 0 {
		if err := appendActorRelationChangedRoomEvents(ctx, command.queries, workItemID, command.actor.ID, relation); err != nil {
			return Result[struct{}]{}, err
		}
	}
	if err := createReplay(ctx, command.tx, command.actor.ID, operation, key, hash, workItemID, http.StatusNoContent, result.Value); err != nil {
		return Result[struct{}]{}, err
	}
	return result, commitResult(ctx, command.tx, result)
}

func appendActorRelationChangedRoomEvents(
	ctx context.Context,
	queries *store.Queries,
	workItemID string,
	actorID string,
	relation string,
) error {
	record, err := queries.GetTypedCardWorkItem(ctx, workItemID)
	if err != nil {
		return err
	}
	if relation == "assignment" {
		return appendProjectionChangedRoomEventsForRecord(ctx, queries, record, actorID)
	}
	item, err := LoadItem(ctx, queries, record)
	if err != nil {
		return err
	}
	return appendChangedEvents(ctx, queries, item, actorID)
}
