package idempotency

import (
	"context"
	"testing"
)

// An empty client key never reaches the database, so a nil transaction
// proves no record is read or written.
func TestEmptyClientKeyKeepsNoRecord(t *testing.T) {
	ctx := context.Background()
	k := AccountKey("account_a", "createRoom:tenant_a", "")
	if err := Lock(ctx, nil, k); err != nil {
		t.Fatalf("Lock: %v", err)
	}
	if _, found, err := Lookup(ctx, nil, k, []byte("hash")); err != nil || found {
		t.Fatalf("Lookup found=%t err=%v", found, err)
	}
	if _, found, err := Replay(ctx, nil, k, []byte("hash")); err != nil || found {
		t.Fatalf("Replay found=%t err=%v", found, err)
	}
	if _, _, found, err := Stored(ctx, nil, k); err != nil || found {
		t.Fatalf("Stored found=%t err=%v", found, err)
	}
	if _, found, err := LookupForUpdate(ctx, nil, k, []byte("hash")); err != nil || found {
		t.Fatalf("LookupForUpdate found=%t err=%v", found, err)
	}
	if err := Save(ctx, nil, k, []byte("hash"), Record{Status: 201}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Reserve(ctx, nil, k, []byte("hash"), Record{Status: 202}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := Complete(ctx, nil, k, Record{Status: 200}); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if err := DeleteReserved(ctx, nil, k); err != nil {
		t.Fatalf("DeleteReserved: %v", err)
	}
}
