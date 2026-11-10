package agentdirectmessage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestServicePostgreSQLBehavior(t *testing.T) {
	databaseURL := os.Getenv("TEAMHUB_AGENT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEAMHUB_AGENT_TEST_DATABASE_URL is not set")
	}
	connectionConfig, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse database URL: %v", err)
	}
	if connectionConfig.Database != "teamhub_mcp_context_test" {
		t.Fatalf("integration database must be named teamhub_mcp_context_test, got %q", connectionConfig.Database)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	poolConfig.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	defer pool.Close()

	fixture := newDirectMessagePostgresFixture(t, pool)
	t.Run("Agent batch resolves current Human sponsor and persists ordered facts", func(t *testing.T) {
		fixture.assertBatchReplayConflictAndRoomReuse(t, ctx)
	})
	t.Run("batch failure rolls back every collaboration fact", func(t *testing.T) {
		fixture.assertAtomicRollback(t, ctx)
	})
	t.Run("concurrent first invocation creates one Direct Room and one batch", func(t *testing.T) {
		fixture.assertConcurrentFirstInvocation(t, ctx)
	})
	t.Run("non-Human inactive and revoked authority fail closed", func(t *testing.T) {
		fixture.assertFailClosedAuthority(t, ctx)
	})
	t.Run("a deleted Direct Room reopens only after its deletion finishes", func(t *testing.T) {
		fixture.assertReopenAfterDeletion(t, ctx)
	})
	var executionCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_local_runs run JOIN agent_execution_contexts execution ON execution.context_key=run.context_key WHERE execution.agent_management_id LIKE $1`, "%"+fixture.suffix).Scan(&executionCount); err != nil {
		t.Fatal(err)
	}
	if executionCount != 0 {
		t.Fatalf("private message test created execution authority: runs=%d", executionCount)
	}
}

type directMessagePostgresFixture struct {
	pool     *pgxpool.Pool
	contexts *agentauth.Service
	service  *Service
	suffix   string
}

type directMessageIdentity struct {
	tenantID               string
	accountID              string
	humanActorID           string
	agentActorID           string
	agentManagementID      string
	nonHumanSponsorActorID string
}

type directMessageFactSnapshot struct {
	rooms           int64
	directRooms     int64
	messages        int64
	roomEvents      int64
	idempotencyKeys int64
}

func newDirectMessagePostgresFixture(
	t *testing.T,
	pool *pgxpool.Pool,
) *directMessagePostgresFixture {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fixture := &directMessagePostgresFixture{pool: pool, suffix: suffix}
	fixture.contexts = agentauth.New(pool)
	fixture.service = New(pool, fixture.contexts)
	return fixture
}

func (fixture *directMessagePostgresFixture) assertBatchReplayConflictAndRoomReuse(t *testing.T, ctx context.Context) {
	t.Helper()
	identity := fixture.createIdentity(t, ctx, "batch")
	credential := fixture.issueCredential(t, ctx, identity)
	messages := []string{" first message ", "second message", "third message"}
	input := Input{InvocationID: directMessageInvocationID("batch-first"), Messages: messages}

	result, err := fixture.service.Send(ctx, credential.AccessToken, input)
	if err != nil {
		t.Fatalf("send first Direct Message batch: %v", err)
	}
	fixture.assertFreshResult(t, result, len(messages))
	roomID := strings.TrimPrefix(result.InboxID, "room:")
	fixture.assertPersistedBatch(t, ctx, identity, roomID, result.MessageIDs, messages)
	written := fixture.factSnapshot(t, ctx, identity)
	wantWritten := directMessageFactSnapshot{
		rooms: 1, directRooms: 1, messages: int64(len(messages)), roomEvents: int64(len(messages) + 2),
		idempotencyKeys: 1,
	}
	if written != wantWritten {
		t.Fatalf("first batch facts=%+v want=%+v", written, wantWritten)
	}

	if _, err := fixture.pool.Exec(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, credential.CredentialID); err != nil {
		t.Fatalf("expire original Agent credential: %v", err)
	}
	if _, err := fixture.service.Send(ctx, credential.AccessToken, input); !errors.Is(err, agentauth.ErrCredentialInvalid) {
		t.Fatalf("expired credential replay error=%v want ErrContextInvalid", err)
	}
	credential = fixture.issueCredential(t, ctx, identity)
	replay, err := fixture.service.Send(ctx, credential.AccessToken, input)
	if err != nil {
		t.Fatalf("replay Direct Message batch: %v", err)
	}
	if !replay.Replay {
		t.Fatalf("replay flag Replay=%v", replay.Replay)
	}
	assertSameDirectMessageResult(t, replay, result)
	if replayFacts := fixture.factSnapshot(t, ctx, identity); replayFacts != written {
		t.Fatalf("replay changed facts: before=%+v after=%+v", written, replayFacts)
	}

	conflicting := input
	conflicting.Messages = []string{"different payload"}
	if _, err := fixture.service.Send(ctx, credential.AccessToken, conflicting); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting invocation error=%v want ErrIdempotencyConflict", err)
	}
	if conflictFacts := fixture.factSnapshot(t, ctx, identity); conflictFacts != written {
		t.Fatalf("conflict changed facts: before=%+v after=%+v", written, conflictFacts)
	}

	followUp, err := fixture.service.Send(ctx, credential.AccessToken, Input{
		InvocationID: directMessageInvocationID("batch-follow-up"),
		Messages:     []string{"follow-up"},
	})
	if err != nil {
		t.Fatalf("send follow-up Direct Message: %v", err)
	}
	if followUp.Replay || followUp.RoomCreated || followUp.InboxID != result.InboxID || len(followUp.MessageIDs) != 1 {
		t.Fatalf("follow-up result=%+v", followUp)
	}
	if facts := fixture.factSnapshot(t, ctx, identity); facts != (directMessageFactSnapshot{
		rooms: 1, directRooms: 1, messages: int64(len(messages) + 1), roomEvents: int64(len(messages) + 3),
		idempotencyKeys: 2,
	}) {
		t.Fatalf("follow-up facts=%+v", facts)
	}
}

func (fixture *directMessagePostgresFixture) assertFreshResult(
	t *testing.T,
	result Result,
	messageCount int,
) {
	t.Helper()
	if !result.Accepted || result.Replay || !result.RoomCreated || !strings.HasPrefix(result.InboxID, "room:") ||
		len(result.MessageIDs) != messageCount {
		t.Fatalf("fresh result=%+v", result)
	}
}

func (fixture *directMessagePostgresFixture) assertPersistedBatch(
	t *testing.T,
	ctx context.Context,
	identity directMessageIdentity,
	roomID string,
	messageIDs []string,
	messages []string,
) {
	t.Helper()
	var humanActorID, agentActorID, roomName, createdBy string
	var nextRoomSeq int64
	if err := fixture.pool.QueryRow(ctx, `
		SELECT room.direct_human_actor_id,room.direct_agent_actor_id,room.name,room.created_by_actor_id,room.next_room_seq
		FROM rooms room
		WHERE room.id=$1 AND room.direct_agent_actor_id IS NOT NULL
	`, roomID).Scan(&humanActorID, &agentActorID, &roomName, &createdBy, &nextRoomSeq); err != nil {
		t.Fatalf("read Direct Room: %v", err)
	}
	if humanActorID != identity.humanActorID || agentActorID != identity.agentActorID ||
		roomName != "Direct Message Agent batch" || createdBy != identity.agentActorID || nextRoomSeq != int64(2+len(messages)) {
		t.Fatalf("Direct Room human=%q agent=%q name=%q creator=%q next_seq=%d",
			humanActorID, agentActorID, roomName, createdBy, nextRoomSeq)
	}
	var ownerCount, agentMemberCount int64
	if err := fixture.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE actor_id=$2 AND role='owner'),
		       count(*) FILTER (WHERE actor_id=$3 AND role='member')
		FROM active_room_members WHERE room_id=$1
	`, roomID, identity.humanActorID, identity.agentActorID).Scan(&ownerCount, &agentMemberCount); err != nil {
		t.Fatalf("read Direct Room members: %v", err)
	}
	if ownerCount != 1 || agentMemberCount != 1 {
		t.Fatalf("Direct Room owner count=%d Agent member count=%d", ownerCount, agentMemberCount)
	}
	var roomKind string
	if err := fixture.pool.QueryRow(ctx, `
		SELECT room_kind
		FROM agent_execution_contexts
		WHERE agent_actor_id=$1 AND agent_management_id=$2
		  AND room_id=$3 AND context_kind='meta'
	`, identity.agentActorID, identity.agentManagementID, roomID).Scan(&roomKind); err != nil {
		t.Fatalf("read Direct Room Meta Context kind: %v", err)
	}
	if roomKind != "direct" {
		t.Fatalf("Direct Room Meta Context kind=%q want=direct", roomKind)
	}

	rows, err := fixture.pool.Query(ctx, `
		SELECT event.resource_id,message.body,message.author_actor_id,event.room_seq
		FROM room_events event
		JOIN messages message
		  ON message.id=event.resource_id AND message.room_id=event.room_id
		WHERE event.room_id=$1 AND event.event_type='message.created'
		ORDER BY event.room_seq
	`, roomID)
	if err != nil {
		t.Fatalf("query persisted Direct Messages: %v", err)
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var messageID, body, author string
		var roomSeq int64
		if err := rows.Scan(&messageID, &body, &author, &roomSeq); err != nil {
			t.Fatalf("scan persisted Direct Message: %v", err)
		}
		if index >= len(messages) || messageID != messageIDs[index] || body != messages[index] ||
			author != identity.agentActorID || roomSeq != int64(3+index) {
			t.Fatalf("message %d id=%q body=%q author=%q room_seq=%d", index, messageID, body, author, roomSeq)
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate persisted Direct Messages: %v", err)
	}
	if index != len(messages) {
		t.Fatalf("persisted message count=%d want=%d", index, len(messages))
	}

	var eventTypes []string
	if err := fixture.pool.QueryRow(ctx, `
		SELECT array_agg(event_type ORDER BY room_seq) FROM room_events WHERE room_id=$1
	`, roomID).Scan(&eventTypes); err != nil {
		t.Fatalf("read Room event order: %v", err)
	}
	wantEventTypes := append([]string{"room.created", "room.member.added"}, make([]string, len(messages))...)
	for index := range messages {
		wantEventTypes[index+2] = "message.created"
	}
	if !slices.Equal(eventTypes, wantEventTypes) {
		t.Fatalf("Room event types=%v want=%v", eventTypes, wantEventTypes)
	}
}

func (fixture *directMessagePostgresFixture) assertAtomicRollback(t *testing.T, ctx context.Context) {
	t.Helper()
	identity := fixture.createIdentity(t, ctx, "atomic")
	credential := fixture.issueCredential(t, ctx, identity)
	failing := New(fixture.pool, fixture.contexts)
	boom := errors.New("injected second message failure")
	createdMessages := 0
	failing.createMessage = func(
		ctx context.Context,
		queries *store.Queries,
		draft messagecreation.Draft,
	) (messagecreation.Result, error) {
		createdMessages++
		if createdMessages == 2 {
			return messagecreation.Result{}, boom
		}
		return messagecreation.Create(ctx, queries, draft)
	}
	if _, err := failing.Send(ctx, credential.AccessToken, Input{
		InvocationID: directMessageInvocationID("atomic"), Messages: []string{"first", "second"},
	}); !errors.Is(err, boom) {
		t.Fatalf("atomic failure error=%v want injected failure", err)
	}
	if createdMessages != 2 {
		t.Fatalf("createMessage calls=%d want=2", createdMessages)
	}
	fixture.assertNoCollaborationFacts(t, ctx, identity)
}

func (fixture *directMessagePostgresFixture) assertConcurrentFirstInvocation(t *testing.T, ctx context.Context) {
	t.Helper()
	identity := fixture.createIdentity(t, ctx, "concurrent")
	credential := fixture.issueCredential(t, ctx, identity)
	input := Input{InvocationID: directMessageInvocationID("concurrent"), Messages: []string{"one concurrent message"}}

	const callers = 8
	start := make(chan struct{})
	results := make([]Result, callers)
	errorsByCaller := make([]error, callers)
	var wait sync.WaitGroup
	wait.Add(callers)
	for index := 0; index < callers; index++ {
		go func() {
			defer wait.Done()
			<-start
			results[index], errorsByCaller[index] = fixture.service.Send(ctx, credential.AccessToken, input)
		}()
	}
	close(start)
	wait.Wait()

	firstIndex := -1
	replayCount := 0
	for index, err := range errorsByCaller {
		if err != nil {
			t.Fatalf("concurrent caller %d error: %v", index, err)
		}
		if results[index].Replay {
			replayCount++
		} else if firstIndex == -1 {
			firstIndex = index
		} else {
			t.Fatalf("multiple first writes: indexes %d and %d", firstIndex, index)
		}
	}
	if firstIndex == -1 || replayCount != callers-1 {
		t.Fatalf("first index=%d replay count=%d", firstIndex, replayCount)
	}
	first := results[firstIndex]
	if !first.RoomCreated || len(first.MessageIDs) != 1 {
		t.Fatalf("concurrent first result=%+v", first)
	}
	for _, result := range results {
		assertSameDirectMessageResult(t, result, first)
	}
	want := directMessageFactSnapshot{
		rooms: 1, directRooms: 1, messages: 1, roomEvents: 3,
		idempotencyKeys: 1,
	}
	if facts := fixture.factSnapshot(t, ctx, identity); facts != want {
		t.Fatalf("concurrent facts=%+v want=%+v", facts, want)
	}
}

func (fixture *directMessagePostgresFixture) assertReopenAfterDeletion(t *testing.T, ctx context.Context) {
	t.Helper()
	identity := fixture.createIdentity(t, ctx, "reopen")
	credential := fixture.issueCredential(t, ctx, identity)
	first, err := fixture.service.Send(ctx, credential.AccessToken, Input{
		InvocationID: directMessageInvocationID("reopen-first"), Messages: []string{"first Room"},
	})
	if err != nil || !first.RoomCreated {
		t.Fatalf("first Direct Message result=%+v err=%v", first, err)
	}
	roomID := strings.TrimPrefix(first.InboxID, "room:")
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE rooms SET deletion_started_at=clock_timestamp(),deletion_started_by_actor_id=$2
		WHERE id=$1
	`, roomID, identity.humanActorID); err != nil {
		t.Fatalf("start Direct Room deletion: %v", err)
	}
	if _, err := fixture.service.Send(ctx, credential.AccessToken, Input{
		InvocationID: directMessageInvocationID("reopen-deleting"), Messages: []string{"denied while deleting"},
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("send while deleting error=%v want ErrUnavailable", err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE rooms SET deleted_at=clock_timestamp(),deleted_by_actor_id=deletion_started_by_actor_id WHERE id=$1
	`, roomID); err != nil {
		t.Fatalf("finish Direct Room deletion: %v", err)
	}
	second, err := fixture.service.Send(ctx, credential.AccessToken, Input{
		InvocationID: directMessageInvocationID("reopen-second"), Messages: []string{"second Room"},
	})
	if err != nil || !second.RoomCreated || second.InboxID == first.InboxID {
		t.Fatalf("reopened Direct Message result=%+v err=%v", second, err)
	}
	var pairRoomID string
	if err := fixture.pool.QueryRow(ctx, `
		SELECT id FROM rooms WHERE tenant_id=$1 AND direct_human_actor_id=$2 AND direct_agent_actor_id=$3
	`, identity.tenantID, identity.humanActorID, identity.agentActorID).Scan(&pairRoomID); err != nil || "room:"+pairRoomID != second.InboxID {
		t.Fatalf("pair Room=%q err=%v want %s", pairRoomID, err, second.InboxID)
	}
}

func (fixture *directMessagePostgresFixture) assertFailClosedAuthority(t *testing.T, ctx context.Context) {
	t.Helper()
	t.Run("non-Human sponsor", func(t *testing.T) {
		identity := fixture.createIdentity(t, ctx, "nonhuman")
		credential := fixture.issueCredential(t, ctx, identity)
		fixture.replaceSponsor(t, ctx, identity, identity.nonHumanSponsorActorID)
		if _, err := fixture.service.Send(ctx, credential.AccessToken, Input{
			InvocationID: directMessageInvocationID("nonhuman"), Messages: []string{"denied"},
		}); !errors.Is(err, ErrSponsorUnavailable) {
			t.Fatalf("non-Human sponsor error=%v want ErrSponsorUnavailable", err)
		}
		fixture.assertNoCollaborationFacts(t, ctx, identity)
	})
	t.Run("inactive registration", func(t *testing.T) {
		identity := fixture.createIdentity(t, ctx, "inactive")
		credential := fixture.issueCredential(t, ctx, identity)
		if _, err := fixture.pool.Exec(ctx, `
			UPDATE agent_registrations SET status='deleting',updated_at=clock_timestamp()
			WHERE actor_id=$1 AND tenant_id=$2
		`, identity.agentActorID, identity.tenantID); err != nil {
			t.Fatalf("deactivate Agent registration: %v", err)
		}
		if _, err := fixture.service.Send(ctx, credential.AccessToken, Input{
			InvocationID: directMessageInvocationID("inactive"), Messages: []string{"denied"},
		}); !errors.Is(err, agentauth.ErrCredentialInvalid) {
			t.Fatalf("inactive registration error=%v want ErrContextInvalid", err)
		}
		fixture.assertNoCollaborationFacts(t, ctx, identity)
	})
	t.Run("expired credential", func(t *testing.T) {
		identity := fixture.createIdentity(t, ctx, "revoked")
		credential := fixture.issueCredential(t, ctx, identity)
		if _, err := fixture.pool.Exec(ctx, `
			UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1
		`, credential.CredentialID); err != nil {
			t.Fatalf("expire Agent credential: %v", err)
		}
		if _, err := fixture.service.Send(ctx, credential.AccessToken, Input{
			InvocationID: directMessageInvocationID("revoked"), Messages: []string{"denied"},
		}); !errors.Is(err, agentauth.ErrCredentialInvalid) {
			t.Fatalf("revoked credential error=%v want ErrContextInvalid", err)
		}
		fixture.assertNoCollaborationFacts(t, ctx, identity)
	})
}

func (fixture *directMessagePostgresFixture) createIdentity(
	t *testing.T,
	ctx context.Context,
	label string,
) directMessageIdentity {
	t.Helper()
	identity := directMessageIdentity{
		tenantID:               "tenant_dm_" + label + "_" + fixture.suffix,
		accountID:              "account_dm_" + label + "_" + fixture.suffix,
		humanActorID:           "actor_dm_human_" + label + "_" + fixture.suffix,
		agentActorID:           "actor_dm_agent_" + label + "_" + fixture.suffix,
		agentManagementID:      "agent_dm_" + label + "_" + fixture.suffix,
		nonHumanSponsorActorID: "actor_dm_sponsor_agent_" + label + "_" + fixture.suffix,
	}
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin identity fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,'x')
	`, identity.accountID, "dm-"+label+"-"+fixture.suffix+"@example.com"); err != nil {
		t.Fatalf("insert Human account: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
		VALUES($1,$2,'human',$3,$4)
	`, identity.humanActorID, identity.tenantID, "Direct Message Human "+label, identity.accountID); err != nil {
		t.Fatalf("insert Human actor: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent',$3,$4),($5,$2,'agent',$6,$7)
	`, identity.agentActorID, identity.tenantID, "Direct Message Agent "+label, "@dm-agent-"+label+"-"+fixture.suffix,
		identity.nonHumanSponsorActorID, "Non-Human Sponsor "+label, "@dm-sponsor-"+label+"-"+fixture.suffix); err != nil {
		t.Fatalf("insert Agent actors: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Direct Message integration instructions.','test-model',$4,'general','computer_fixture','codex','grant_files')
	`, identity.agentActorID, identity.tenantID, identity.agentManagementID, identity.humanActorID); err != nil {
		t.Fatalf("insert active Agent registration: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit identity fixture: %v", err)
	}
	return identity
}

func (fixture *directMessagePostgresFixture) replaceSponsor(
	t *testing.T,
	ctx context.Context,
	identity directMessageIdentity,
	sponsorActorID string,
) {
	t.Helper()
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE agent_registrations SET created_by_actor_id=$1,updated_at=clock_timestamp()
		WHERE actor_id=$2 AND tenant_id=$3
	`, sponsorActorID, identity.agentActorID, identity.tenantID); err != nil {
		t.Fatalf("replace active registration sponsor: %v", err)
	}
}

func (fixture *directMessagePostgresFixture) issueCredential(t *testing.T, ctx context.Context, identity directMessageIdentity) agentcredential.Issued {
	t.Helper()
	issued, err := agentcredential.New(fixture.pool).IssueManaged(ctx, identity.agentManagementID, "Direct message PostgreSQL test")
	if err != nil {
		t.Fatalf("issue Agent credential: %v", err)
	}
	return issued
}

func (fixture *directMessagePostgresFixture) factSnapshot(
	t *testing.T,
	ctx context.Context,
	identity directMessageIdentity,
) directMessageFactSnapshot {
	t.Helper()
	var result directMessageFactSnapshot
	if err := fixture.pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM rooms WHERE tenant_id=$1 AND created_by_actor_id=$2),
			(SELECT count(*) FROM rooms WHERE tenant_id=$1 AND direct_agent_actor_id=$2),
			(SELECT count(*) FROM messages WHERE tenant_id=$1 AND author_actor_id=$2),
			(SELECT count(*) FROM room_events WHERE tenant_id=$1 AND actor_id=$2),
			(SELECT count(*) FROM command_replays WHERE scope='agent:'||$2::text)
	`, identity.tenantID, identity.agentActorID).Scan(
		&result.rooms,
		&result.directRooms,
		&result.messages,
		&result.roomEvents,
		&result.idempotencyKeys,
	); err != nil {
		t.Fatalf("read Direct Message fact snapshot: %v", err)
	}
	return result
}

func (fixture *directMessagePostgresFixture) assertNoCollaborationFacts(
	t *testing.T,
	ctx context.Context,
	identity directMessageIdentity,
) {
	t.Helper()
	if facts := fixture.factSnapshot(t, ctx, identity); facts != (directMessageFactSnapshot{}) {
		t.Fatalf("unexpected collaboration facts=%+v", facts)
	}
}

func directMessageInvocationID(label string) string {
	digest := sha256.Sum256([]byte("Agent Direct Message operation:" + label))
	return fmt.Sprintf("agent-invocation-sha256:%x", digest[:])
}

func assertSameDirectMessageResult(t *testing.T, got, want Result) {
	t.Helper()
	if got.Accepted != want.Accepted || got.InboxID != want.InboxID ||
		!slices.Equal(got.MessageIDs, want.MessageIDs) || got.RoomCreated != want.RoomCreated {
		t.Fatalf("result=%+v want persisted fields from %+v", got, want)
	}
}
