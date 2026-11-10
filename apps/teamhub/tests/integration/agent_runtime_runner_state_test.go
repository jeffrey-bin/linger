package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

func TestAgentRuntimeLocalComputerEnrollmentExchangeIsReplaySafe(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	owner := runtimeComputerOwner()
	expiresAt := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	firstHash := sha256.Sum256([]byte("first-authorization-code"))
	first := agentruntimestate.CreateLocalComputerEnrollmentInput{
		EnrollmentID: "enrollment-runtime-first", ComputerID: "computer_runtime_enrollment",
		DisplayName: "Runtime enrollment", Owner: owner, RedirectURI: "http://127.0.0.1:53100/callback",
		CodeChallenge: strings.Repeat("a", 43), AuthorizationCodeHash: firstHash[:], ExpiresAt: expiresAt,
	}
	if err := env.service.CreateLocalComputerEnrollment(t.Context(), first); err != nil {
		t.Fatalf("create Local Computer enrollment: %v", err)
	}
	consumeFirst := agentruntimestate.ConsumeLocalComputerEnrollmentInput{
		EnrollmentID: first.EnrollmentID, RedirectURI: first.RedirectURI,
		CodeChallenge: first.CodeChallenge, AuthorizationCodeHash: first.AuthorizationCodeHash,
	}
	created, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), consumeFirst)
	assertConsumedEnrollment(t, created, err, first.ComputerID, 0)
	replayed, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), consumeFirst)
	assertConsumedEnrollment(t, replayed, err, first.ComputerID, 0)

	secondHash := sha256.Sum256([]byte("second-authorization-code"))
	renewal := agentruntimestate.CreateLocalComputerEnrollmentInput{
		EnrollmentID: "enrollment-runtime-renewal", ComputerID: first.ComputerID,
		DisplayName: "Runtime enrollment renewed", Owner: owner, RedirectURI: first.RedirectURI,
		CodeChallenge: strings.Repeat("b", 43), AuthorizationCodeHash: secondHash[:], ExpiresAt: expiresAt,
		RenewsExistingComputer: true,
	}
	if err := env.service.CreateLocalComputerEnrollment(t.Context(), renewal); err != nil {
		t.Fatalf("create Local Computer renewal: %v", err)
	}
	consumeRenewal := agentruntimestate.ConsumeLocalComputerEnrollmentInput{
		EnrollmentID: renewal.EnrollmentID, RedirectURI: renewal.RedirectURI,
		CodeChallenge: renewal.CodeChallenge, AuthorizationCodeHash: renewal.AuthorizationCodeHash,
	}
	renewed, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), consumeRenewal)
	assertConsumedEnrollment(t, renewed, err, first.ComputerID, 1)
	renewalReplay, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), consumeRenewal)
	assertConsumedEnrollment(t, renewalReplay, err, first.ComputerID, 1)

	var generation int64
	if err := env.pool.QueryRow(t.Context(), `SELECT credential_generation FROM local_computers WHERE computer_id=$1`, first.ComputerID).Scan(&generation); err != nil {
		t.Fatalf("read exchanged credential generation: %v", err)
	}
	if generation != 1 {
		t.Fatalf("credential generation=%d, want 1 after replayed renewal", generation)
	}
	var enrollmentCount int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM local_computer_enrollments WHERE requested_computer_id=$1`, first.ComputerID).Scan(&enrollmentCount); err != nil {
		t.Fatalf("count exchanged enrollments: %v", err)
	}
	if enrollmentCount != 2 {
		t.Fatalf("exchanged enrollment count=%d, want 2", enrollmentCount)
	}
	for _, rejection := range []string{"authorization_code", "pkce", "redirect", "expired"} {
		t.Run(rejection, func(t *testing.T) {
			pending := first
			pending.EnrollmentID = "enrollment_rejected_" + rejection
			pending.ComputerID = "computer_rejected_" + rejection
			if err := env.service.CreateLocalComputerEnrollment(t.Context(), pending); err != nil {
				t.Fatal(err)
			}
			exchange := consumeFirst
			exchange.EnrollmentID = pending.EnrollmentID
			validExchange := exchange
			switch rejection {
			case "authorization_code":
				wrongHash := sha256.Sum256([]byte("wrong-authorization-code"))
				exchange.AuthorizationCodeHash = wrongHash[:]
			case "pkce":
				exchange.CodeChallenge = strings.Repeat("z", 43)
			case "redirect":
				exchange.RedirectURI = "http://127.0.0.1:53101/callback"
			case "expired":
				if _, err := env.pool.Exec(t.Context(), `UPDATE local_computer_enrollments
					SET expires_at=clock_timestamp()-interval '1 second' WHERE enrollment_id=$1`, pending.EnrollmentID); err != nil {
					t.Fatal(err)
				}
			}
			result, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), exchange)
			if err != nil || result.Available {
				t.Fatalf("invalid exchange=%+v error=%v", result, err)
			}
			retry, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), validExchange)
			if err != nil || retry.Available {
				t.Fatalf("rejected enrollment must remain unavailable: result=%+v error=%v", retry, err)
			}
			var computerExists bool
			if err := env.pool.QueryRow(t.Context(), "SELECT EXISTS(SELECT 1 FROM local_computers WHERE computer_id=$1)", pending.ComputerID).Scan(&computerExists); err != nil {
				t.Fatal(err)
			}
			if computerExists {
				t.Fatal("invalid enrollment created a Computer")
			}
		})
	}
}

func TestAgentRuntimeLocalComputerCredentialValidationAndRemoval(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	computerID := "computer_runtime_credential"
	enrollRuntimeComputer(t, env, computerID)
	owner := runtimeComputerOwner()
	computer, err := env.service.GetLocalComputer(t.Context(), computerID)
	if err != nil || computer.Owner != owner || computer.CredentialGeneration != 0 {
		t.Fatalf("read enrolled Local Computer: %+v err=%v", computer, err)
	}
	setRuntimeAgentPlacementFields(t, env, computerID, "codex")
	blocked, err := env.service.RemoveLocalComputer(t.Context(), agentruntimestate.LocalComputerCredentialInput{
		ComputerID: computerID, Owner: owner,
	})
	if err != nil || blocked != "has_agents" {
		t.Fatalf("block current Local Agent removal: status=%q err=%v", blocked, err)
	}
	other := agentruntimestate.LocalComputerOwner{TenantID: "tenant_acme", OwnerActorID: "actor_acme_bob"}
	if status, err := env.service.RemoveLocalComputer(t.Context(), agentruntimestate.LocalComputerCredentialInput{
		ComputerID: computerID, Owner: other,
	}); err != nil || status != "not_found" {
		t.Fatalf("remove another owner's Computer: status=%q err=%v", status, err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatalf("revoke Local Agent registration: %v", err)
	}
	removed, err := env.service.RemoveLocalComputer(t.Context(), agentruntimestate.LocalComputerCredentialInput{
		ComputerID: computerID, Owner: owner,
	})
	if err != nil || removed != "removed" {
		t.Fatalf("remove Local Computer: status=%q err=%v", removed, err)
	}
	if _, err := env.service.GetLocalComputer(t.Context(), computerID); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("read removed Local Computer: err=%v, want not found", err)
	}
	if _, err := env.service.ConnectLocalComputer(t.Context(), runtimeConnectInput(computerID, 0, time.Now())); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("connect removed Local Computer: err=%v, want not found", err)
	}
}

// A Daemon keeps its identity key, so the same machine can pair again as a
// new Computer once the Computer it held is removed, and not before.
func TestAgentRuntimeLocalComputerRepairsWithSameDaemonAfterRemoval(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	owner := runtimeComputerOwner()
	enrollRuntimeComputer(t, env, "computer_runtime_first")
	first := runtimeConnectInput("computer_runtime_first", 0, time.Now())
	if _, err := env.service.ConnectLocalComputer(t.Context(), first); err != nil {
		t.Fatalf("connect first Computer: %v", err)
	}
	enrollRuntimeComputer(t, env, "computer_runtime_second")
	second := runtimeConnectInput("computer_runtime_second", 0, time.Now())
	second.DaemonID, second.DaemonPublicKey = first.DaemonID, first.DaemonPublicKey
	if _, err := env.service.ConnectLocalComputer(t.Context(), second); !errors.Is(err, agentruntimestate.ErrDaemonIdentityInUse) ||
		!errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("connect with a Daemon Identity a live Computer holds: err=%v, want Daemon Identity in use", err)
	}
	removed, err := env.service.RemoveLocalComputer(t.Context(), agentruntimestate.LocalComputerCredentialInput{
		ComputerID: "computer_runtime_first", Owner: owner,
	})
	if err != nil || removed != "removed" {
		t.Fatalf("remove first Computer: status=%q err=%v", removed, err)
	}
	connected, err := env.service.ConnectLocalComputer(t.Context(), second)
	if err != nil || connected.Computer.ComputerID != "computer_runtime_second" {
		t.Fatalf("pair the same Daemon again after removal: %+v err=%v", connected.Computer, err)
	}
	var daemonID string
	if err := env.pool.QueryRow(t.Context(), `SELECT daemon_id FROM local_computers WHERE computer_id='computer_runtime_second'`).Scan(&daemonID); err != nil ||
		daemonID != first.DaemonID {
		t.Fatalf("second Computer Daemon Identity: %q err=%v", daemonID, err)
	}
}

// A move only changes the registration row. The Computer the Agent left no
// longer lists it when it connects, so its Runner there is removed and its
// late results have no placement; the new Computer lists it at the next
// Runtime Assignment revision.
func TestAgentRuntimeLocalComputerConnectListsPlacementsFromRegistrationRows(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	enrollRuntimeComputer(t, env, "computer_runtime_old")
	enrollRuntimeComputer(t, env, "computer_runtime_new")
	setRuntimeAgentPlacementFields(t, env, "computer_runtime_old", "codex")
	now := time.Now().UTC().Truncate(time.Microsecond)

	connected, err := env.service.ConnectLocalComputer(t.Context(), runtimeConnectInput("computer_runtime_old", 0, now))
	if err != nil {
		t.Fatalf("connect Local Computer: %v", err)
	}
	if connected.Computer.Status != "offline" || len(connected.Placements) != 1 {
		t.Fatalf("connected Computer=%+v placements=%+v", connected.Computer, connected.Placements)
	}
	placement := connected.Placements[0]
	if placement.AgentID != testRuntimeAgentID || placement.TenantID != "tenant_acme" || placement.OwnerActorID != "actor_acme_alice" ||
		placement.RuntimeType != "codex" || placement.WorkspaceGrantID != "grant_runtime" || placement.AssignmentRevision != 1 {
		t.Fatalf("placement=%+v", placement)
	}

	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations
		SET computer_id='computer_runtime_new',assignment_revision=assignment_revision+1
		WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatalf("move Agent: %v", err)
	}
	left, err := env.service.ConnectLocalComputer(t.Context(), runtimeConnectInput("computer_runtime_old", 0, now.Add(time.Second)))
	if err != nil || len(left.Placements) != 0 {
		t.Fatalf("Computer the Agent left: placements=%+v err=%v", left.Placements, err)
	}
	moved, err := env.service.ConnectLocalComputer(t.Context(), runtimeConnectInput("computer_runtime_new", 0, now.Add(time.Second)))
	if err != nil || len(moved.Placements) != 1 || moved.Placements[0].AssignmentRevision != 2 {
		t.Fatalf("Computer the Agent moved to: placements=%+v err=%v", moved.Placements, err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1`, testRuntimeAgentID); err != nil {
		t.Fatalf("revoke Agent: %v", err)
	}
	revoked, err := env.service.ConnectLocalComputer(t.Context(), runtimeConnectInput("computer_runtime_new", 0, now.Add(time.Second)))
	if err != nil || len(revoked.Placements) != 0 {
		t.Fatalf("Computer of a revoked Agent: placements=%+v err=%v", revoked.Placements, err)
	}

	stale := runtimeConnectInput("computer_runtime_old", 0, now.Add(2*time.Second))
	stale.CredentialGeneration = 1
	if _, err := env.service.ConnectLocalComputer(t.Context(), stale); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("connect with another credential generation: err=%v, want conflict", err)
	}
	foreign := runtimeConnectInput("computer_runtime_old", 0, now.Add(2*time.Second))
	foreign.Owner = agentruntimestate.LocalComputerOwner{TenantID: "tenant_acme", OwnerActorID: "actor_acme_bob"}
	if _, err := env.service.ConnectLocalComputer(t.Context(), foreign); !errors.Is(err, agentruntimestate.ErrNotFound) {
		t.Fatalf("connect with another owner: err=%v, want not found", err)
	}
	replaced := runtimeConnectInput("computer_runtime_old", 0, now.Add(2*time.Second))
	replaced.DaemonID = strings.Repeat("Z", 43)
	if _, err := env.service.ConnectLocalComputer(t.Context(), replaced); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("connect with another Daemon Identity: err=%v, want conflict", err)
	}
}

func TestAgentRuntimeLocalComputerFreshnessPublishesCommittedHints(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	drainHints := listenTenantHints(t, env.pool)
	computerHints, agentHints := 0, 0
	// Each committed change publishes one hint of each kind; PostgreSQL folds
	// duplicates within a transaction.
	assertFreshness := func(want int) {
		t.Helper()
		hints := drainHints()
		computerHints += hints[realtime.InvalidationKindPrefix+realtime.InvalidateComputers]
		agentHints += hints[realtime.InvalidationKindPrefix+realtime.InvalidateAgents]
		if computerHints != want || agentHints != want {
			t.Fatalf("Computer/Agent hints=%d/%d, want %d", computerHints, agentHints, want)
		}
	}
	computerID := "computer_runtime_freshness"
	enrollRuntimeComputer(t, env, computerID)
	assertFreshness(1)
	connectedAt := time.Now().UTC().Truncate(time.Microsecond)
	connect := func(seenAt time.Time, platform string) agentruntimestate.LocalComputer {
		t.Helper()
		input := runtimeConnectInput(computerID, 0, seenAt)
		input.Status, input.Platform = "online", platform
		connected, err := env.service.ConnectLocalComputer(t.Context(), input)
		if err != nil {
			t.Fatalf("connect Local Computer: %v", err)
		}
		return connected.Computer
	}
	if first := connect(connectedAt, "win32"); first.Platform != "win32" || first.Status != "online" {
		t.Fatalf("connected Local Computer=%+v", first)
	}
	assertFreshness(2)
	heartbeatAt := connectedAt.Add(time.Second)
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: computerID, Status: "online", SeenAt: heartbeatAt,
	}); err != nil {
		t.Fatalf("touch Local Computer heartbeat: %v", err)
	}
	assertFreshness(2)
	diagnosticsAt := heartbeatAt.Add(time.Second)
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: computerID, Status: "online", SeenAt: diagnosticsAt,
		RuntimeDiagnostics: json.RawMessage(`[{"runtime":"codex","status":"ready"}]`),
	}); err != nil {
		t.Fatalf("update Local Computer diagnostics: %v", err)
	}
	assertFreshness(3)
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: computerID, Status: "online", SeenAt: diagnosticsAt.Add(time.Second),
		RuntimeDiagnostics: json.RawMessage("[ { \"status\": \"ready\", \"runtime\": \"codex\" } ]"),
	}); err != nil {
		t.Fatalf("repeat semantically identical Local Computer diagnostics: %v", err)
	}
	assertFreshness(3)
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: computerID, Status: "offline", SeenAt: diagnosticsAt.Add(2 * time.Second),
	}); err != nil {
		t.Fatalf("disconnect Local Computer: %v", err)
	}
	assertFreshness(4)
	staleHeartbeat, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{ComputerID: computerID, Status: "online", SeenAt: diagnosticsAt})
	if err != nil || staleHeartbeat.Status != "offline" {
		t.Fatalf("stale heartbeat status=%q err=%v, want offline", staleHeartbeat.Status, err)
	}
	assertFreshness(4)
	connect(diagnosticsAt.Add(4*time.Second), "")
	assertFreshness(5)
	if _, err := env.service.StartEpoch(t.Context(), "epoch-runtime-freshness"); err != nil {
		t.Fatalf("start epoch: %v", err)
	}
	assertFreshness(6)
	offline, err := env.service.GetLocalComputer(t.Context(), computerID)
	if err != nil || offline.Status != "offline" || offline.Platform != "win32" {
		t.Fatalf("Computer after epoch start=%+v err=%v", offline, err)
	}
	updating, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: computerID, Status: "offline", SeenAt: diagnosticsAt.Add(6 * time.Second),
		DaemonVersion: "0.42.0", RecommendedVersion: "0.43.0",
	})
	if err != nil || updating.Status != "offline" {
		t.Fatalf("record updating Computer=%+v err=%v", updating, err)
	}
	assertFreshness(7)
	if updated := connect(diagnosticsAt.Add(10*time.Second), "linux"); updated.Platform != "linux" {
		t.Fatalf("updated Local Computer platform=%q, want linux", updated.Platform)
	}
	assertFreshness(8)
}

func runtimeConnectInput(computerID string, generation int64, seenAt time.Time) agentruntimestate.ConnectLocalComputerInput {
	// Each Computer has its own Daemon, whose ID is derived from its public key
	// as the Daemon derives it; one Daemon identity binds to one Computer.
	key := sha256.Sum256([]byte("daemon-" + computerID))
	daemonID := sha256.Sum256(key[:])
	return agentruntimestate.ConnectLocalComputerInput{
		ComputerID: computerID, Owner: runtimeComputerOwner(), CredentialGeneration: generation,
		DaemonID: base64.RawURLEncoding.EncodeToString(daemonID[:]), DaemonPublicKey: key[:], IdentityVersion: 1,
		Status: "offline", SeenAt: seenAt, DisplayName: computerID, DaemonVersion: "0.43.0",
		Runtimes: json.RawMessage(`["codex"]`), RuntimeDiagnostics: json.RawMessage(`[]`),
		WorkspaceGrants: json.RawMessage(`[{"grant_id":"grant_runtime","tenant_id":"tenant_acme","mode":"workspace-write","scope":"owner"}]`),
	}
}

func runtimeComputerOwner() agentruntimestate.LocalComputerOwner {
	return agentruntimestate.LocalComputerOwner{TenantID: "tenant_acme", OwnerActorID: "actor_acme_alice"}
}

// listenTenantHints returns a drain of the Tenant invalidation hints, by
// notification kind, committed since the previous call.
func listenTenantHints(t *testing.T, pool *pgxpool.Pool) func() map[string]int {
	t.Helper()
	listener, err := pgx.ConnectConfig(t.Context(), pool.Config().ConnConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(context.Background()) })
	if _, err := listener.Exec(t.Context(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	return func() map[string]int {
		t.Helper()
		counts := map[string]int{}
		for {
			ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
			notification, err := listener.WaitForNotification(ctx)
			cancel()
			if errors.Is(err, context.DeadlineExceeded) {
				return counts
			}
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(decoded.Topic, "tenant:") {
				counts[decoded.Kind]++
			}
		}
	}
}

func enrollRuntimeComputer(t *testing.T, env runtimeStateTestEnv, computerID string) {
	t.Helper()
	if err := enrollRuntimeComputerFor(t, env, computerID, runtimeComputerOwner()); err != nil {
		t.Fatalf("enroll Runtime test Local Computer %q: %v", computerID, err)
	}
}

// enrollRuntimeComputerFor pairs a Computer through the production enrollment
// exchange, the only path that creates Local Computers.
func enrollRuntimeComputerFor(t *testing.T, env runtimeStateTestEnv, computerID string, owner agentruntimestate.LocalComputerOwner) error {
	t.Helper()
	codeHash := sha256.Sum256([]byte("authorization-code-" + computerID))
	enrollment := agentruntimestate.CreateLocalComputerEnrollmentInput{
		EnrollmentID: "enrollment-" + computerID, ComputerID: computerID, DisplayName: computerID,
		Owner: owner, RedirectURI: "http://127.0.0.1:53100/callback", CodeChallenge: strings.Repeat("a", 43),
		AuthorizationCodeHash: codeHash[:], ExpiresAt: time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour),
	}
	if err := env.service.CreateLocalComputerEnrollment(t.Context(), enrollment); err != nil {
		return err
	}
	result, err := env.service.ConsumeLocalComputerEnrollment(t.Context(), agentruntimestate.ConsumeLocalComputerEnrollmentInput{
		EnrollmentID: enrollment.EnrollmentID, RedirectURI: enrollment.RedirectURI,
		CodeChallenge: enrollment.CodeChallenge, AuthorizationCodeHash: enrollment.AuthorizationCodeHash,
	})
	if err == nil && !result.Available {
		return errors.New("Local Computer enrollment was unavailable")
	}
	return err
}

func assertConsumedEnrollment(
	t *testing.T,
	result agentruntimestate.ConsumeLocalComputerEnrollmentResult,
	err error,
	computerID string,
	generation int64,
) {
	t.Helper()
	if err != nil || !result.Available || result.Enrollment == nil || result.Computer == nil ||
		result.CredentialGeneration == nil || result.Enrollment.ComputerID != computerID ||
		result.Computer.ComputerID != computerID || *result.CredentialGeneration != generation {
		t.Fatalf("consume Local Computer enrollment: result=%+v err=%v, want computer=%q generation=%d", result, err, computerID, generation)
	}
}

func setRuntimeAgentPlacementFields(
	t *testing.T,
	env runtimeStateTestEnv,
	computerID string,
	runtimeType string,
) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations
		SET computer_id=$1,local_runtime_type=$2,workspace_grant_id='grant_runtime'
		WHERE agent_management_id=$3`, computerID, runtimeType, testRuntimeAgentID); err != nil {
		t.Fatalf("set Runtime test Agent Local placement: %v", err)
	}
}
