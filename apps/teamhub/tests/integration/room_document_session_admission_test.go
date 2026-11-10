package integration_test

import (
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	canonicaldocument "github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestRoomDocumentCredentialAdmissionDoesNotConflictAcrossDocuments(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	service := canonicaldocument.New(env.pool)
	documents := make([]roomDocumentResponse, 20)
	for index := range documents {
		documents[index] = createRoomDocumentForSessionAdmission(
			t, env, alice, "credential-concurrency-"+strconv.Itoa(index),
		)
	}

	var workers sync.WaitGroup
	errors := make(chan error, len(documents))
	for _, document := range documents {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := service.IssueCollaborationCredential(t.Context(), canonicaldocument.IssueCollaborationCredentialInput{
				AccountID: "account_alice", DocumentID: document.ID, ExpiresAt: time.Now().Add(time.Hour),
			})
			if err != nil {
				errors <- err
			}
		}()
	}
	workers.Wait()
	close(errors)
	if err := <-errors; err != nil {
		t.Fatalf("concurrent credential admission failed: %v", err)
	}
}

func createRoomDocumentForSessionAdmission(t *testing.T, env *testEnv, client *http.Client, label string) roomDocumentResponse {
	t.Helper()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, client, label+" room "+suffix, label+"-room-"+suffix)
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, label+"-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)
	return document
}
