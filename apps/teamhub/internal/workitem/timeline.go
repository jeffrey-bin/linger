package workitem

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) ListTimelineForHuman(ctx context.Context, accountID, workItemID, cursor string, limit int32) (TimelinePage, error) {
	if limit < 1 || limit > 200 || len(cursor) > 1024 {
		return TimelinePage{}, ErrInvalid
	}
	cursorTime, cursorID, err := decodePageCursor(cursor)
	if err != nil {
		return TimelinePage{}, ErrInvalid
	}
	queries := store.New(s.pool)
	if _, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{ID: workItemID, AccountID: accountID}); errors.Is(err, pgx.ErrNoRows) {
		return TimelinePage{}, ErrNotFound
	} else if err != nil {
		return TimelinePage{}, err
	}
	references, err := queries.ListWorkItemTimelineRefs(ctx, store.ListWorkItemTimelineRefsParams{
		WorkItemID: workItemID, HasCursor: cursor != "",
		CursorOccurredAt: pgtype.Timestamptz{Time: cursorTime, Valid: cursor != ""},
		CursorID:         cursorID, PageLimit: limit + 1,
	})
	if err != nil {
		return TimelinePage{}, err
	}
	hasMore := len(references) > int(limit)
	if hasMore {
		references = references[:limit]
	}
	entries := make([]TimelineEntry, 0, len(references))
	for _, reference := range references {
		switch reference.EntryType {
		case "comment":
			record, err := queries.GetWorkItemComment(ctx, store.GetWorkItemCommentParams{ID: reference.EntryID, WorkItemID: workItemID})
			if err != nil {
				return TimelinePage{}, err
			}
			comment, err := loadComment(ctx, queries, record)
			if err != nil {
				return TimelinePage{}, err
			}
			entries = append(entries, TimelineEntry{Type: "comment", Comment: &comment})
		case "activity":
			record, err := queries.GetWorkItemActivity(ctx, store.GetWorkItemActivityParams{ID: reference.EntryID, WorkItemID: workItemID})
			if err != nil {
				return TimelinePage{}, err
			}
			actor, err := queries.GetActor(ctx, store.GetActorParams{ID: record.ActorID, TenantID: record.TenantID})
			if err != nil {
				return TimelinePage{}, err
			}
			activity, err := activityValue(record, actorValue(actor))
			if err != nil {
				return TimelinePage{}, err
			}
			entries = append(entries, TimelineEntry{Type: "activity", Activity: &activity})
		default:
			return TimelinePage{}, errors.New("unknown Work Item timeline entry type")
		}
	}
	page := TimelinePage{Items: entries, HasMore: hasMore}
	if hasMore {
		last := references[len(references)-1]
		page.NextCursor = encodePageCursorValue(last.OccurredAt.Time, last.EntryID)
	}
	return page, nil
}

func activityValue(record store.GetWorkItemActivityRow, actor Actor) (Activity, error) {
	details := make(map[string]any)
	if len(record.Details) > 0 {
		if err := json.Unmarshal(record.Details, &details); err != nil {
			return Activity{}, err
		}
	}
	activity := Activity{
		ID: record.ID, WorkItemID: record.WorkItemID, Kind: record.Kind,
		Actor: actor, Details: details, OccurredAt: record.OccurredAt.Time,
	}
	if record.FromState.Valid {
		activity.FromState = &record.FromState.String
	}
	if record.ToState.Valid {
		activity.ToState = &record.ToState.String
	}
	if record.TargetActorID.Valid {
		activity.TargetActorID = &record.TargetActorID.String
	}
	if record.CommentID.Valid {
		activity.CommentID = &record.CommentID.String
	}
	if record.RoomID.Valid {
		activity.RoomID = &record.RoomID.String
	}
	return activity, nil
}
