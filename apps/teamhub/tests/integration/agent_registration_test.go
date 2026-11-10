package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// recordingAgentManagement records the registration changes TeamHub wakes
// Agent Service for. TeamHub commits each change before it calls.
type recordingAgentManagement struct {
	mu        sync.Mutex
	notified  []string
	notifyErr error
}

type runtimeStatusAgentManagement struct {
	*recordingAgentManagement
}

func (r *runtimeStatusAgentManagement) BatchGetLocalAgentRuntimeStatuses(_ context.Context, _ []string) (map[string]roomagent.LocalAgentRuntimeStatus, error) {
	panic("availability must not call Agent Service")
}

func (r *recordingAgentManagement) NotifyAgentRegistrationChanged(_ context.Context, agentID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.notified = append(r.notified, agentID)
	return r.notifyErr
}

func (r *recordingAgentManagement) notifiedSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.notified...)
}

func newAgentRegistrationEnv(t *testing.T, agentManagement roomagent.AgentManagement) (*testEnv, *http.Client) {
	return newAgentRegistrationEnvWithLifecycleWorkers(t, agentManagement, false)
}

func newAgentRegistrationEnvWithLifecycleWorkers(t *testing.T, agentManagement roomagent.AgentManagement, enabled bool) (*testEnv, *http.Client) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	artifactRoot := integrationArtifactRoot(t)
	options := []appOption{withAgentManagement(agentManagement)}
	if enabled {
		options = append(options, starting(app.AgentCredentialSweep, app.JobQueue))
	}
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.RoomDocument.RuntimeURL = "http://document-runtime.test"
		c.ArtifactStorageRoot = artifactRoot
	}), options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	return env, env.login("alice", alicePassword)
}

func TestAgentIdentityQueryResolvesActiveAnotherMeIdentity(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	path := "/v0/agents/" + acmeOfficialAgentManagementID + "/identity"

	status, _, _ := agentWorkItemRequest(t, env, http.MethodGet, path, "", "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("missing Agent identity token status=%d want=401", status)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, path, "wrong-token", "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("wrong Agent identity token status=%d want=401", status)
	}

	status, _, body := agentWorkItemRequest(t, env, http.MethodGet, path, teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("get Agent identity status=%d body=%s", status, body)
	}
	var identity map[string]any
	decode(t, body, &identity)
	if len(identity) != 4 || identity["agent_id"] != acmeOfficialAgentManagementID || identity["agent_type"] != "general" {
		t.Fatalf("unexpected Agent identity: %v", identity)
	}
	actor, ok := identity["actor"].(map[string]any)
	if !ok || len(actor) != 3 || actor["id"] != "actor_acme_official" || actor["kind"] != "agent" || actor["display_name"] != "@official" {
		t.Fatalf("unexpected Agent identity Actor: %v", identity["actor"])
	}
	sponsor, ok := identity["sponsor"].(map[string]any)
	if !ok || len(sponsor) != 2 || sponsor["id"] != "actor_acme_alice" || sponsor["display_name"] != "alice" {
		t.Fatalf("unexpected Agent identity Sponsor: %v", identity["sponsor"])
	}
	if _, found := identity["represented_human"]; found {
		t.Fatalf("general Agent identity leaked represented Human data: %v", identity)
	}

	const anotherMeActorID = "actor_identity_another_me"
	const anotherMeManagementID = "management_identity_another_me"
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Alice''s AnotherMe','@identity-another-me')
	`, anotherMeActorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Private delegate','Delegate safely',
			'openai/gpt-5.4','actor_acme_alice','sponsor','anotherme','actor_acme_alice','computer_fixture','codex','grant_files')
	`, anotherMeActorID, acmeTenant, anotherMeManagementID); err != nil {
		t.Fatal(err)
	}
	status, _, body = agentWorkItemRequest(
		t, env, http.MethodGet, "/v0/agents/"+anotherMeManagementID+"/identity", teamHubInternalToken, "", nil,
	)
	if status != http.StatusOK {
		t.Fatalf("get AnotherMe identity without memory status=%d body=%s", status, body)
	}
	decode(t, body, &identity)
	if representedHuman, ok := identity["represented_human"].(map[string]any); !ok || representedHuman["memory"] != nil || representedHuman["profile"] != nil {
		t.Fatalf("identity without memory.md: %v", identity["represented_human"])
	}
	// The Profile never reaches the identity; only the latest memory.md does.
	for _, statement := range []string{
		`INSERT INTO personal_profile_revisions(id,tenant_id,owner_actor_id,prompt_version,markdown,profile)
		 VALUES('profile_identity_revision',$1,'actor_acme_alice','user-profile-v1','# Alice profile','{}')`,
		`INSERT INTO personal_profile_currents(tenant_id,owner_actor_id,revision_id)
		 VALUES($1,'actor_acme_alice','profile_identity_revision')`,
		`INSERT INTO user_memory_revisions(tenant_id,owner_actor_id,version,sections,markdown,source)
		 VALUES($1,'actor_acme_alice',1,'{}','# Memory old','profile'),($1,'actor_acme_alice',2,'{}','# Memory current','daily')`,
	} {
		if _, err := env.pool.Exec(t.Context(), statement, acmeTenant); err != nil {
			t.Fatal(err)
		}
	}

	status, _, body = agentWorkItemRequest(
		t, env, http.MethodGet, "/v0/agents/"+anotherMeManagementID+"/identity", teamHubInternalToken, "", nil,
	)
	if status != http.StatusOK {
		t.Fatalf("get AnotherMe identity status=%d body=%s", status, body)
	}
	decode(t, body, &identity)
	representedHuman, ok := identity["represented_human"].(map[string]any)
	if !ok || representedHuman["id"] != "actor_acme_alice" || representedHuman["display_name"] != "alice" || representedHuman["profile"] != nil {
		t.Fatalf("unexpected represented Human identity: %v", identity["represented_human"])
	}
	memory, ok := representedHuman["memory"].(map[string]any)
	if !ok || memory["version"] != float64(2) || memory["markdown"] != "# Memory current" {
		t.Fatalf("unexpected represented Human memory: %v", representedHuman["memory"])
	}

	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE actor_id=$1`, anotherMeActorID); err != nil {
		t.Fatal(err)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet, "/v0/agents/"+anotherMeManagementID+"/identity", teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("revoked AnotherMe identity status=%d want=404 body=%s", status, body)
	}

	for _, agentID := range []string{"unknown-agent", "actor_acme_official"} {
		status, _, body = agentWorkItemRequest(t, env, http.MethodGet, "/v0/agents/"+agentID+"/identity", teamHubInternalToken, "", nil)
		if status != http.StatusNotFound {
			t.Fatalf("hidden Agent identity %q status=%d want=404 body=%s", agentID, status, body)
		}
	}
}

func TestTenantHumanRegistersAgentWithIndependentExecutionIdentity(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	// AnotherMe Agents are provisioned for their Human; the public API creates only general Agents.
	status, _, anotherMeBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Public AnotherMe", "instructions": "Act as me.", "runtime": fixtureRuntime("gpt-5.6-luna"), "agent_type": "anotherme",
	}, "register-anotherme-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("public AnotherMe create status=%d body=%s", status, anotherMeBody)
	}
	payload := map[string]any{
		"name":         "Mirror Reviewer",
		"instructions": "Review the Room conversation.",
		"runtime": map[string]any{
			"model": "gpt-5.6-luna", "reasoning_effort": "xhigh",
			"placement": fixtureRuntime("gpt-5.6-luna")["placement"],
		},
		"agent_type": "general",
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "")
	if status != http.StatusCreated {
		t.Fatalf("register Agent status=%d body=%s", status, body)
	}
	var registered struct {
		AgentManagementID string `json:"agent_management_id"`
		AgentType         string `json:"agent_type"`
		Actor             struct {
			ID          string `json:"id"`
			TenantID    string `json:"tenant_id"`
			Kind        string `json:"kind"`
			DisplayName string `json:"display_name"`
		} `json:"actor"`
	}
	decode(t, body, &registered)
	if registered.Actor.ID == "" || registered.Actor.ID == registered.AgentManagementID || registered.Actor.TenantID != acmeTenant || registered.Actor.Kind != "agent" || registered.AgentManagementID == "" || registered.AgentType != "general" {
		t.Fatalf("unexpected registered Agent: %+v", registered)
	}
	assertAgentPerRoomMetaContexts(t, env.pool, registered.Actor.ID, 0)
	// Creation is a TeamHub row only; Agent Service reads it at the first Run.
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 0 {
		t.Fatalf("creation called Agent Service: %v", notified)
	}
	var storedStatus, storedComputer, storedModel, storedEffort string
	if err := env.pool.QueryRow(t.Context(), `SELECT status,computer_id,runtime_model,runtime_reasoning_effort FROM agent_registrations WHERE actor_id=$1`,
		registered.Actor.ID).Scan(&storedStatus, &storedComputer, &storedModel, &storedEffort); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "active" || storedComputer != fixtureComputerID || storedModel != "gpt-5.6-luna" || storedEffort != "xhigh" {
		t.Fatalf("stored registration status=%q computer=%q model=%q effort=%q", storedStatus, storedComputer, storedModel, storedEffort)
	}

	status, _, agentsBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Tenant Agents status=%d body=%s", status, agentsBody)
	}
	var agents struct {
		Items []struct {
			AgentManagementID string `json:"agent_management_id"`
			Instructions      string `json:"instructions"`
			Runtime           struct {
				Model           string `json:"model"`
				ReasoningEffort string `json:"reasoning_effort"`
			} `json:"runtime"`
			Actor struct {
				ID string `json:"id"`
			} `json:"actor"`
			CreatedBy struct {
				ID string `json:"id"`
			} `json:"created_by"`
		} `json:"items"`
		Page struct {
			HasMore bool `json:"has_more"`
		} `json:"page"`
	}
	decode(t, agentsBody, &agents)
	var listed bool
	for _, agent := range agents.Items {
		if agent.Actor.ID != registered.Actor.ID {
			continue
		}
		listed = agent.AgentManagementID == registered.AgentManagementID &&
			agent.Instructions == "Review the Room conversation." &&
			agent.Runtime.Model == "gpt-5.6-luna" &&
			agent.Runtime.ReasoningEffort == "xhigh" &&
			agent.CreatedBy.ID == "actor_acme_alice"
	}
	if !listed || agents.Page.HasMore {
		t.Fatalf("registered Agent missing from complete Tenant directory: %+v", agents)
	}

	// A Human creation is not deduplicated: repeating it creates another Agent.
	status, _, repeated := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "")
	var again struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, repeated, &again)
	if status != http.StatusCreated || again.Actor.ID == "" || again.Actor.ID == registered.Actor.ID {
		t.Fatalf("repeated registration status=%d body=%s", status, repeated)
	}

	restarted, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = env.databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	restartedServer := httptest.NewServer(restarted.Handler())
	registerIntegrationServerCleanup(t, restartedServer)
	restartedEnv := &testEnv{t: t, databaseURL: env.databaseURL, pool: env.pool, server: restartedServer}

	// Creation writes only TeamHub rows, so it does not need Agent Service.
	status, _, _ = restartedEnv.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "registry-unavailable-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("new registration without AgentManagement status=%d", status)
	}

	roomID := createPrivateRoom(t, env, alice, "Registered Agent "+suffix, "registered-agent-room-"+suffix)
	if status, memberBody := putRoomMember(t, env, alice, roomID, registered.Actor.ID, "member"); status != http.StatusOK {
		t.Fatalf("Sponsor admission status=%d body=%s", status, memberBody)
	}
	if status, memberBody := putRoomMember(t, env, alice, roomID, registered.Actor.ID, "member"); status != http.StatusOK {
		t.Fatalf("Sponsor admission replay status=%d body=%s", status, memberBody)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1 and actor_id=$2", roomID, registered.Actor.ID); got != 1 {
		t.Fatalf("Agent membership count after replay=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_events where room_id=$1 and event_type='room.member.added' and resource_id=$2", roomID, registered.Actor.ID); got != 1 {
		t.Fatalf("Agent membership Event count after replay=%d want=1", got)
	}
	issued, issueErr := agentcredential.New(env.pool).IssueManaged(t.Context(), registered.AgentManagementID, "registered Agent reply")
	if issueErr != nil {
		t.Fatal(issueErr)
	}
	status, replyBody := commitAgentMessage(t, env, issued.AccessToken, "room", roomID, agentTextMessage("room:"+roomID, "registered-agent-reply-"+suffix, "registered reply"))
	if status != http.StatusOK {
		t.Fatalf("registered Agent reply status=%d body=%s", status, replyBody)
	}
	var reply struct {
		MessageID string `json:"message_id"`
	}
	decode(t, replyBody, &reply)
	if got := countRows(t, env, "select count(*) from messages where id=$1 and author_actor_id=$2", reply.MessageID, registered.Actor.ID); got != 1 {
		t.Fatalf("registered Agent reply authors=%d want=1", got)
	}
	status, _, removeBody := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/"+registered.Actor.ID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("remove registered Agent status=%d body=%s", status, removeBody)
	}
	if status, memberBody := putRoomMember(t, env, alice, roomID, registered.Actor.ID, "member"); status != http.StatusOK {
		t.Fatalf("Sponsor re-admission status=%d body=%s", status, memberBody)
	}
}

func TestTenantHumanRegistersLocalAgentWithReasoningEffort(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	payload := map[string]any{
		"name": "Local Codex", "instructions": "Reply to development requests.",
		"runtime": map[string]any{
			"model": "gpt-6-astra", "reasoning_effort": "low",
			"placement": fixtureRuntime("gpt-6-astra")["placement"],
		},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "register-local-reasoning")
	if status != http.StatusCreated {
		t.Fatalf("register Local Agent status=%d body=%s", status, body)
	}
	var registered struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
		Runtime struct {
			ReasoningEffort string `json:"reasoning_effort"`
		} `json:"runtime"`
	}
	decode(t, body, &registered)
	if registered.Runtime.ReasoningEffort != "low" {
		t.Fatalf("response reasoning effort=%q", registered.Runtime.ReasoningEffort)
	}
	var storedEffort, registrationStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT runtime_reasoning_effort,status FROM agent_registrations WHERE actor_id=$1`, registered.Actor.ID).Scan(&storedEffort, &registrationStatus); err != nil {
		t.Fatal(err)
	}
	if storedEffort != "low" || registrationStatus != "active" {
		t.Fatalf("stored effort=%q status=%q", storedEffort, registrationStatus)
	}
	snapshotStatus, snapshotBody, err := pendingMaterializationCallback(t.Context(), http.MethodGet,
		env.server.URL+"/v0/agent-runtime/config?agent_id="+registered.AgentManagementID, nil)
	if err != nil || snapshotStatus != http.StatusOK {
		t.Fatalf("Local Runtime snapshot status=%d body=%s err=%v", snapshotStatus, snapshotBody, err)
	}
	var snapshot struct {
		Runtime struct {
			Type            string `json:"type"`
			ReasoningEffort string `json:"reasoning_effort"`
		} `json:"runtime"`
	}
	decode(t, snapshotBody, &snapshot)
	if snapshot.Runtime.Type != "local" || snapshot.Runtime.ReasoningEffort != "low" {
		t.Fatalf("Local Runtime snapshot=%+v", snapshot.Runtime)
	}
	payload["runtime"].(map[string]any)["reasoning_effort"] = "invalid-effort"
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "register-local-invalid-reasoning")
	if status != http.StatusBadRequest {
		t.Fatalf("invalid effort status=%d body=%s", status, body)
	}
}

func TestTenantHumanRegistersOwnerBoundLocalAgentPlacement(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &runtimeStatusAgentManagement{
		recordingAgentManagement: &recordingAgentManagement{},
	}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	if _, err := env.pool.Exec(t.Context(), `insert into local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,last_seen_at,runtime_diagnostics,workspace_grants)
 values('computer_owner_mac','Owner Mac','online','tenant_acme','actor_acme_alice',clock_timestamp(),'[{"type":"claude","status":"authentication_required","version":"2.1.227","error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"Claude Code authentication is required"}}]','[{"grant_id":"grant_linger","mode":"workspace-write"}]')
 on conflict(computer_id) do update set status=excluded.status,last_seen_at=excluded.last_seen_at,runtime_diagnostics=excluded.runtime_diagnostics,workspace_grants=excluded.workspace_grants`); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"name":         "Local Reviewer",
		"instructions": "Review this workspace locally.",
		"runtime": map[string]any{
			"model": "claude-sonnet", "reasoning_effort": "high",
			"placement": map[string]any{
				"type": "local", "computer_id": "computer_owner_mac",
				"runtime_type": "claude", "workspace_grant_id": "grant_linger",
			},
		},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "register-local-agent")
	if status != http.StatusCreated {
		t.Fatalf("register Local Agent status=%d body=%s", status, body)
	}
	var registered struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
		Runtime struct {
			Model     string `json:"model"`
			Placement struct {
				Type             string `json:"type"`
				ComputerID       string `json:"computer_id"`
				RuntimeType      string `json:"runtime_type"`
				WorkspaceGrantID string `json:"workspace_grant_id"`
			} `json:"placement"`
		} `json:"runtime"`
	}
	decode(t, body, &registered)
	if registered.Runtime.Model != "claude-sonnet" || registered.Runtime.Placement.Type != "local" ||
		registered.Runtime.Placement.ComputerID != "computer_owner_mac" || registered.Runtime.Placement.RuntimeType != "claude" ||
		registered.Runtime.Placement.WorkspaceGrantID != "grant_linger" {
		t.Fatalf("unexpected Local Agent response: %+v", registered)
	}
	if !containsJSONText(body, `"reasoning_effort":"high"`) {
		t.Fatalf("Local reasoning effort was not persisted: %s", body)
	}

	status, _, listBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Local Agent status=%d body=%s", status, listBody)
	}
	type listedAgent struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
		Runtime struct {
			Model     string `json:"model"`
			Placement struct {
				Type             string `json:"type"`
				ComputerID       string `json:"computer_id"`
				RuntimeType      string `json:"runtime_type"`
				WorkspaceGrantID string `json:"workspace_grant_id"`
			} `json:"placement"`
		} `json:"runtime"`
		LocalRuntimeStatus struct {
			Status    string `json:"status"`
			ErrorCode string `json:"error_code"`
			Version   string `json:"version"`
		} `json:"local_runtime_status"`
		Availability struct {
			Status          string `json:"status"`
			Label           string `json:"label"`
			CurrentActivity *struct {
				Summary string `json:"summary"`
			} `json:"current_activity"`
		} `json:"availability"`
	}
	var directory struct {
		Items []listedAgent `json:"items"`
	}
	decode(t, listBody, &directory)
	var listed *listedAgent
	for index := range directory.Items {
		if directory.Items[index].Actor.ID == registered.Actor.ID {
			listed = &directory.Items[index]
			break
		}
	}
	if listed == nil {
		t.Fatalf("registered Local Agent missing from directory: %s", listBody)
	}
	if listed.Runtime.Model != "claude-sonnet" || listed.Runtime.Placement.Type != "local" ||
		listed.Runtime.Placement.ComputerID != "computer_owner_mac" || listed.Runtime.Placement.RuntimeType != "claude" ||
		listed.Runtime.Placement.WorkspaceGrantID != "grant_linger" {
		t.Fatalf("unexpected listed Local Agent runtime: %+v", listed.Runtime)
	}
	if listed.LocalRuntimeStatus.Status != "" {
		t.Fatalf("Agent directory leaked volatile Local Runtime status: %+v", listed.LocalRuntimeStatus)
	}
	if containsJSONText(listBody, `"availability"`) || containsJSONText(listBody, `"local_runtime_status"`) {
		t.Fatalf("Agent directory leaked volatile availability fields: %s", listBody)
	}

	status, _, availabilityBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Local Agent availability status=%d body=%s", status, availabilityBody)
	}
	type availabilityProjection struct {
		Status          string `json:"status"`
		Label           string `json:"label"`
		CurrentActivity *struct {
			Summary string `json:"summary"`
		} `json:"current_activity"`
	}
	var availabilityPage struct {
		Items []struct {
			ActorID            string                 `json:"actor_id"`
			Availability       availabilityProjection `json:"availability"`
			LocalRuntimeStatus struct {
				Status    string `json:"status"`
				ErrorCode string `json:"error_code"`
				Version   string `json:"version"`
			} `json:"local_runtime_status"`
		} `json:"items"`
	}
	decode(t, availabilityBody, &availabilityPage)
	var snapshot *struct {
		ActorID            string                 `json:"actor_id"`
		Availability       availabilityProjection `json:"availability"`
		LocalRuntimeStatus struct {
			Status    string `json:"status"`
			ErrorCode string `json:"error_code"`
			Version   string `json:"version"`
		} `json:"local_runtime_status"`
	}
	for index := range availabilityPage.Items {
		if availabilityPage.Items[index].ActorID == registered.Actor.ID {
			snapshot = &availabilityPage.Items[index]
			break
		}
	}
	if snapshot == nil {
		t.Fatalf("registered Local Agent missing from availability: %s", availabilityBody)
	}
	if snapshot.LocalRuntimeStatus.Status != "authentication_required" ||
		snapshot.LocalRuntimeStatus.ErrorCode != "RUNTIME_AUTHENTICATION_REQUIRED" ||
		snapshot.LocalRuntimeStatus.Version != "2.1.227" {
		t.Fatalf("unexpected Local Agent Runtime status: %+v", snapshot.LocalRuntimeStatus)
	}
	if snapshot.Availability.Status != "offline" || snapshot.Availability.Label != "Offline" ||
		snapshot.Availability.CurrentActivity == nil ||
		snapshot.Availability.CurrentActivity.Summary != "Authentication required" {
		t.Fatalf("unexpected Local Agent availability: %+v", snapshot.Availability)
	}
	// The HTTP response must remain available with Agent Service unreachable,
	// retain diagnostics across a deployment, and recover from a new heartbeat.
	for _, tc := range []struct {
		connection, computer, availability string
		ageSeconds                         int
	}{
		{"reconnecting", "offline", "unknown", 300},
		{"connected", "online", "online", 0},
		{"offline", "offline", "offline", 700},
	} {
		// The projection compares heartbeat age with this process's clock.
		observedAt := time.Now().Add(-time.Duration(tc.ageSeconds) * time.Second)
		if _, err := env.pool.Exec(t.Context(), `update local_computers set status=$1,
   last_seen_at=$2, runtime_diagnostics='[{"type":"claude","status":"ready","version":"2.1.227"}]' where computer_id='computer_owner_mac'`, tc.computer, observedAt); err != nil {
			t.Fatal(err)
		}
		responseStatus, _, responseBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
		if responseStatus != http.StatusOK {
			t.Fatalf("status=%d body=%s", responseStatus, responseBody)
		}
		var page struct {
			Items []struct {
				ActorID      string `json:"actor_id"`
				Availability struct {
					Status string `json:"status"`
				} `json:"availability"`
				Runtime struct {
					Connection string `json:"connection_status"`
					ObservedAt string `json:"observed_at"`
					Version    string `json:"version"`
				} `json:"local_runtime_status"`
			} `json:"items"`
		}
		decode(t, responseBody, &page)
		found := false
		for _, item := range page.Items {
			if item.ActorID == registered.Actor.ID {
				found = true
				if item.Runtime.Connection != tc.connection || item.Runtime.ObservedAt == "" || item.Runtime.Version != "2.1.227" || item.Availability.Status != tc.availability {
					t.Fatalf("persisted observation=%+v", item)
				}
			}
		}
		if !found {
			t.Fatal("local Agent missing")
		}
	}
	// A Computer the Human does not own must not expose retained diagnostics.
	if _, err := env.pool.Exec(t.Context(), `update local_computers set owner_actor_id='actor_acme_official' where computer_id='computer_owner_mac'`); err != nil {
		t.Fatal(err)
	}
	responseStatus, _, responseBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
	if responseStatus != http.StatusOK || containsJSONText(responseBody, `"version":"2.1.227"`) {
		t.Fatalf("revoked Computer observation leaked: %s", responseBody)
	}

}

func TestTenantAgentRegistrationWaitsForAnOfflineComputer(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline',last_seen_at=now()-interval '1 hour' WHERE computer_id=$1`, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"name": "Offline Reviewer", "instructions": "Wait for the computer.", "runtime": fixtureRuntime("gpt-5"),
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "register-offline-computer")
	if status != http.StatusCreated {
		t.Fatalf("register on an offline Computer status=%d body=%s", status, body)
	}
	var registered struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &registered)
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id=$1 and status='active'", registered.Actor.ID); got != 1 {
		t.Fatalf("active registrations=%d want=1", got)
	}
	status, _, availabilityBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
	if status != http.StatusOK || !containsJSONText(availabilityBody, "Waiting for the computer to connect") {
		t.Fatalf("offline Computer availability status=%d body=%s", status, availabilityBody)
	}
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 0 {
		t.Fatalf("creation called Agent Service: %v", notified)
	}

	// A removed Computer or a grant the Computer does not offer cannot take a
	// new Agent.
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO local_computers(computer_id,display_name,status,removed_at,owner_tenant_id,owner_actor_id,workspace_grants)
		VALUES('computer_removed','Removed Mac','removed',clock_timestamp(),$1,'actor_acme_alice','[{"grant_id":"grant_files","mode":"workspace-write"}]')`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	for _, placement := range []struct{ computer, grant string }{
		{"computer_removed", "grant_files"}, {fixtureComputerID, "grant_unknown"},
	} {
		runtime := fixtureRuntime("gpt-5")
		runtime["placement"].(map[string]any)["computer_id"] = placement.computer
		runtime["placement"].(map[string]any)["workspace_grant_id"] = placement.grant
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
			"name": "Misplaced", "instructions": "Never created.", "runtime": runtime,
		}, "register-misplaced-"+placement.computer+"-"+placement.grant)
		if status != http.StatusConflict || !containsJSONText(body, "AGENT_PLACEMENT_TARGET_UNAVAILABLE") {
			t.Fatalf("placement %+v status=%d body=%s", placement, status, body)
		}
	}
	if got := countRows(t, env, "select count(*) from actors where tenant_id=$1 and display_name='Misplaced'", acmeTenant); got != 0 {
		t.Fatalf("refused placements left %d Actors", got)
	}
}

func TestTenantAgentDirectoryPaginatesActiveRegistrations(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	createdAt := time.Now().UTC().Add(-time.Hour)
	type expectedAgent struct {
		id, name, status string
	}
	expected := []expectedAgent{
		{id: "actor_directory_first_" + suffix, name: "First Directory Agent", status: "active"},
		{id: "actor_directory_active_" + suffix, name: "Active Directory Agent", status: "active"},
		{id: "actor_directory_revoked_" + suffix, name: "Revoked Directory Agent", status: "revoked"},
	}
	for index, agent := range expected {
		if _, err := env.pool.Exec(context.Background(), `
			insert into actors(id,tenant_id,kind,display_name,handle,created_at)
			values($1,$2,'agent',$3,$4,$5)`,
			agent.id, acmeTenant, agent.name, "@"+agent.id, createdAt.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(context.Background(), `
			insert into agent_registrations(
				actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
				created_by_actor_id,created_at,updated_at,
				computer_id,local_runtime_type,workspace_grant_id
			) values($1,$2,$3,$4,$5,'openai/gpt-5.4','actor_acme_alice',$6,$6,'computer_fixture','codex','grant_files')`,
			agent.id, acmeTenant, "management-"+agent.id, agent.status, "Instructions for "+agent.name,
			createdAt.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	skillID, skillName := "skill_directory_"+suffix, "directory-skill-"+suffix
	seedAgentRegistrationSkill(t, env, "actor_acme_alice", skillID, skillName)
	if _, err := env.pool.Exec(t.Context(), `
		insert into agent_skill_bindings(
			id,tenant_id,agent_actor_id,skill_id,manifest_version,enabled,config,
			binding_version,updated_by_actor_id
		) values($1,$2,$3,$4,'1.0.0',true,'{}',1,'actor_acme_alice')`,
		"agent_skill_binding_directory_"+suffix, acmeTenant, expected[1].id, skillID); err != nil {
		t.Fatal(err)
	}

	type directoryPage struct {
		Items []struct {
			AgentManagementID string `json:"agent_management_id"`
			Instructions      string `json:"instructions"`
			Runtime           struct {
				Model string `json:"model"`
			} `json:"runtime"`
			Actor struct {
				ID          string `json:"id"`
				TenantID    string `json:"tenant_id"`
				Kind        string `json:"kind"`
				DisplayName string `json:"display_name"`
			} `json:"actor"`
			CreatedBy struct {
				ID string `json:"id"`
			} `json:"created_by"`
			SkillBindings []agentSkillRegistrationResponse `json:"skill_bindings"`
		} `json:"items"`
		Page struct {
			HasMore    bool   `json:"has_more"`
			NextCursor string `json:"next_cursor"`
		} `json:"page"`
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=2", nil, "")
	if status != http.StatusOK {
		t.Fatalf("first Agent directory page status=%d body=%s", status, body)
	}
	var first directoryPage
	decode(t, body, &first)
	if len(first.Items) != 2 || !first.Page.HasMore || first.Page.NextCursor == "" {
		t.Fatalf("unexpected first Agent directory page: %+v", first)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=2&cursor="+first.Page.NextCursor, nil, "")
	if status != http.StatusOK {
		t.Fatalf("second Agent directory page status=%d body=%s", status, body)
	}
	var second directoryPage
	decode(t, body, &second)
	all := append(first.Items, second.Items...)
	seen := make(map[string]bool, len(all))
	expectedIDs := make(map[string]struct{}, len(expected))
	for _, agent := range expected {
		expectedIDs[agent.id] = struct{}{}
	}
	for _, item := range all {
		seen[item.Actor.ID] = true
		if _, createdByTest := expectedIDs[item.Actor.ID]; !createdByTest {
			continue
		}
		if item.CreatedBy.ID != "actor_acme_alice" || item.Actor.TenantID != acmeTenant || item.Actor.Kind != "agent" || item.Actor.DisplayName == "" || item.Instructions == "" || item.Runtime.Model != "openai/gpt-5.4" {
			t.Fatalf("Agent %q has incomplete directory fields: %+v", item.Actor.ID, item)
		}
		if item.AgentManagementID != "management-"+item.Actor.ID {
			t.Fatalf("Agent %q management ID=%q", item.Actor.ID, item.AgentManagementID)
		}
		if item.Actor.ID == expected[1].id {
			skills := agentSkillRegistrationsByID(item.SkillBindings)
			if len(item.SkillBindings) != 13 || !hasOfficeDefaultSkillRegistrations(skills) || !lacksLev8SearchSkillRegistration(skills) || skills["simplexai_collaborate"].Name != "collaborate" || skills["simplexai_collaborate"].ManifestVersion != "1.0.0" || skills[skillID].Name != skillName || skills[skillID].ManifestVersion != "1.0.0" || skills["simplexai_teamhub_files"].Name != "teamhub-files" || skills["simplexai_teamhub_files"].ManifestVersion != "1.0.3" {
				t.Fatalf("active Agent %q Skill bindings=%+v", item.Actor.ID, item.SkillBindings)
			}
		}
	}
	for _, agent := range expected {
		if seen[agent.id] != (agent.status == "active") {
			t.Fatalf("Agent %q listed=%v status=%q pages=%+v", agent.id, seen[agent.id], agent.status, all)
		}
	}
	if second.Page.HasMore {
		t.Fatalf("unexpected additional Agent directory page: %+v", second.Page)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?cursor=missing-agent", nil, "")
	if status != http.StatusBadRequest || !containsJSONText(body, "INVALID_PAGE") {
		t.Fatalf("invalid Agent directory cursor status=%d body=%s", status, body)
	}
	for _, limit := range []string{"0", "201"} {
		status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit="+limit, nil, "")
		if status != http.StatusBadRequest || !containsJSONText(body, "INVALID_PAGE") {
			t.Fatalf("invalid Agent directory limit %q status=%d body=%s", limit, status, body)
		}
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=invalid", nil, "")
	if status != http.StatusBadRequest || !containsJSONText(body, "INVALID_REQUEST") {
		t.Fatalf("malformed Agent directory limit status=%d body=%s", status, body)
	}

}

func TestTenantHumanRegistersAgentWithInitialSkillBindings(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	skillID, skillName := "skill_registration_"+suffix, "registration-skill-"+suffix
	seedAgentRegistrationSkill(t, env, "actor_acme_alice", skillID, skillName)

	payload := map[string]any{
		"name": "Bound Agent " + suffix, "instructions": "Use registered capabilities.",
		"runtime": fixtureRuntime("gpt-5"),
		"skill_bindings": []map[string]any{{
			"name": skillName, "skill_id": skillID, "manifest_version": "1.0.0",
		}},
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", payload, "")
	if status != http.StatusCreated {
		t.Fatalf("register bound Agent status=%d body=%s", status, body)
	}
	var registered struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
		SkillBindings []agentSkillRegistrationResponse `json:"skill_bindings"`
	}
	decode(t, body, &registered)
	if registered.Actor.ID == "" || len(registered.SkillBindings) != 13 || containsJSONText(body, "mcp_bindings") {
		t.Fatalf("unexpected registered bindings: %+v", registered)
	}
	registeredSkills := agentSkillRegistrationsByID(registered.SkillBindings)
	if !hasOfficeDefaultSkillRegistrations(registeredSkills) || !lacksLev8SearchSkillRegistration(registeredSkills) || registeredSkills["simplexai_collaborate"].Name != "collaborate" || registeredSkills["simplexai_collaborate"].ManifestVersion != "1.0.0" || registeredSkills[skillID].Name != skillName || registeredSkills[skillID].ManifestVersion != "1.0.0" || registeredSkills["simplexai_teamhub_files"].Name != "teamhub-files" || registeredSkills["simplexai_teamhub_files"].ManifestVersion != "1.0.3" {
		t.Fatalf("unexpected registered Skill bindings: %+v", registered.SkillBindings)
	}

	var persistedSkillVersion, updatedByActorID string
	var skillEnabled bool
	var skillConfig []byte
	var bindingVersion int64
	if err := env.pool.QueryRow(t.Context(), `
		select manifest_version,enabled,config,binding_version,updated_by_actor_id
		from agent_skill_bindings
		where agent_actor_id=$1 and skill_id=$2`,
		registered.Actor.ID, skillID,
	).Scan(&persistedSkillVersion, &skillEnabled, &skillConfig, &bindingVersion, &updatedByActorID); err != nil {
		t.Fatal(err)
	}
	if persistedSkillVersion != "1.0.0" || !skillEnabled || string(skillConfig) != "{}" ||
		bindingVersion != 1 || updatedByActorID != "actor_acme_alice" {
		t.Fatalf("unexpected initial Agent Skill binding version=%q enabled=%v config=%s binding_version=%d updated_by=%q",
			persistedSkillVersion, skillEnabled, skillConfig, bindingVersion, updatedByActorID)
	}
	status, _, bindingBody := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/agents/"+registered.Actor.ID+"/skill-bindings", nil, "")
	if status != http.StatusOK || !containsJSONText(bindingBody, skillID) ||
		!containsJSONText(bindingBody, `"binding_version":1`) {
		t.Fatalf("list initial Agent Skill bindings status=%d body=%s", status, bindingBody)
	}
	if got := countRows(t, env, "select count(*) from agent_local_runs run join agent_execution_contexts context on context.context_key=run.context_key where context.agent_actor_id=$1", registered.Actor.ID); got != 0 {
		t.Fatalf("initial resource delivery created %d Local Runs", got)
	}

	invalidName := "Retired MCP Agent " + suffix
	status, _, invalidBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": invalidName, "instructions": "Request a retired MCP selection.", "runtime": fixtureRuntime("gpt-5"),
		"mcp_bindings": []map[string]any{{
			"name": "retired", "mcp_id": "linger_retired", "manifest_version": "1.0.0", "allowed_tools": []string{"search"},
		}},
	}, "register-retired-mcp-"+suffix)
	if status != http.StatusBadRequest || !containsJSONText(invalidBody, "INVALID_REQUEST") {
		t.Fatalf("retired MCP selection status=%d body=%s", status, invalidBody)
	}
	var invalidActors int
	if err := env.pool.QueryRow(t.Context(), "select count(*) from actors where display_name=$1", invalidName).Scan(&invalidActors); err != nil {
		t.Fatal(err)
	}
	if invalidActors != 0 {
		t.Fatalf("invalid binding was not rolled back actors=%d", invalidActors)
	}
}

func TestTenantHumanCannotRegisterAgentWithDuplicateSkillPackageNames(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	packageName := "duplicate-registration-package"
	bindings := make([]map[string]any, 0, 2)
	for index := 1; index <= 2; index++ {
		skillID := "skill_duplicate_package_" + strconv.Itoa(index) + "_" + suffix
		description := "Duplicate package fixture"
		manifest := map[string]any{
			"skill_id": skillID, "manifest_version": "1.0.0",
			"description": description, "config_schema": map[string]any{},
		}
		archive := makeIntegrationSkillZIP(t, packageName, description, false, map[string]string{
			"references/index.txt": strconv.Itoa(index),
		})
		env.seedSkillPackage(acmeTenant, "actor_acme_alice", manifest, archive)
		bindings = append(bindings, map[string]any{
			"name": packageName, "skill_id": skillID, "manifest_version": "1.0.0",
		})
	}

	name := "Duplicate Package Agent " + suffix
	instructions := "Reject duplicate Skill package names " + suffix
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": name, "instructions": instructions, "runtime": fixtureRuntime("gpt-5"),
		"skill_bindings": bindings,
	}, "register-duplicate-package-"+suffix)
	if status != http.StatusBadRequest || !containsJSONText(body, "INVALID_SKILL_REGISTRATION") {
		t.Fatalf("duplicate Skill package registration status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "select count(*) from actors where tenant_id=$1 and display_name=$2", acmeTenant, name); got != 0 {
		t.Fatalf("duplicate Skill package registration left %d actors", got)
	}
	if got := countRows(t, env, "select count(*) from agent_registrations where tenant_id=$1 and instructions=$2", acmeTenant, instructions); got != 0 {
		t.Fatalf("duplicate Skill package registration left %d reservations", got)
	}
}

func seedAgentRegistrationSkill(t *testing.T, env *testEnv, actorID, skillID, skillName string) {
	t.Helper()
	description := "Registration binding fixture"
	manifest := map[string]any{
		"skill_id": skillID, "manifest_version": "1.0.0",
		"description": description, "config_schema": map[string]any{},
	}
	archive := makeIntegrationSkillZIP(t, skillName, description, false, map[string]string{
		"references/fixture.txt": skillID,
	})
	env.seedSkillPackage(acmeTenant, actorID, manifest, archive)
}

func TestRoomRejectsUnregisteredAgentActor(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	actorID := "actor_unregistered_" + suffix
	if _, err := env.pool.Exec(context.Background(), `
		insert into actors(id,tenant_id,kind,display_name,handle)
		values($1,$2,'agent','Unregistered Agent',$3)`, actorID, acmeTenant, "@unregistered_"+suffix); err != nil {
		t.Fatal(err)
	}
	roomID := createPrivateRoom(t, env, alice, "Reject unregistered "+suffix, "reject-unregistered-room-"+suffix)
	status, body := putRoomMember(t, env, alice, roomID, actorID, "member")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_NOT_REGISTERED") {
		t.Fatalf("invite unregistered Agent status=%d body=%s", status, body)
	}
}

func assertAgentPerRoomMetaContexts(t *testing.T, pool *pgxpool.Pool, actorID string, want int) {
	t.Helper()
	var agentManagementID string
	if err := pool.QueryRow(t.Context(), `
		SELECT agent_management_id FROM agent_registrations WHERE actor_id=$1`, actorID).Scan(&agentManagementID); err != nil {
		t.Fatalf("read Agent registration %q: %v", actorID, err)
	}
	var perRoom, global int
	if err := pool.QueryRow(t.Context(), `
		SELECT count(*) FILTER (
		           WHERE room_id IS NOT NULL AND membership_epoch_id IS NOT NULL
		       ),
		       count(*) FILTER (WHERE room_id IS NULL)
		FROM agent_execution_contexts
		WHERE agent_actor_id=$1 AND agent_management_id=$2
		  AND context_kind='meta' AND task_id IS NULL`, actorID, agentManagementID).Scan(&perRoom, &global); err != nil {
		t.Fatalf("count Agent per-Room meta Contexts %q: %v", actorID, err)
	}
	if perRoom != want || global != 0 {
		t.Fatalf("Agent %q meta Contexts per_room=%d global=%d, want %d/0", actorID, perRoom, global, want)
	}
}

func assertAgentRoomMetaContextKind(
	t *testing.T,
	pool *pgxpool.Pool,
	agentActorID string,
	roomID string,
	want string,
) {
	t.Helper()
	var got string
	if err := pool.QueryRow(t.Context(), `
		SELECT room_kind
		FROM agent_execution_contexts
		WHERE agent_actor_id=$1 AND room_id=$2 AND context_kind='meta'
	`, agentActorID, roomID).Scan(&got); err != nil {
		t.Fatalf("read Agent %q Room %q Meta Context kind: %v", agentActorID, roomID, err)
	}
	if got != want {
		t.Fatalf("Agent %q Room %q Meta Context kind=%q want=%q", agentActorID, roomID, got, want)
	}
}
