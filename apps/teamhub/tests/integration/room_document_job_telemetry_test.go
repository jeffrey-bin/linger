package integration_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	documentservice "github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestRoomDocumentJobTelemetryReportsQueueLeaseAndTerminalEvidence(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, time.Hour, time.Hour,
		roomDocumentRuntimeTestOptions{disableRoomDocumentWorkers: true},
	)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Worker telemetry "+suffix, "worker-telemetry-room-"+suffix)
	status, _, body := env.request(
		alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{},
		"worker-telemetry-document-"+suffix,
	)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	exact := createAvailableRoomDocumentAsset(
		t, env, alice, document.ID, "telemetry-exact-"+suffix, []byte("telemetry exact:"+suffix),
	)
	conflict := createAvailableRoomDocumentAsset(
		t, env, alice, document.ID, "telemetry-conflict-"+suffix, []byte("telemetry expected:"+suffix),
	)
	writeRoomDocumentAssetObject(t, env, conflict.ID, []byte("telemetry conflicting:"+suffix))
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_assets
		SET available_at=clock_timestamp()-interval '1 hour'
		WHERE id=ANY($1)`, []string{exact.ID, conflict.ID}); err != nil {
		t.Fatal(err)
	}
	storage, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	collector := documentservice.NewAssetCollector(
		documentservice.NewWithObjectStore(env.pool, storage),
		documentservice.AssetCollectorOptions{
			UploadStagingRetention: time.Hour, AssetGCGrace: time.Millisecond,
		},
	)
	for attempt := 0; attempt < 2; attempt++ {
		if worked, err := collector.RunOne(t.Context()); !worked || err != nil {
			t.Fatalf("collector telemetry pass %d worked=%v err=%v", attempt+1, worked, err)
		}
	}
	var deletedStatus, deletionIdentity, deletionResult string
	var deletedAt bool
	if err := env.pool.QueryRow(t.Context(), `SELECT status,deletion_identity,
		deletion_result,deleted_at IS NOT NULL
		FROM document_assets WHERE id=$1`, exact.ID).Scan(
		&deletedStatus, &deletionIdentity, &deletionResult, &deletedAt,
	); err != nil {
		t.Fatal(err)
	}
	if deletedStatus != "deleted" || deletionIdentity == "" ||
		deletionResult != "confirmed_absent" || !deletedAt {
		t.Fatalf("deleted Asset evidence status=%s identity=%s result=%s deleted=%t",
			deletedStatus, deletionIdentity, deletionResult, deletedAt)
	}
	var conflictStatus, conflictResult, failureCode, failureHash string
	var quarantinedAt bool
	if err := env.pool.QueryRow(t.Context(), `SELECT status,deletion_result,
		failure_code,failure_evidence_hash,quarantined_at IS NOT NULL
		FROM document_assets WHERE id=$1`, conflict.ID).Scan(
		&conflictStatus, &conflictResult, &failureCode, &failureHash, &quarantinedAt,
	); err != nil {
		t.Fatal(err)
	}
	if conflictStatus != "quarantined" || conflictResult != "hash_conflict" ||
		failureCode != "delete_hash_conflict" || len(failureHash) != 64 || !quarantinedAt {
		t.Fatalf("quarantined Asset evidence status=%s result=%s code=%s hash=%s quarantined=%t",
			conflictStatus, conflictResult, failureCode, failureHash, quarantinedAt)
	}
}
