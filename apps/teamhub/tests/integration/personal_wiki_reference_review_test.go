package integration_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPersonalWikiRoomDocumentRequiresExplicitTypedBinding(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("ensure Wiki status=%d body=%s", status, body)
	}
	roomID := env.createRoom(alice, acmeTenant, "Explicit Wiki Binding "+suffix,
		"wiki-explicit-room-"+suffix)
	status, _, body = requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/rooms/"+roomID+"/documents/uploads", "wiki-explicit-upload-"+suffix,
		map[string]string{
			"filename": "room-source.md", "representation_format": "markdown", "media_type": "text/markdown",
		}, "room-source.md", []byte("# Room source\n"))
	var uploaded unifiedWikiSourceUpload
	decode(t, body, &uploaded)
	if status != http.StatusCreated || uploaded.ID == "" {
		t.Fatalf("Room Document upload status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	if status != http.StatusOK || strings.Contains(string(body), uploaded.ID) {
		t.Fatalf("Room Binding implicitly projected into Wiki: status=%d body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPut,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/"+uploaded.ID, nil,
		"wiki-explicit-bind-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("explicit Wiki bind status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), uploaded.ID) {
		t.Fatalf("explicit Wiki Binding not listed: status=%d body=%s", status, body)
	}
	var roomBindings, wikiBindings int
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND status='active'),
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id=$1 AND binding_kind='wiki_source' AND status='active')`,
		uploaded.ID, roomID).Scan(&roomBindings, &wikiBindings); err != nil {
		t.Fatal(err)
	}
	if roomBindings != 1 || wikiBindings != 1 {
		t.Fatalf("typed bindings room=%d wiki=%d", roomBindings, wikiBindings)
	}
}

func TestPersonalWikiExplicitRebindReactivatesSameBindingIdentity(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	uploaded := uploadUnifiedWikiSource(t, env, alice, "rebind-source.txt", "plain_text",
		"text/plain", []byte("stable rebind source"))
	var bindingID string
	if err := env.pool.QueryRow(context.Background(), `SELECT id
		FROM document_context_bindings
		WHERE document_id=$1 AND binding_kind='wiki_source' AND status='active'`, uploaded.ID).Scan(&bindingID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(context.Background(), `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id=$1`, bindingID); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/"+uploaded.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("rebind status=%d body=%s", status, body)
	}
	var restoredID, restoredStatus string
	var accessEpoch int64
	if err := env.pool.QueryRow(context.Background(), `SELECT id,status,access_epoch
		FROM document_context_bindings
		WHERE document_id=$1 AND binding_kind='wiki_source'`, uploaded.ID).Scan(
		&restoredID, &restoredStatus, &accessEpoch,
	); err != nil {
		t.Fatal(err)
	}
	if restoredID != bindingID || restoredStatus != "active" || accessEpoch != 3 {
		t.Fatalf("rebound Binding id=%s want=%s status=%s epoch=%d", restoredID, bindingID,
			restoredStatus, accessEpoch)
	}
	// A repeated rebind finds the Binding active and changes nothing.
	status, _, repeated := env.request(alice, http.MethodPut,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/"+uploaded.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("repeated rebind status=%d body=%s", status, repeated)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings
		WHERE id=$1 AND status='active' AND access_epoch=3`, bindingID); got != 1 {
		t.Fatalf("repeated rebind changed the Binding: %d", got)
	}
}
