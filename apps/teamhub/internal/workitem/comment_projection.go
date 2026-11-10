package workitem

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func loadComments(ctx context.Context, queries *store.Queries, records []store.WorkItemComment) ([]Comment, error) {
	if len(records) == 0 {
		return []Comment{}, nil
	}
	authorIDs := make([]string, 0, len(records))
	seen := map[string]struct{}{}
	for _, record := range records {
		if _, exists := seen[record.AuthorActorID]; !exists {
			seen[record.AuthorActorID] = struct{}{}
			authorIDs = append(authorIDs, record.AuthorActorID)
		}
	}
	actors, err := queries.ListActorsByTenantIDs(ctx, store.ListActorsByTenantIDsParams{
		TenantID: records[0].TenantID, ActorIds: authorIDs,
	})
	if err != nil {
		return nil, err
	}
	authorMap := make(map[string]Actor, len(actors))
	for _, actor := range actors {
		authorMap[actor.ID] = actorValue(actor)
	}
	if len(authorMap) != len(authorIDs) {
		return nil, errors.New("Work Item Comment references a missing author")
	}
	comments := make([]Comment, 0, len(records))
	for _, record := range records {
		var segments []CommentSegment
		if err := json.Unmarshal(record.Segments, &segments); err != nil {
			return nil, err
		}
		if segments == nil {
			segments = []CommentSegment{}
		}
		comment := Comment{
			ID: record.ID, TenantID: record.TenantID, WorkItemID: record.WorkItemID,
			Author: authorMap[record.AuthorActorID], Body: record.Body, Segments: segments,
			Version: record.Version, CreatedAt: record.CreatedAt.Time, UpdatedAt: record.UpdatedAt.Time,
		}
		if record.DeletedAt.Valid {
			comment.DeletedAt = &record.DeletedAt.Time
		}
		comments = append(comments, comment)
	}
	return comments, nil
}

func loadComment(ctx context.Context, queries *store.Queries, record store.WorkItemComment) (Comment, error) {
	comments, err := loadComments(ctx, queries, []store.WorkItemComment{record})
	if err != nil {
		return Comment{}, err
	}
	return comments[0], nil
}
