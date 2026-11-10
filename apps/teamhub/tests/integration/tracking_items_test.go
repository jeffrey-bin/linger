package integration_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

func TestTrackingItemsVersionedOwnerCommands(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	svc := reminder.NewTrackingService(pool)
	owner := reminder.TrackingOwner{TenantID: acmeTenant, ActorID: "actor_acme_alice"}
	vague := "next week"
	fields := reminder.TrackingFields{Kind: "todo", Content: "submit the report", DueText: &vague, SourceRef: "message:one", SourceDate: "2026-10-23", SourceTimezone: "Asia/Shanghai"}
	create := reminder.TrackingCreate{TrackingFields: fields, IdempotencyKey: "report"}
	result, err := svc.Apply(t.Context(), owner, reminder.TrackingChanges{Create: []reminder.TrackingCreate{create}})
	if err != nil {
		t.Fatal(err)
	}
	original := result.Items[0]
	replay, err := svc.Apply(t.Context(), owner, reminder.TrackingChanges{Create: []reminder.TrackingCreate{create}})
	if err != nil || replay.Items[0].ID != original.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	update := reminder.TrackingUpdate{TrackingFields: fields, TrackingVersion: reminder.TrackingVersion{ID: original.ID, ExpectedRevision: 1}, Status: "open"}
	update.Content = "submit the updated report"
	updated, err := svc.Apply(t.Context(), owner, reminder.TrackingChanges{Update: []reminder.TrackingUpdate{update}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Items[0].ID != original.ID || !updated.Items[0].CreatedAt.Equal(original.CreatedAt) || updated.Items[0].Revision != 2 {
		t.Fatal("edit replaced identity or creation time")
	}
	_, err = svc.Apply(t.Context(), owner, reminder.TrackingChanges{Create: []reminder.TrackingCreate{{TrackingFields: fields, IdempotencyKey: "rolled-back"}}, Update: []reminder.TrackingUpdate{update}})
	if !errors.Is(err, reminder.ErrTrackingConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	page, err := svc.List(t.Context(), owner, "", 100, true)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("batch was not atomic: %+v %v", page, err)
	}
	_, err = svc.Done(t.Context(), owner, reminder.TrackingVersion{ID: original.ID, ExpectedRevision: 2})
	if err != nil {
		t.Fatal(err)
	}
	closed, _ := svc.List(t.Context(), owner, "", 100, true)
	if len(closed.Items) != 1 || closed.Items[0].Status != "done" {
		t.Fatal("completed evidence unavailable before cleanup")
	}
	pruned, err := svc.Apply(t.Context(), owner, reminder.TrackingChanges{Prune: true})
	if err != nil || len(pruned.Deleted) != 1 {
		t.Fatalf("cleanup: %+v %v", pruned, err)
	}
}

func TestTrackingItemsPagesAndIndependentExpiry(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	svc := reminder.NewTrackingService(pool)
	owner := reminder.TrackingOwner{TenantID: acmeTenant, ActorID: "actor_acme_alice"}
	future := time.Now().Add(365 * 24 * time.Hour)
	changes := reminder.TrackingChanges{}
	for i := 0; i < 151; i++ {
		changes.Create = append(changes.Create, reminder.TrackingCreate{TrackingFields: reminder.TrackingFields{Kind: "todo", Content: fmt.Sprint("item ", i), DueAt: &future, SourceRef: "message:one", SourceDate: "2026-10-23", SourceTimezone: "UTC"}, IdempotencyKey: fmt.Sprint(i)})
	}
	result, err := svc.Apply(t.Context(), owner, changes)
	if err != nil {
		t.Fatal(err)
	}
	first, err := svc.List(t.Context(), owner, "", 100, false)
	if err != nil || len(first.Items) != 100 || first.NextCursor == "" {
		t.Fatalf("first: %+v %v", first, err)
	}
	second, err := svc.List(t.Context(), owner, first.NextCursor, 100, false)
	if err != nil || len(second.Items) != 51 || second.NextCursor != "" {
		t.Fatalf("second: %+v %v", second, err)
	}
	if _, err = pool.Exec(t.Context(), `UPDATE memory_index.tracking_items SET created_at=now()-interval '4 months' WHERE id=$1`, result.Items[0].ID); err != nil {
		t.Fatal(err)
	}
	pruned, err := svc.Apply(t.Context(), owner, reminder.TrackingChanges{Prune: true})
	if err != nil || len(pruned.Deleted) != 1 {
		t.Fatalf("old creation must expire even with future due: %+v %v", pruned, err)
	}
}
