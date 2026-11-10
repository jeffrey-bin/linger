package integration_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type workItemActor struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

type workItemAssignment struct {
	Actor      workItemActor `json:"actor"`
	AssignedBy workItemActor `json:"assigned_by"`
}

type workItemAccessGrant struct {
	Actor     workItemActor `json:"actor"`
	GrantedBy workItemActor `json:"granted_by"`
}

type workItemResponse struct {
	ID                   string                `json:"id"`
	TenantID             string                `json:"tenant_id"`
	Number               int64                 `json:"number"`
	Kind                 string                `json:"kind"`
	Title                string                `json:"title"`
	Description          string                `json:"description"`
	Priority             string                `json:"priority"`
	State                string                `json:"state"`
	Resolution           *string               `json:"resolution"`
	Version              int64                 `json:"version"`
	CreatedBy            workItemActor         `json:"created_by"`
	UpdatedBy            workItemActor         `json:"updated_by"`
	Assignees            []workItemAssignment  `json:"assignees"`
	ExplicitAccessGrants []workItemAccessGrant `json:"explicit_access_grants"`
	OriginRoomID         *string               `json:"origin_room_id"`
	WorkRoomID           *string               `json:"work_room_id"`
	ArchivedAt           *time.Time            `json:"archived_at"`
}

func newWorkItemEnv(t *testing.T) (*testEnv, *http.Client) {
	t.Helper()
	env := newWorkItemHTTPEnv(t, config.ForTest())
	return env, env.login("alice", alicePassword)
}

func newWorkItemHTTPEnv(t *testing.T, cfg config.Config) *testEnv {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg.DatabaseURL, cfg.SessionTTL, cfg.CookieName = databaseURL, time.Hour, "teamhub_session"
	cfg.ArtifactStorageRoot = integrationArtifactRoot(t)
	application, err := newIntegrationApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	return &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
}

func TestHumanWorkItemCore(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemEnv(t)
	seedPeerAgent(t, env, "actor_work_item_peer")
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	createPayload := map[string]any{
		"kind":               "issue",
		"title":              "Ship Work Items " + suffix,
		"description":        "Implement the durable Human workflow.",
		"assignee_actor_ids": []string{"actor_work_item_peer", "actor_acme_official"},
	}
	createKey := "work-item-create-" + suffix
	status, headers, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", createPayload, createKey)
	if status != http.StatusCreated {
		t.Fatalf("create Work Item status=%d body=%s", status, body)
	}
	if headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("first create marked as replay: %q", headers.Get("Idempotent-Replay"))
	}
	var created workItemResponse
	decode(t, body, &created)
	if created.ID == "" || created.TenantID != acmeTenant || created.Number != 1 || created.Kind != "issue" || created.Priority != "medium" || created.State != "open" || created.Version != 1 {
		t.Fatalf("unexpected created Work Item: %+v", created)
	}
	if created.CreatedBy.ID != "actor_acme_alice" || created.UpdatedBy.ID != "actor_acme_alice" || len(created.Assignees) != 2 {
		t.Fatalf("creator or initial Assignments were not server-derived: %+v", created)
	}

	status, replayHeaders, replayBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", createPayload, createKey)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("create replay status=%d replay=%q body=%s", status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	changedPayload := map[string]any{"kind": "issue", "title": "Changed replay"}
	status, _, _ = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", changedPayload, createKey)
	if status != http.StatusConflict {
		t.Fatalf("changed create replay status=%d want=409", status)
	}

	status, _, visible := env.request(alice, http.MethodGet, "/v0/work-items/"+created.ID, nil, "")
	if status != http.StatusOK || !bytes.Contains(visible, []byte(created.ID)) {
		t.Fatalf("Human cannot read the Work Item status=%d body=%s", status, visible)
	}
	status, _, listBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/work-items?kind=issue&state=open&priority=medium", nil, "")
	if status != http.StatusOK || !bytes.Contains(listBody, []byte(created.ID)) {
		t.Fatalf("same-Tenant Human list status=%d body=%s", status, listBody)
	}

	status, _, updatedBody := env.request(alice, http.MethodPatch, "/v0/work-items/"+created.ID, map[string]any{
		"expected_version": 1,
		"title":            "Ship Tenant Issues",
		"priority":         "urgent",
	}, "work-item-update-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("update Work Item status=%d body=%s", status, updatedBody)
	}
	var updated workItemResponse
	decode(t, updatedBody, &updated)
	if updated.Title != "Ship Tenant Issues" || updated.Priority != "urgent" || updated.Version != 2 {
		t.Fatalf("unexpected metadata update: %+v", updated)
	}
	status, _, _ = env.request(alice, http.MethodPatch, "/v0/work-items/"+created.ID, map[string]any{
		"expected_version": 1, "title": "Stale overwrite",
	}, "work-item-stale-"+suffix)
	if status != http.StatusConflict {
		t.Fatalf("stale metadata update status=%d want=409", status)
	}
	concurrentUpdates := make(chan asyncHTTPResult, 2)
	for index, title := range []string{"Concurrent title A", "Concurrent title B"} {
		if err := startAsyncJSONRequest(concurrentUpdates, title, alice, http.MethodPatch, env.server.URL+"/v0/work-items/"+created.ID, fmt.Sprintf("work-item-update-race-%s-%d", suffix, index), map[string]any{
			"expected_version": updated.Version, "title": title,
		}); err != nil {
			t.Fatal(err)
		}
	}
	statuses := []int{receiveWithin(t, concurrentUpdates, 30*time.Second).status, receiveWithin(t, concurrentUpdates, 30*time.Second).status}
	sort.Ints(statuses)
	if statuses[0] != http.StatusOK || statuses[1] != http.StatusConflict {
		t.Fatalf("concurrent metadata statuses=%v want=[200 409]", statuses)
	}
	status, _, updatedBody = env.request(alice, http.MethodGet, "/v0/work-items/"+created.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get after concurrent update status=%d body=%s", status, updatedBody)
	}
	decode(t, updatedBody, &updated)
	if updated.Version != 3 {
		t.Fatalf("concurrent update version=%d want=3", updated.Version)
	}

	updated = transitionWorkItem(t, env, alice, created.ID, updated.Version, "in_progress", "", "work-item-start-"+suffix)
	updated = transitionWorkItem(t, env, alice, created.ID, updated.Version, "resolved", "completed", "work-item-resolve-"+suffix)
	if updated.Resolution == nil || *updated.Resolution != "completed" {
		t.Fatalf("resolved Work Item lost resolution: %+v", updated)
	}
	updated = transitionWorkItem(t, env, alice, created.ID, updated.Version, "open", "", "work-item-reopen-"+suffix)
	if updated.Resolution != nil {
		t.Fatalf("reopen retained resolution: %+v", updated)
	}
	status, _, _ = env.request(alice, http.MethodPost, "/v0/work-items/"+created.ID+"/transitions", map[string]any{
		"expected_version": updated.Version, "state": "open",
	}, "work-item-invalid-transition-"+suffix)
	if status != http.StatusConflict {
		t.Fatalf("invalid transition status=%d want=409", status)
	}

	status, _, assignmentBody := env.request(alice, http.MethodPut, "/v0/work-items/"+created.ID+"/assignments/actor_acme_alice", nil, "work-item-assign-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("add Assignment status=%d body=%s", status, assignmentBody)
	}
	var assignment workItemAssignment
	decode(t, assignmentBody, &assignment)
	if assignment.Actor.ID != "actor_acme_alice" || assignment.AssignedBy.ID != "actor_acme_alice" {
		t.Fatalf("unexpected Assignment: %+v", assignment)
	}
	status, replayHeaders, replayBody = env.request(alice, http.MethodPut, "/v0/work-items/"+created.ID+"/assignments/actor_acme_alice", nil, "work-item-assign-"+suffix)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, assignmentBody) {
		t.Fatalf("Assignment replay status=%d replay=%q body=%s", status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}

	status, _, grantBody := env.request(alice, http.MethodPut, "/v0/work-items/"+created.ID+"/access-grants/actor_acme_official", nil, "work-item-grant-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("add Agent grant status=%d body=%s", status, grantBody)
	}
	var grant workItemAccessGrant
	decode(t, grantBody, &grant)
	if grant.Actor.ID != "actor_acme_official" || grant.Actor.Kind != "agent" || grant.GrantedBy.ID != "actor_acme_alice" {
		t.Fatalf("unexpected Agent access grant: %+v", grant)
	}
	status, _, _ = env.request(alice, http.MethodPut, "/v0/work-items/"+created.ID+"/access-grants/actor_acme_alice", nil, "work-item-human-grant-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("Human explicit grant status=%d want=400", status)
	}
	status, _, relationBody := env.request(alice, http.MethodGet, "/v0/work-items/"+created.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Work Item relationships status=%d body=%s", status, relationBody)
	}
	var related workItemResponse
	decode(t, relationBody, &related)
	if len(related.Assignees) != 3 || len(related.ExplicitAccessGrants) != 1 || related.Version != updated.Version {
		t.Fatalf("unexpected relationship projection: %+v", related)
	}
	status, _, deleteBody := env.request(alice, http.MethodDelete, "/v0/work-items/"+created.ID+"/assignments/actor_acme_alice", nil, "work-item-unassign-"+suffix)
	if status != http.StatusNoContent || len(deleteBody) != 0 {
		t.Fatalf("delete Assignment status=%d body=%s", status, deleteBody)
	}
	status, deleteHeaders, deleteBody := env.request(alice, http.MethodDelete, "/v0/work-items/"+created.ID+"/assignments/actor_acme_alice", nil, "work-item-unassign-"+suffix)
	if status != http.StatusNoContent || deleteHeaders.Get("Idempotent-Replay") != "true" || len(deleteBody) != 0 {
		t.Fatalf("delete Assignment replay status=%d replay=%q body=%s", status, deleteHeaders.Get("Idempotent-Replay"), deleteBody)
	}
	status, _, deleteBody = env.request(alice, http.MethodDelete, "/v0/work-items/"+created.ID+"/access-grants/actor_acme_official", nil, "work-item-revoke-"+suffix)
	if status != http.StatusNoContent || len(deleteBody) != 0 {
		t.Fatalf("delete access grant status=%d body=%s", status, deleteBody)
	}

	status, _, archivedBody := env.request(alice, http.MethodPost, "/v0/work-items/"+created.ID+"/archive", map[string]any{
		"expected_version": updated.Version,
	}, "work-item-archive-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("archive Work Item status=%d body=%s", status, archivedBody)
	}
	var archived workItemResponse
	decode(t, archivedBody, &archived)
	if archived.ArchivedAt == nil || archived.State != "open" || archived.Version != updated.Version+1 {
		t.Fatalf("archive changed lifecycle or version incorrectly: %+v", archived)
	}
	status, _, defaultList := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/work-items", nil, "")
	if status != http.StatusOK || bytes.Contains(defaultList, []byte(created.ID)) {
		t.Fatalf("default list includes archived Work Item status=%d body=%s", status, defaultList)
	}
	status, _, archivedList := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/work-items?archived=true", nil, "")
	if status != http.StatusOK || !bytes.Contains(archivedList, []byte(created.ID)) {
		t.Fatalf("archived list omitted Work Item status=%d body=%s", status, archivedList)
	}
	status, _, unarchivedBody := env.request(alice, http.MethodPost, "/v0/work-items/"+created.ID+"/unarchive", map[string]any{
		"expected_version": archived.Version,
	}, "work-item-unarchive-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unarchive Work Item status=%d body=%s", status, unarchivedBody)
	}

	var activityCount int
	if err := env.pool.QueryRow(context.Background(), "select count(*) from work_item_activities where work_item_id=$1", created.ID).Scan(&activityCount); err != nil {
		t.Fatal(err)
	}
	if activityCount != 12 {
		t.Fatalf("activity_count=%d want=12", activityCount)
	}
}

func TestConcurrentWorkItemNumbersAreTenantUnique(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemEnv(t)
	const total = 12
	results := make(chan asyncHTTPResult, total)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	for index := range total {
		payload := map[string]any{"kind": "issue", "title": fmt.Sprintf("Concurrent issue %02d", index)}
		if err := startAsyncJSONRequest(results, strconv.Itoa(index), alice, http.MethodPost, env.server.URL+"/v0/tenants/"+acmeTenant+"/work-items", fmt.Sprintf("work-item-concurrent-%s-%02d", suffix, index), payload); err != nil {
			t.Fatal(err)
		}
	}
	numbers := make([]int, 0, total)
	for range total {
		result := receiveWithin(t, results, 30*time.Second)
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.status != http.StatusCreated {
			t.Fatalf("concurrent create %s status=%d body=%s", result.name, result.status, result.body)
		}
		var created workItemResponse
		decode(t, result.body, &created)
		numbers = append(numbers, int(created.Number))
	}
	sort.Ints(numbers)
	for index, number := range numbers {
		if number != index+1 {
			t.Fatalf("tenant numbers=%v", numbers)
		}
	}
	seen := map[string]struct{}{}
	cursor := ""
	for pageIndex := 0; pageIndex < 3; pageIndex++ {
		path := "/v0/tenants/" + acmeTenant + "/work-items?limit=5"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		status, _, body := env.request(alice, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("list Work Item page %d status=%d body=%s", pageIndex, status, body)
		}
		var page struct {
			Items []workItemResponse `json:"items"`
			Page  struct {
				HasMore    bool    `json:"has_more"`
				NextCursor *string `json:"next_cursor"`
			} `json:"page"`
		}
		decode(t, body, &page)
		for _, item := range page.Items {
			if _, exists := seen[item.ID]; exists {
				t.Fatalf("Work Item %s appeared on multiple pages", item.ID)
			}
			seen[item.ID] = struct{}{}
		}
		if pageIndex < 2 {
			if !page.Page.HasMore || page.Page.NextCursor == nil || *page.Page.NextCursor == page.Items[len(page.Items)-1].ID {
				t.Fatalf("page %d returned a missing or transparent cursor: %+v", pageIndex, page.Page)
			}
			cursor = *page.Page.NextCursor
		} else if page.Page.HasMore || page.Page.NextCursor != nil {
			t.Fatalf("last page unexpectedly has another cursor: %+v", page.Page)
		}
	}
	if len(seen) != total {
		t.Fatalf("paginated Work Items=%d want=%d", len(seen), total)
	}
}

func transitionWorkItem(t *testing.T, env *testEnv, client *http.Client, id string, expectedVersion int64, state, resolution, key string) workItemResponse {
	t.Helper()
	payload := map[string]any{"expected_version": expectedVersion, "state": state}
	if resolution != "" {
		payload["resolution"] = resolution
	}
	status, _, body := env.request(client, http.MethodPost, "/v0/work-items/"+id+"/transitions", payload, key)
	if status != http.StatusOK {
		t.Fatalf("transition Work Item to %s status=%d body=%s", state, status, body)
	}
	var item workItemResponse
	decode(t, body, &item)
	if item.State != state || item.Version != expectedVersion+1 {
		t.Fatalf("unexpected transition result: %+v", item)
	}
	return item
}
