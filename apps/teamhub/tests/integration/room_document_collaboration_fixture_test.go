package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// mutationLinearizationFixture is one Room Document with a connection token.
type mutationLinearizationFixture struct {
	document   roomDocumentResponse
	credential roomDocumentCollaborationCredential
	authorID   string
	roomID     string
	suffix     string
}

type mutationLinearizationHTTPResult struct {
	status int
	body   []byte
	err    error
}

func newMutationLinearizationFixture(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	member *http.Client,
	label string,
) mutationLinearizationFixture {
	t.Helper()
	suffix := label + "-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Mutation linearization "+suffix, "mutation-linearization-room-"+suffix)
	if member != alice {
		if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_bob", "member"); status != http.StatusOK {
			t.Fatalf("add member status=%d body=%s", status, body)
		}
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "mutation-linearization-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var created roomDocumentResponse
	decode(t, body, &created)
	status, _, body = env.request(member, http.MethodPost, "/v0/documents/"+created.ID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)
	return mutationLinearizationFixture{
		document: created, credential: credential, authorID: credential.claims(t).ActorID,
		roomID: roomID, suffix: suffix,
	}
}

// collaborationLockOrderSave is one Runtime save of the fixture Document.
func collaborationLockOrderSave(
	fixture mutationLinearizationFixture,
	iteration int,
	basePersistedSeq int64,
) documentBodySave {
	return documentBodySave{
		DocumentID: fixture.document.ID, BaseSeq: basePersistedSeq,
		State:       []byte(fmt.Sprintf("lock-order-state-%s-%d", fixture.suffix, iteration)),
		StateVector: []byte(fmt.Sprintf("lock-order-vector-%d", iteration)),
		EditorIDs:   []string{fixture.authorID},
	}
}

func deleteLinearizationResource(client *http.Client, endpoint, idempotencyKey string) mutationLinearizationHTTPResult {
	return executeMutationLinearizationRequest(client, http.MethodDelete, endpoint, nil, "", idempotencyKey)
}

func executeMutationLinearizationRequest(
	client *http.Client,
	method string,
	endpoint string,
	body any,
	bearerToken string,
	idempotencyKey string,
) mutationLinearizationHTTPResult {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return mutationLinearizationHTTPResult{err: err}
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, endpoint, requestBody)
	if err != nil {
		return mutationLinearizationHTTPResult{err: err}
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		request.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	if idempotencyKey != "" {
		request.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return mutationLinearizationHTTPResult{err: err}
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 8192))
	return mutationLinearizationHTTPResult{status: response.StatusCode, body: responseBody, err: err}
}

func requireLinearizationStatus(
	t *testing.T,
	result mutationLinearizationHTTPResult,
	want int,
	action string,
) {
	t.Helper()
	if result.err != nil || result.status != want {
		t.Fatalf("%s status=%d want=%d body=%s err=%v", action, result.status, want, result.body, result.err)
	}
}
