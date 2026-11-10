package integration_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestUnifiedDocumentRestrictedLinkAndSourceExplanationAreReadOnly(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Restricted source "+suffix, "restricted-source-room-"+suffix)
	created := createCollaboratorTestDocument(t, env, alice, "restricted-document-"+suffix)
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/documents/"+created, nil, "restricted-binding-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("bind Document status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+created+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official", "role": "viewer",
		}, "restricted-direct-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Direct source status=%d body=%s", status, body)
	}

	type shareSource struct {
		CallerAccessState string `json:"caller_access_state"`
		SourceGroup       string `json:"source_group"`
		Source            struct {
			SourceKind string `json:"source_kind"`
		} `json:"source"`
	}
	type shareView struct {
		GeneralAccess struct {
			CanonicalURL string `json:"canonical_url"`
			Scope        string `json:"scope"`
		} `json:"general_access"`
		Sources []shareSource `json:"sources"`
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/documents/"+created+"/collaborators", nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Share view status=%d body=%s", status, body)
	}
	var share shareView
	decode(t, body, &share)
	if share.GeneralAccess.Scope != "restricted" ||
		share.GeneralAccess.CanonicalURL != "/t/"+acmeTenant+"/documents/"+created {
		t.Fatalf("General access=%+v", share.GeneralAccess)
	}
	// The Owner reads through its own source; the Agent's share and the Room
	// explain other principals' access.
	states := map[string]string{}
	groups := map[string]string{}
	for _, item := range share.Sources {
		states[item.Source.SourceKind] = item.CallerAccessState
		groups[item.Source.SourceKind] = item.SourceGroup
	}
	if states["context"] != "not_caller" || states["direct"] != "not_caller" ||
		groups["context"] != "context" || groups["direct"] != "direct" {
		t.Fatalf("source states=%v groups=%v", states, groups)
	}

	var collaborators, permissionCount int
	countAuthorizationRows := func() {
		t.Helper()
		if err := env.pool.QueryRow(t.Context(), `SELECT
			(SELECT count(*) FROM document_direct_collaborators WHERE document_id=$1),
			(SELECT permission_count FROM document_permission_counts WHERE document_id=$1)`, created).
			Scan(&collaborators, &permissionCount); err != nil {
			t.Fatal(err)
		}
	}
	countAuthorizationRows()
	beforeCollaborators, beforePermissionCount := collaborators, permissionCount
	for _, path := range []string{
		"/v0/documents/" + created,
		"/v0/documents/" + created + "/collaborators",
		"/v0/tenants/" + acmeTenant + "/me/shared-document-tree",
	} {
		status, _, body = env.request(alice, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("read canonical URL projection %s status=%d body=%s", path, status, body)
		}
	}
	countAuthorizationRows()
	if collaborators != beforeCollaborators || permissionCount != beforePermissionCount {
		t.Fatalf("read changed authorization rows collaborators=%d/%d permission count=%d/%d",
			beforeCollaborators, collaborators, beforePermissionCount, permissionCount)
	}
}
