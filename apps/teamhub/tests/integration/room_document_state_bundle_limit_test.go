package integration_test

import (
	"bytes"
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentRecoveryBudgetGuards(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("room create", testCreateRoomDocumentRejectsStateThatCannotFitRecoveryBundle)
	t.Run("largest state", testLargestDocumentStateSavesAndOpensWithinTheRequestLimit)
}

// A state at the budget loads and saves; the Runtime's preflight refuses one
// byte more before any save.
func testLargestDocumentStateSavesAndOpensWithinTheRequestLimit(t *testing.T) {
	emptyReferences := len(`{"document_asset_ids":[],"document_thread_ids":[]}`)
	// The fake Runtime materializes with a one-byte state vector, and the
	// save below uses one too.
	largest := document.BundleDecodedBytesLimit - 1 - emptyReferences
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		blankStateBytes: bytes.Repeat([]byte{1}, largest),
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Largest state "+suffix, "largest-state-room-"+suffix)
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{},
		"largest-state-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create largest Room Document status=%d body=%.512s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	loaded, ok := loadRuntimeDocumentBody(t, env, document.ID)
	if !ok || len(loaded.State) != largest {
		t.Fatalf("loaded state has %d bytes, want %d", len(loaded.State), largest)
	}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: document.ID, BaseSeq: 0, State: bytes.Repeat([]byte{2}, largest),
		StateVector: []byte{1}, EditorIDs: []string{"actor_acme_alice"},
	}); err != nil || !saved {
		t.Fatalf("save largest state saved=%t error=%v", saved, err)
	}
}

func testCreateRoomDocumentRejectsStateThatCannotFitRecoveryBundle(t *testing.T) {
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		blankStateBytes: make([]byte, 17<<20),
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Oversized bundle "+suffix, "oversized-bundle-room-"+suffix)
	idempotencyKey := "oversized-bundle-document-" + suffix
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, idempotencyKey)
	if status != http.StatusRequestEntityTooLarge || !strings.Contains(string(body), "PAYLOAD_TOO_LARGE") {
		t.Fatalf("oversized Room Document status=%d body=%s", status, body)
	}
	var idempotencyRows int
	if err := env.pool.QueryRow(
		context.Background(),
		`SELECT count(*) FROM command_replays WHERE scope='account:'||$1 AND operation=$2 AND key=$3`,
		"account_acme_alice",
		"document.create.room",
		idempotencyKey,
	).Scan(&idempotencyRows); err != nil {
		t.Fatal(err)
	}
	if idempotencyRows != 0 {
		t.Fatalf("oversized create persisted %d idempotency rows", idempotencyRows)
	}
}
