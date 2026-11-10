package workitem

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func loadItems(ctx context.Context, queries *store.Queries, records []store.WorkItem) ([]Item, error) {
	if len(records) == 0 {
		return []Item{}, nil
	}
	workItemIDs := make([]string, 0, len(records))
	actorIDs := map[string]struct{}{}
	for _, record := range records {
		workItemIDs = append(workItemIDs, record.ID)
		actorIDs[record.CreatedByActorID] = struct{}{}
		actorIDs[record.UpdatedByActorID] = struct{}{}
	}
	references, err := queries.ListWorkItemDescriptionReferencesByItems(ctx, workItemIDs)
	if err != nil {
		return nil, err
	}
	assignments, err := queries.ListWorkItemAssignmentsByItems(ctx, workItemIDs)
	if err != nil {
		return nil, err
	}
	grants, err := queries.ListWorkItemAccessGrantsByItems(ctx, workItemIDs)
	if err != nil {
		return nil, err
	}
	roomLinks, err := queries.ListWorkItemRoomLinksByItems(ctx, workItemIDs)
	if err != nil {
		return nil, err
	}
	for _, reference := range references {
		actorIDs[reference.ActorID] = struct{}{}
	}
	for _, assignment := range assignments {
		actorIDs[assignment.ActorID] = struct{}{}
		actorIDs[assignment.AssignedByActorID] = struct{}{}
	}
	for _, grant := range grants {
		actorIDs[grant.ActorID] = struct{}{}
		actorIDs[grant.GrantedByActorID] = struct{}{}
	}
	ids := make([]string, 0, len(actorIDs))
	for actorID := range actorIDs {
		ids = append(ids, actorID)
	}
	actors, err := queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{TenantID: records[0].TenantID, ActorIds: ids})
	if err != nil {
		return nil, err
	}
	actorMap := make(map[string]Actor, len(actors))
	for _, actor := range actors {
		actorMap[actor.ID] = actorValue(actor)
	}
	if len(actorMap) != len(actorIDs) {
		return nil, errors.New("work item projection references a missing actor")
	}
	referenceMap := make(map[string][]Actor, len(records))
	for _, reference := range references {
		referenceMap[reference.WorkItemID] = append(referenceMap[reference.WorkItemID], actorMap[reference.ActorID])
	}
	assignmentMap := make(map[string][]Assignment, len(records))
	for _, assignment := range assignments {
		assignmentMap[assignment.WorkItemID] = append(assignmentMap[assignment.WorkItemID], Assignment{
			Actor: actorMap[assignment.ActorID], AssignedBy: actorMap[assignment.AssignedByActorID],
			AssignedAt: assignment.AssignedAt.Time,
		})
	}
	grantMap := make(map[string][]AccessGrant, len(records))
	for _, grant := range grants {
		grantMap[grant.WorkItemID] = append(grantMap[grant.WorkItemID], AccessGrant{
			Actor: actorMap[grant.ActorID], GrantedBy: actorMap[grant.GrantedByActorID],
			GrantedAt: grant.GrantedAt.Time,
		})
	}
	roomLinkMap := make(map[string][]store.WorkItemRoomLink, len(records))
	for _, link := range roomLinks {
		roomLinkMap[link.WorkItemID] = append(roomLinkMap[link.WorkItemID], link)
	}
	items := make([]Item, 0, len(records))
	for _, record := range records {
		item := Item{
			ID: record.ID, TenantID: record.TenantID, Number: record.Number, Kind: record.Kind,
			Title: record.Title, Description: record.Description, Priority: record.Priority,
			State: record.State, Version: record.Version,
			CreatedBy: actorMap[record.CreatedByActorID], UpdatedBy: actorMap[record.UpdatedByActorID],
			ReferencedActors:     nonNilActors(referenceMap[record.ID]),
			Assignees:            nonNilAssignments(assignmentMap[record.ID]),
			ExplicitAccessGrants: nonNilAccessGrants(grantMap[record.ID]),
			CreatedAt:            record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
		}
		if record.Resolution.Valid {
			item.Resolution = &record.Resolution.String
		}
		if record.ArchivedAt.Valid {
			item.ArchivedAt = &record.ArchivedAt.Time
		}
		if record.TaskExecutionGeneration.Valid {
			item.TaskExecution = &TaskExecutionSummary{
				Generation:             record.TaskExecutionGeneration.Int64,
				Status:                 record.TaskExecutionStatus.String,
				ExecutionRevision:      record.TaskExecutionRevision.Int64,
				ReasonCode:             optionalProjectionText(record.TaskExecutionReasonCode),
				DesiredControl:         record.TaskDesiredControl.String,
				ControlRevision:        record.TaskControlRevision.Int64,
				ControlSettledRevision: record.TaskControlSettledRevision.Int64,
				PendingControl:         record.TaskControlRevision.Int64 > record.TaskControlSettledRevision.Int64,
				ControlOutcome:         optionalProjectionText(record.TaskControlOutcome),
				ExecutionUpdatedAt:     record.TaskExecutionUpdatedAt.Time,
			}
		}
		for _, link := range roomLinkMap[record.ID] {
			roomID := link.RoomID
			switch link.LinkType {
			case "origin":
				item.OriginRoomID = &roomID
				if link.OriginMessageID.Valid {
					messageID := link.OriginMessageID.String
					item.OriginMessageID = &messageID
				}
			case "work":
				item.WorkRoomID = &roomID
			}
		}
		items = append(items, item)
	}
	return items, nil
}

func optionalProjectionText(value pgtype.Text) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

func actorValue(actor store.Actor) Actor {
	return Actor{ID: actor.ID, TenantID: actor.TenantID, Kind: actor.Kind, DisplayName: actor.DisplayName}
}

func nonNilActors(values []Actor) []Actor {
	if values == nil {
		return []Actor{}
	}
	return values
}

func nonNilAssignments(values []Assignment) []Assignment {
	if values == nil {
		return []Assignment{}
	}
	return values
}

func nonNilAccessGrants(values []AccessGrant) []AccessGrant {
	if values == nil {
		return []AccessGrant{}
	}
	return values
}
