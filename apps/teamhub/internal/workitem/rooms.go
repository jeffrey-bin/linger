package workitem

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func validateOriginLink(ctx context.Context, queries *store.Queries, tenantID, actorID string, input CreateInput) error {
	if input.OriginRoomID == "" {
		return nil
	}
	member, err := queries.GetRoomActorMember(ctx, store.GetRoomActorMemberParams{
		RoomID: input.OriginRoomID, ActorID: actorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if member.TenantID != tenantID {
		return ErrNotFound
	}
	return nil
}

func createOriginLink(ctx context.Context, queries *store.Queries, item store.WorkItem, actorID string, input CreateInput) error {
	if input.OriginRoomID == "" {
		return nil
	}
	if _, err := queries.LockActiveRoomForMutation(ctx, input.OriginRoomID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	_, err := queries.CreateWorkItemRoomLink(ctx, store.CreateWorkItemRoomLinkParams{
		WorkItemID: item.ID, TenantID: item.TenantID, LinkType: "origin",
		RoomID: input.OriginRoomID, OriginMessageID: pgtype.Text{},
		LinkedByActorID: actorID,
	})
	return err
}
