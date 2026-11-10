package workitem

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomattention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type workItemChangedPayload struct {
	Kind       string `json:"kind"`
	WorkItemID string `json:"work_item_id"`
	Version    int64  `json:"version"`
}

// ChangeEventContext is the stable Work Item identity needed to append its Room Event.
type ChangeEventContext struct {
	TenantID     string
	WorkItemID   string
	OriginRoomID *string
	Version      int64
}

// AppendChangedRoomEvent records a Work Item change in its Origin Room
// transaction and returns that Room's sequence, or 0 without an Origin Room.
func AppendChangedRoomEvent(ctx context.Context, queries *store.Queries, change ChangeEventContext, actorID string) (int64, error) {
	originRoomID := ""
	if change.OriginRoomID != nil {
		originRoomID = *change.OriginRoomID
	}
	// Callers also notify Tenant Humans outside the Origin Room. Lock that
	// complete audience before the Room Event allocates its narrower delivery.
	if err := queries.LockWorkItemDeliveryAccounts(ctx, store.LockWorkItemDeliveryAccountsParams{
		TenantID: change.TenantID, WorkItemID: change.WorkItemID, OriginRoomID: originRoomID,
	}); err != nil {
		return 0, err
	}
	if change.OriginRoomID == nil {
		return 0, nil
	}
	return roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: change.TenantID, RoomID: *change.OriginRoomID, EventType: "work_item.changed",
		ActorID: actorID, ResourceID: change.WorkItemID,
		Payload: workItemChangedPayload{
			Kind: "work_item.changed", WorkItemID: change.WorkItemID, Version: change.Version,
		},
	})
}

// appendChangedEvents records the change in the Origin Room and refreshes each
// Tenant Human's summary of it; without an Origin Room the Tenant's Work Item
// list changes instead.
func appendChangedEvents(ctx context.Context, queries *store.Queries, item Item, actorID string) error {
	roomSeq, err := AppendChangedRoomEvent(ctx, queries, ChangeEventContext{
		TenantID: item.TenantID, WorkItemID: item.ID, OriginRoomID: item.OriginRoomID,
		Version: item.Version,
	}, actorID)
	if err != nil {
		return err
	}
	if roomSeq == 0 {
		return account.FanoutTenantAccountDeliveries(ctx, queries, item.TenantID, "tenant.work-items.changed", map[string]string{
			"kind": "tenant.work-items.changed", "tenant_id": item.TenantID,
		})
	}
	return roomattention.AppendForTenantHumans(ctx, queries, roomattention.RoomSummaryUpdate{
		TenantID: item.TenantID, RoomID: *item.OriginRoomID, RoomSeq: roomSeq, Reason: "work_item.changed",
	})
}

func appendProjectionChangedRoomEventsForRecord(ctx context.Context, queries *store.Queries, record store.WorkItem, actorID string) error {
	refreshed, err := queries.GetTypedCardWorkItem(ctx, record.ID)
	if err != nil {
		return err
	}
	item, err := LoadItem(ctx, queries, refreshed)
	if err != nil {
		return err
	}
	return appendChangedEvents(ctx, queries, item, actorID)
}
