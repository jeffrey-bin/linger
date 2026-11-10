package integration_test

import (
	"errors"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// agentDocumentAccess is an Agent's effective Document authority. The single
// Human reads every active Document, so sharing tests read through an Agent.
type agentDocumentAccess struct {
	Role                 string
	Read, Write, Comment bool
}

func agentDocumentAccessFor(t *testing.T, env *testEnv, agentManagementID, documentID string) agentDocumentAccess {
	t.Helper()
	var access agentDocumentAccess
	err := env.pool.QueryRow(t.Context(), `SELECT content_role,can_read,can_write,can_comment
		FROM resolve_agent_document_access_v2($1,$2)`, agentManagementID, documentID).
		Scan(&access.Role, &access.Read, &access.Write, &access.Comment)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentDocumentAccess{}
	}
	if err != nil {
		t.Fatalf("resolve Agent Document access: %v", err)
	}
	return access
}

func createCollaboratorTestDocument(t *testing.T, env *testEnv, client *http.Client, key string) string {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost,
		"/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, key)
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	return created.ID
}

func TestUnifiedDocumentOwnerSharesDirectlyWithAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	documentID := createCollaboratorTestDocument(t, env, alice, "direct-document-"+suffix)
	// The Agent already has its Human's access, so the share changes none of it.
	if got := agentDocumentAccessFor(t, env, acmeOfficialAgentManagementID, documentID); got !=
		(agentDocumentAccess{Role: "owner", Read: true, Write: true, Comment: true}) {
		t.Fatalf("unshared Agent access=%+v", got)
	}

	status, _, body := env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official",
			"role":            "viewer",
		}, "")
	if status != http.StatusCreated {
		t.Fatalf("create collaborator status=%d body=%s", status, body)
	}
	var source struct {
		SchemaVersion  int     `json:"schema_version"`
		SourceID       string  `json:"source_id"`
		SourceKind     string  `json:"source_kind"`
		Status         string  `json:"status"`
		Role           string  `json:"role"`
		SourceVersion  int     `json:"source_version"`
		GrantorActorID *string `json:"grantor_actor_id"`
		Target         struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		} `json:"target"`
		Provenance struct {
			SchemaVersion int    `json:"schema_version"`
			Kind          string `json:"kind"`
		} `json:"provenance"`
	}
	decode(t, body, &source)
	if source.SchemaVersion != 2 || source.SourceID == "" || source.SourceKind != "direct" ||
		source.Status != "active" || source.Role != "viewer" || source.SourceVersion != 1 ||
		source.GrantorActorID == nil || *source.GrantorActorID != "actor_acme_alice" ||
		source.Target.Kind != "agent" || source.Target.ID != "actor_acme_official" ||
		source.Provenance.SchemaVersion != 2 || source.Provenance.Kind != "direct_grant" {
		t.Fatalf("created Direct source=%+v", source)
	}
	// A share changes nobody's access, so open sessions keep their tokens.
	var permissionCount int64
	if err := env.pool.QueryRow(t.Context(), `SELECT permission_count FROM document_permission_counts WHERE document_id=$1`,
		documentID).Scan(&permissionCount); err != nil {
		t.Fatal(err)
	}
	if permissionCount != 0 {
		t.Fatalf("a share bumped the permission count to %d", permissionCount)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.collaborator.created'`, documentID); got != 1 {
		t.Fatalf("Direct collaborator Document events=%d want=1", got)
	}
	// The Agent already collaborates, so a repeated share conflicts.
	for _, role := range []string{"viewer", "editor"} {
		status, _, body = env.request(alice, http.MethodPost,
			"/v0/documents/"+documentID+"/collaborators", map[string]any{
				"target_actor_id": "actor_acme_official", "role": role,
			}, "")
		if status != http.StatusConflict {
			t.Fatalf("repeated %s share status=%d body=%s", role, status, body)
		}
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official", "role": "owner",
		}, "direct-owner-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("ordinary Share granted Owner status=%d body=%s", status, body)
	}
	// Another Human already reads every active Document, so it is no share target.
	seedPeerHumanActor(t, env.pool)
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_bob", "role": "viewer",
		}, "direct-human-"+suffix)
	if status != http.StatusNotFound {
		t.Fatalf("Human Direct share status=%d body=%s", status, body)
	}

	if got := agentDocumentAccessFor(t, env, acmeOfficialAgentManagementID, documentID); got !=
		(agentDocumentAccess{Role: "owner", Read: true, Write: true, Comment: true}) {
		t.Fatalf("shared Agent access=%+v", got)
	}
}

func TestUnifiedDocumentDirectCollaboratorCASPreservesContextAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Direct union "+suffix, "direct-union-room-"+suffix)
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/members/actor_acme_official", map[string]any{"role": "member"}, "")
	if status != http.StatusOK {
		t.Fatalf("add Agent to Room status=%d body=%s", status, body)
	}
	documentID := createCollaboratorTestDocument(t, env, alice, "direct-union-document-"+suffix)
	status, _, body = env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/documents/"+documentID, nil, "direct-union-binding-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("bind Document status=%d body=%s", status, body)
	}
	// This scenario compares Editor context access with a weaker Direct source.
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_context_bindings SET role='editor',access_epoch=access_epoch+1 WHERE document_id=$1 AND room_id=$2`, documentID, roomID); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official", "role": "manager",
		}, "direct-manager-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Manager status=%d body=%s", status, body)
	}
	var source struct {
		SourceID      string `json:"source_id"`
		SourceVersion int64  `json:"source_version"`
	}
	decode(t, body, &source)

	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/documents/"+documentID+"/collaborators/"+source.SourceID, map[string]any{
			"expected_version": source.SourceVersion, "role": "viewer",
		}, "direct-downgrade-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("downgrade Direct source status=%d body=%s", status, body)
	}
	var downgraded struct {
		Role          string `json:"role"`
		SourceVersion int64  `json:"source_version"`
	}
	decode(t, body, &downgraded)
	if downgraded.Role != "viewer" || downgraded.SourceVersion != 2 {
		t.Fatalf("downgraded Direct source=%+v", downgraded)
	}
	status, _, staleBody := env.request(alice, http.MethodPatch,
		"/v0/documents/"+documentID+"/collaborators/"+source.SourceID, map[string]any{
			"expected_version": int64(1), "role": "viewer",
		}, "direct-stale-"+suffix)
	if status != http.StatusConflict {
		t.Fatalf("stale Direct source CAS status=%d body=%s", status, staleBody)
	}
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/documents/"+documentID+"/collaborators/"+source.SourceID, map[string]any{
			"expected_version": int64(2), "role": "editor",
		}, "direct-owner-update-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("Owner mutation status=%d body=%s", status, body)
	}
	var ownerUpdated struct {
		Role          string `json:"role"`
		SourceVersion int64  `json:"source_version"`
	}
	decode(t, body, &ownerUpdated)
	if ownerUpdated.Role != "editor" || ownerUpdated.SourceVersion != 3 {
		t.Fatalf("Owner-updated Direct source=%+v", ownerUpdated)
	}

	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators/"+source.SourceID+"/revoke", map[string]any{
			"expected_version": int64(3),
		}, "direct-revoke-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("revoke Direct source status=%d body=%s", status, body)
	}
	var revoked struct {
		Status        string `json:"status"`
		SourceVersion int64  `json:"source_version"`
	}
	decode(t, body, &revoked)
	if revoked.Status != "revoked" || revoked.SourceVersion != 4 {
		t.Fatalf("revoked Direct source=%+v", revoked)
	}
	var auditEvents []string
	if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(array_agg(event_type ORDER BY sequence),ARRAY[]::text[])
		FROM document_events WHERE document_id=$1 AND event_type LIKE 'document.collaborator.%'`,
		documentID).Scan(&auditEvents); err != nil {
		t.Fatal(err)
	}
	if len(auditEvents) != 4 || auditEvents[0] != "document.collaborator.created" ||
		auditEvents[1] != "document.collaborator.updated" || auditEvents[2] != "document.collaborator.updated" ||
		auditEvents[3] != "document.collaborator.revoked" {
		t.Fatalf("collaborator audit events=%v", auditEvents)
	}
	if got := agentDocumentAccessFor(t, env, acmeOfficialAgentManagementID, documentID); got !=
		(agentDocumentAccess{Role: "owner", Read: true, Write: true, Comment: true}) {
		t.Fatalf("Agent access after its share was revoked=%+v", got)
	}
}

// A share role records what the Human asked for; the Agent keeps its Human's
// access whatever the role.
func TestUnifiedDocumentDirectAgentRolesLeaveAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	documentID := createCollaboratorTestDocument(t, env, alice, "direct-roles-document-"+suffix)
	status, _, body := env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official", "role": "viewer",
		}, "direct-roles-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Direct role source status=%d body=%s", status, body)
	}
	var source struct {
		SourceID      string `json:"source_id"`
		SourceVersion int64  `json:"source_version"`
	}
	decode(t, body, &source)

	want := agentDocumentAccess{Role: "owner", Read: true, Write: true, Comment: true}
	for index, role := range []string{"viewer", "editor", "manager"} {
		if index > 0 {
			status, _, body = env.request(alice, http.MethodPatch,
				"/v0/documents/"+documentID+"/collaborators/"+source.SourceID, map[string]any{
					"expected_version": source.SourceVersion, "role": role,
				}, "direct-role-"+role+"-"+suffix)
			if status != http.StatusOK {
				t.Fatalf("update Direct %s status=%d body=%s", role, status, body)
			}
			source.SourceVersion++
		}
		if got := agentDocumentAccessFor(t, env, acmeOfficialAgentManagementID, documentID); got != want {
			t.Fatalf("Direct %s Agent access=%+v", role, got)
		}
	}
}

func TestUnifiedDocumentShareViewExplainsSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Share provenance "+suffix, "share-provenance-room-"+suffix)
	documentID := createCollaboratorTestDocument(t, env, alice, "share-provenance-document-"+suffix)
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/documents/"+documentID, nil, "share-provenance-binding-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("bind Document status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/collaborators", map[string]any{
			"target_actor_id": "actor_acme_official", "role": "viewer",
		}, "share-provenance-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Direct source status=%d body=%s", status, body)
	}
	var agentName string
	if err := env.pool.QueryRow(t.Context(), `SELECT display_name FROM actors WHERE id='actor_acme_official'`).
		Scan(&agentName); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodGet,
		"/v0/documents/"+documentID+"/collaborators", nil, "")
	if status != http.StatusOK {
		t.Fatalf("Owner Share view status=%d body=%s", status, body)
	}
	var view struct {
		SchemaVersion          int    `json:"schema_version"`
		CallerContentRole      string `json:"caller_content_role"`
		CanManageCollaborators bool   `json:"can_manage_collaborators"`
		ManagementCapabilities struct {
			UpdateLink bool `json:"can_update_link_policy"`
		} `json:"management_capabilities"`
		Sources []struct {
			Label       string `json:"label"`
			SourceGroup string `json:"source_group"`
			TargetActor *struct {
				ID          string `json:"id"`
				Kind        string `json:"kind"`
				DisplayName string `json:"display_name"`
			} `json:"target_actor"`
			Source struct {
				SourceKind string `json:"source_kind"`
				Role       string `json:"role"`
			} `json:"source"`
		} `json:"sources"`
	}
	decode(t, body, &view)
	if view.SchemaVersion != 2 || view.CallerContentRole != "owner" || !view.CanManageCollaborators ||
		!view.ManagementCapabilities.UpdateLink ||
		len(view.Sources) != 2 {
		t.Fatalf("Owner Share view=%+v", view)
	}
	direct, context := view.Sources[0], view.Sources[1]
	if direct.Source.SourceKind != "direct" || direct.SourceGroup != "direct" || direct.TargetActor == nil ||
		direct.TargetActor.ID != "actor_acme_official" || direct.TargetActor.Kind != "agent" ||
		direct.TargetActor.DisplayName != agentName || direct.Label != agentName ||
		context.Source.SourceKind != "context" || context.SourceGroup != "context" ||
		context.Label != "Share provenance "+suffix {
		t.Fatalf("Owner Share sources=%+v", view.Sources)
	}
}
