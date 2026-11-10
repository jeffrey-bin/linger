package integration_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// These tests hold the TeamHub half of Room Document acceptance scenarios that
// the browser suite used to drive through a real Document Runtime. The Runtime
// half lives in apps/node-services/tests/document/realtime-acceptance.api.test.ts.

func TestDocumentRuntimePersistsADeletionThatKeepsTheStateVector(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Pure deletion "+suffix, "pure-deletion-room-"+suffix)
	documentID := createAcceptanceRoomDocument(t, env, alice, roomID, "pure-deletion-document-"+suffix)
	session := openAcceptanceDocumentSession(t, env, alice, documentID, "document_runtime_pure_deletion")

	stateVector := "AQ=="
	inserted := appendAcceptanceDocumentUpdate(t, env, session, acceptanceAppend{
		batchID: "document_batch_insert_" + suffix, base: 0,
		update: []byte{5, 6, 7, 8}, stateVector: stateVector,
	})
	deleted := appendAcceptanceDocumentUpdate(t, env, session, acceptanceAppend{
		batchID: "document_batch_delete_" + suffix, base: 1,
		update: []byte{9, 10}, stateVector: stateVector,
	})
	if inserted.PersistedSeq != 1 || deleted.PersistedSeq != 2 ||
		deleted.StateVector != inserted.StateVector || deleted.StateHash == inserted.StateHash {
		t.Fatalf("deletion with an unchanged state vector was not persisted: inserted=%+v deleted=%+v", inserted, deleted)
	}

	reopened := openAcceptanceDocumentSession(t, env, alice, documentID, "document_runtime_pure_deletion")
	if reopened.Head.PersistedSeq != 2 || reopened.Head.StateVector != stateVector || reopened.Head.StateHash != deleted.StateHash {
		t.Fatalf("reopened head lost the deletion: %+v", reopened.Head)
	}
}

func TestTrashingDocumentIsUnavailableBeforeAndAfterRuntimeFenceAcknowledgement(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Trash visibility "+suffix, "trash-visibility-room-"+suffix)
	documentID := createAcceptanceRoomDocument(t, env, alice, roomID, "trash-visibility-document-"+suffix)

	status, _, body := env.request(alice, http.MethodDelete, "/v0/documents/"+documentID, nil, "trash-visibility-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("begin Document trash status=%d body=%s", status, body)
	}
	assertAcceptanceDocumentUnavailable(t, env, alice, roomID, documentID, "before Runtime ACK")

	assertAcceptanceDocumentUnavailable(t, env, alice, roomID, documentID, "after Runtime ACK")
}

// A removed member's connection token stays stale after readmission: the
// readmitted member opens connections only with a newly issued token.
func TestReadmittedMemberOpensADocumentOnlyWithANewToken(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	bob := seedPeerHuman(t, env)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Readmission epoch "+suffix, "readmission-epoch-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("add Bob status=%d body=%s", status, body)
	}
	documentID := createAcceptanceRoomDocument(t, env, alice, roomID, "readmission-epoch-document-"+suffix)
	runtimeInstanceID := "document_runtime_readmission_" + suffix
	revoked := openAcceptanceDocumentSession(t, env, bob, documentID, runtimeInstanceID)

	status, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_bob", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("begin Bob removal status=%d body=%s", status, body)
	}
	if count := revoked.currentPermissionCount(t, env, runtimeInstanceID); count == revoked.PermissionCount {
		t.Fatalf("member removal left the permission count at the token's %d", count)
	}
	// The removal finished in its transaction, so Bob can be readmitted at once.
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
		t.Fatalf("readmission status=%d body=%s", status, body)
	}
	readmitted := openAcceptanceDocumentSession(t, env, bob, documentID, runtimeInstanceID)
	if readmitted.PermissionCount == revoked.PermissionCount {
		t.Fatalf("readmitted member's token reused permission count %d", revoked.PermissionCount)
	}
	if count := revoked.currentPermissionCount(t, env, runtimeInstanceID); count == revoked.PermissionCount {
		t.Fatalf("the removed member's token matches the permission count %d after readmission", count)
	}
}

type acceptanceDocumentHead struct {
	PersistedSeq int64  `json:"persisted_seq"`
	StateVector  string `json:"state_vector"`
	StateHash    string `json:"state_hash"`
}

type acceptanceDocumentSession struct {
	DocumentID      string
	ActorID         string
	PermissionCount int64
	Head            acceptanceDocumentHead
}

// currentPermissionCount is the count the Runtime compares the token's with.
func (session acceptanceDocumentSession) currentPermissionCount(t *testing.T, env *testEnv, _ string) int64 {
	t.Helper()
	loaded, ok := loadRuntimeDocumentBody(t, env, session.DocumentID)
	if !ok {
		t.Fatalf("Document %s has no loadable body", session.DocumentID)
	}
	return loaded.PermissionCount
}

func acceptanceHead(body runtimeDocumentBody) acceptanceDocumentHead {
	digest := sha256.Sum256(body.State)
	return acceptanceDocumentHead{
		PersistedSeq: body.Seq, StateVector: base64.StdEncoding.EncodeToString(body.StateVector),
		StateHash: hex.EncodeToString(digest[:]),
	}
}

type acceptanceAppend struct {
	batchID     string
	base        int64
	update      []byte
	stateVector string
}

func createAcceptanceRoomDocument(t *testing.T, env *testEnv, owner *http.Client, roomID, key string) string {
	t.Helper()
	status, _, body := env.request(owner, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, key)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	return document.ID
}

func openAcceptanceDocumentSession(t *testing.T, env *testEnv, actor *http.Client, documentID, runtimeInstanceID string) acceptanceDocumentSession {
	t.Helper()
	status, _, body := env.request(actor, http.MethodPost, "/v0/documents/"+documentID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)
	claims := credential.claims(t)
	session := acceptanceDocumentSession{
		DocumentID: documentID, ActorID: claims.ActorID, PermissionCount: claims.PermissionCount,
	}
	loaded, ok := loadRuntimeDocumentBody(t, env, documentID)
	if !ok || loaded.PermissionCount != claims.PermissionCount {
		t.Fatalf("loaded body=%+v ok=%t token count=%d", loaded, ok, claims.PermissionCount)
	}
	session.Head = acceptanceHead(loaded)
	return session
}

// appendAcceptanceDocumentUpdate saves the body as the Runtime does.
func appendAcceptanceDocumentUpdate(t *testing.T, env *testEnv, session acceptanceDocumentSession, input acceptanceAppend) acceptanceDocumentHead {
	t.Helper()
	vector, err := base64.StdEncoding.DecodeString(input.stateVector)
	if err != nil {
		t.Fatal(err)
	}
	if _, saved, err := saveDocumentBody(t.Context(), env.pool, documentBodySave{
		DocumentID: session.DocumentID, BaseSeq: input.base, State: input.update,
		StateVector: vector, EditorIDs: []string{session.ActorID},
	}); err != nil || !saved {
		t.Fatalf("save %s saved=%t error=%v", input.batchID, saved, err)
	}
	loaded, _ := loadRuntimeDocumentBody(t, env, session.DocumentID)
	return acceptanceHead(loaded)
}

func assertAcceptanceDocumentUnavailable(t *testing.T, env *testEnv, owner *http.Client, roomID, documentID, phase string) {
	t.Helper()
	if status, _, body := env.request(owner, http.MethodGet, "/v0/documents/"+documentID, nil, ""); status != http.StatusNotFound {
		t.Fatalf("Document %s status=%d body=%s", phase, status, body)
	}
	status, _, body := env.request(owner, http.MethodGet, "/v0/rooms/"+roomID+"/documents?limit=100", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Room Documents %s status=%d body=%s", phase, status, body)
	}
	var page struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	decode(t, body, &page)
	for _, item := range page.Items {
		if item.ID == documentID {
			t.Fatalf("trashing Document is still listed %s", phase)
		}
	}
	if status, _, body := env.request(owner, http.MethodPost, "/v0/documents/"+documentID+"/collaboration-credentials", nil, ""); status != http.StatusNotFound {
		t.Fatalf("collaboration credential %s status=%d body=%s", phase, status, body)
	}
}
