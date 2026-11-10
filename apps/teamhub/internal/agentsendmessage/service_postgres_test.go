package agentsendmessage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
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
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
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
	poolConfig.MaxConns = 12
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	defer pool.Close()

	fixture := newSendMessagePostgresFixture(t, ctx, pool)
	t.Run("Room message delegates mentions and keeps Document references", func(t *testing.T) {
		fixture.assertRoomMessageShape(t, ctx)
	})
	t.Run("Room and Task Document references require their exact active Binding", func(t *testing.T) {
		fixture.assertDocumentReferenceAdmission(t, ctx)
	})
	t.Run("exact replay conflict and credential rotation are stable", func(t *testing.T) {
		fixture.assertReplayConflictAndCredentialRotation(t, ctx)
	})
	t.Run("alterEgo may send to a different visible Task", func(t *testing.T) {
		fixture.assertAlterEgoTaskTarget(t, ctx)
	})
	t.Run("Task visibility and lifecycle fail closed", func(t *testing.T) {
		fixture.assertTaskVisibility(t, ctx)
	})
	t.Run("concurrent first invocation persists once", func(t *testing.T) {
		fixture.assertConcurrentFirstInvocation(t, ctx)
	})
	t.Run("late failure rolls back Message Event and idempotency", func(t *testing.T) {
		fixture.assertAtomicRollback(t, ctx)
	})
	t.Run("replay rechecks current Task and Room authority", func(t *testing.T) {
		fixture.assertReplayRechecksTarget(t, ctx)
	})
	t.Run("Room replay rechecks current membership authority", func(t *testing.T) {
		fixture.assertRoomReplayRechecksMembership(t, ctx)
	})
	t.Run("Room writes require the caller's matching Room Context", func(t *testing.T) {
		fixture.assertRoomContextRequired(t, ctx)
	})
	t.Run("expired credential and inactive Agent fail closed", func(t *testing.T) {
		fixture.assertCredentialLifecycle(t, ctx)
	})
	var lifecycleCount int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_execution_contexts WHERE tenant_id=$1`, fixture.tenantID).Scan(&lifecycleCount); err != nil || lifecycleCount != 0 {
		t.Fatalf("business calls must not create execution authority: count=%d err=%v", lifecycleCount, err)
	}

}

type sendMessagePostgresFixture struct {
	pool                  *pgxpool.Pool
	contexts              *agentauth.Service
	service               *Service
	objects               artifactstore.ObjectStore
	documents             *document.Service
	suffix                string
	tenantID              string
	ownerAccountID        string
	ownerActorID          string
	agentActorID          string
	agentManagementID     string
	mainRoomID            string
	threadRoomID          string
	threadRootMessageID   string
	currentTaskID         string
	visibleTaskID         string
	visibleTaskRoomID     string
	deletedCommentTaskID  string
	resolvedTaskID        string
	archivedTaskID        string
	deletingRoomTaskID    string
	noMembershipTaskID    string
	issueID               string
	publishedVersionID    string
	foreignVersionID      string
	publishedDocumentID   string
	foreignFileDocumentID string
	roomDocumentID        string
	taskDocumentID        string
	interactionCardID     string
	interactionDecisionID string
	untrustedRuntimeID    string
	metaContext           sendMessageTestCredential
	alterContext          sendMessageTestCredential
	coreInput             Input
	coreResult            Result
	taskResult            Result
	nextTaskNumber        int64
}

type sendMessageTestCredential struct {
	credentialID string
	token        string
}

type sendMessageFactSnapshot struct {
	messages        int64
	roomEvents      int64
	mentions        int64
	attachments     int64
	idempotencyKeys int64
	localRuns       int64
}

func newSendMessagePostgresFixture(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
) *sendMessagePostgresFixture {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fixture := &sendMessagePostgresFixture{
		pool: pool, suffix: suffix,
		tenantID:              "tenant_sm_" + suffix,
		ownerAccountID:        "account_sm_owner_" + suffix,
		ownerActorID:          "actor_sm_owner_" + suffix,
		agentActorID:          "actor_sm_agent_" + suffix,
		agentManagementID:     "agent_sm_" + suffix,
		mainRoomID:            "room_sm_main_" + suffix,
		threadRoomID:          "room_sm_thread_" + suffix,
		threadRootMessageID:   "message_sm_thread_root_" + suffix,
		currentTaskID:         "task.current:" + suffix,
		visibleTaskID:         "task.visible:" + suffix,
		visibleTaskRoomID:     "room_sm_visible_" + suffix,
		deletedCommentTaskID:  "task.deleted_comment:" + suffix,
		resolvedTaskID:        "task.resolved:" + suffix,
		archivedTaskID:        "task.archived:" + suffix,
		deletingRoomTaskID:    "task.deleting_room:" + suffix,
		noMembershipTaskID:    "task.no_membership:" + suffix,
		issueID:               "issue.not_task:" + suffix,
		publishedVersionID:    "version_sm_published_" + suffix,
		foreignVersionID:      "version_sm_foreign_" + suffix,
		publishedDocumentID:   "document_sm_published_" + suffix,
		foreignFileDocumentID: "document_sm_foreign_file_" + suffix,
		roomDocumentID:        "document_sm_room_" + suffix,
		taskDocumentID:        "document_sm_task_" + suffix,
		interactionCardID:     "message_sm_interaction_card_" + suffix,
		interactionDecisionID: "message_sm_interaction_decision_" + suffix,
		untrustedRuntimeID:    "message_sm_untrusted_runtime_" + suffix,
	}
	fixture.contexts = agentauth.New(pool)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 4<<20)
	if err != nil {
		t.Fatalf("create send_message object store: %v", err)
	}
	fixture.objects = objects
	fixture.documents = document.NewWithObjectStore(pool, objects)
	fixture.service = New(pool, fixture.contexts, fixture.documents, fixture.objects)
	fixture.seedIdentityAndTargets(t, ctx)
	fixture.metaContext = fixture.issueCredential(t, ctx)
	fixture.alterContext = fixture.issueCredential(t, ctx)
	fixture.coreInput = fixture.newInput(
		"core",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{
			{Type: "text", Content: "Hello "},
			{Type: "reference", Content: "@Reference", Target: fixture.ownerActorID, TargetType: "user"},
			{Type: "document", Content: " report", DocumentID: fixture.publishedDocumentID},
		},
	)
	return fixture
}

func (fixture *sendMessagePostgresFixture) seedIdentityAndTargets(t *testing.T, ctx context.Context) {
	t.Helper()
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin send_message identity fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,'x')
	`, fixture.ownerAccountID, "sm-owner-"+fixture.suffix+"@example.com"); err != nil {
		t.Fatalf("insert Human account: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
		VALUES($1,$2,'human','Send Message Owner',$3)
	`, fixture.ownerActorID, fixture.tenantID, fixture.ownerAccountID); err != nil {
		t.Fatalf("insert Human actor: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Send Message Agent',$3)
	`, fixture.agentActorID, fixture.tenantID, "@send-message-"+fixture.suffix); err != nil {
		t.Fatalf("insert Agent actor: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Send Message integration instructions.','test-model',$4,'general','computer_fixture','codex','grant_files')
	`, fixture.agentActorID, fixture.tenantID, fixture.agentManagementID, fixture.ownerActorID); err != nil {
		t.Fatalf("insert active Agent registration: %v", err)
	}

	fixture.createRoom(t, ctx, tx, fixture.mainRoomID, true)
	fixture.createThreadRoom(t, ctx, tx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages(
			id,tenant_id,room_id,author_actor_id,body,segments,message_kind
		) VALUES(
			$1,$2,$3,$4,'Please answer',
			'[{"type":"text","content":"Please answer"}]'::jsonb,'conversation'
		)
	`, fixture.interactionCardID, fixture.tenantID, fixture.mainRoomID,
		fixture.agentActorID); err != nil {
		t.Fatalf("insert Human Interaction card Message fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_cards(
			message_id,tenant_id,room_id,work_item_id,
			decision_owner_actor_id,card_type,intent
		) VALUES($1,$2,$3,NULL,$4,'personal_notice','decision_requested')
	`, fixture.interactionCardID, fixture.tenantID, fixture.mainRoomID,
		fixture.ownerActorID); err != nil {
		t.Fatalf("insert decision card fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO decisions(
			id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,
			status,request,view,answer,decided_at,finished_at
		) VALUES(
			$1,$2,$3,$4,'question',$5,$6,'answered','{}'::jsonb,
			'{"prompt":"Please answer","questions":[{"id":"q1","prompt":"Ready?","input":"radio","options":[{"id":"o1","label":"Yes"}]}]}'::jsonb,
			'{"decision":"submit","answers":{"q1":"Yes"}}'::jsonb,clock_timestamp(),clock_timestamp()
		)
	`, "decision_sm_"+fixture.suffix, fixture.tenantID, fixture.mainRoomID,
		fixture.interactionCardID, fixture.agentActorID, fixture.ownerActorID); err != nil {
		t.Fatalf("insert decision fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages(
			id,tenant_id,room_id,author_actor_id,body,segments,
			card_context_message_id,message_kind
		) VALUES(
			$1,$2,$3,$4,'Human interaction decision',
			'[{"type":"text","content":"Human interaction decision"}]'::jsonb,
			$5,'agent_runtime'
		),(
			$6,$2,$3,$4,'Untrusted runtime message',
			'[{"type":"text","content":"Untrusted runtime message"}]'::jsonb,
			NULL,'agent_runtime'
		)
	`, fixture.interactionDecisionID, fixture.tenantID, fixture.mainRoomID,
		fixture.ownerActorID, fixture.interactionCardID, fixture.untrustedRuntimeID); err != nil {
		t.Fatalf("insert Human Interaction decision fixtures: %v", err)
	}
	fixture.createExecutionTask(t, ctx, tx, fixture.currentTaskID, "room_sm_current_"+fixture.suffix)
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.visibleTaskID, roomID: fixture.visibleTaskRoomID,
		visibility: "comment", agentMember: true,
	})
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.deletedCommentTaskID, roomID: "room_sm_deleted_comment_" + fixture.suffix,
		visibility: "deleted_comment", agentMember: true,
	})
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.resolvedTaskID, roomID: "room_sm_resolved_" + fixture.suffix,
		visibility: "access", state: "resolved", agentMember: true,
	})
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.archivedTaskID, roomID: "room_sm_archived_" + fixture.suffix,
		visibility: "assignment", archived: true, agentMember: true,
	})
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.deletingRoomTaskID, roomID: "room_sm_deleting_" + fixture.suffix,
		visibility: "description", deletingRoom: true, agentMember: true,
	})
	fixture.createSimpleTask(t, ctx, tx, simpleTaskSeed{
		id: fixture.noMembershipTaskID, roomID: "room_sm_no_member_" + fixture.suffix,
		visibility: "creator", agentMember: false,
	})
	fixture.createIssue(t, ctx, tx, fixture.issueID, "room_sm_issue_"+fixture.suffix)
	fixture.createDocumentVersion(t, ctx, tx, fixture.mainRoomID, fixture.publishedDocumentID, fixture.publishedVersionID, "main")
	fixture.createDocumentVersion(t, ctx, tx, fixture.visibleTaskRoomID, fixture.foreignFileDocumentID, fixture.foreignVersionID, "foreign")
	if _, err := tx.Exec(ctx, `
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,
			creator_actor_id,creator_actor_kind,status
		) VALUES
			($1,$2,'Room Plan','blocknote',$3,'human',$3,'human','active'),
			($4,$2,'Task Plan','blocknote',$3,'human',$3,'human','active')
	`, fixture.roomDocumentID, fixture.tenantID, fixture.ownerActorID, fixture.taskDocumentID); err != nil {
		t.Fatalf("insert Document reference roots: %v", err)
	}
	// A native Document always has a draft content head; a message reference
	// resolves to it.
	for _, native := range []struct{ documentID, title string }{
		{documentID: fixture.roomDocumentID, title: "Room Plan"},
		{documentID: fixture.taskDocumentID, title: "Task Plan"},
	} {
		revisionID := "revision_" + native.documentID
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_revisions(
				id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
				state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
			) VALUES($1,$2,$3,0,'\x00',repeat('d',64),'\x00',
				'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d','[]'::jsonb,$4)
		`, revisionID, fixture.tenantID, native.documentID, fixture.ownerActorID); err != nil {
			t.Fatalf("insert %s Revision: %v", native.title, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_bodies(document_id,seq,state,state_vector,last_editor_ids)
			VALUES($1,0,'\x00','\x00',ARRAY[$2]::text[])
		`, native.documentID, fixture.ownerActorID); err != nil {
			t.Fatalf("insert %s body: %v", native.title, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,work_item_id,status
		) VALUES
			($1,$2,$3,'room',$4,NULL,'active'),
			($5,$2,$6,'task',NULL,$7,'active')
	`, "binding_sm_room_"+fixture.suffix, fixture.tenantID, fixture.roomDocumentID,
		fixture.mainRoomID, "binding_sm_task_"+fixture.suffix, fixture.taskDocumentID,
		fixture.visibleTaskID); err != nil {
		t.Fatalf("insert Document reference Bindings: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit send_message identity fixture: %v", err)
	}
}

type simpleTaskSeed struct {
	id           string
	roomID       string
	visibility   string
	state        string
	archived     bool
	deletingRoom bool
	agentMember  bool
}

func (fixture *sendMessagePostgresFixture) createRoom(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	roomID string,
	agentMember bool,
) {
	t.Helper()
	if _, err := tx.Exec(ctx, `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES($1,$2,$3,$4)
	`, roomID, fixture.tenantID, roomID, fixture.ownerActorID); err != nil {
		t.Fatalf("insert Room %s: %v", roomID, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES($1,$2,$3,'owner',$3)
	`, roomID, fixture.tenantID, fixture.ownerActorID); err != nil {
		t.Fatalf("insert Room %s owner: %v", roomID, err)
	}
	if agentMember {
		if _, err := tx.Exec(ctx, `
			INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
			VALUES($1,$2,$3,'member',$4)
		`, roomID, fixture.tenantID, fixture.agentActorID, fixture.ownerActorID); err != nil {
			t.Fatalf("insert Room %s Agent member: %v", roomID, err)
		}
	}
}

// A Thread Room has its own rooms row and no membership. Its authority belongs
// to the parent Room.
func (fixture *sendMessagePostgresFixture) createThreadRoom(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
) {
	t.Helper()
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages(
			id,tenant_id,room_id,author_actor_id,body,segments,message_kind
		) VALUES($1,$2,$3,$4,'Thread root','[{"type":"text","content":"Thread root"}]'::jsonb,'conversation')
	`, fixture.threadRootMessageID, fixture.tenantID, fixture.mainRoomID,
		fixture.agentActorID); err != nil {
		t.Fatalf("insert Thread Root Message: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES($1,$2,$3,$4)
	`, fixture.threadRoomID, fixture.tenantID, fixture.threadRoomID,
		fixture.ownerActorID); err != nil {
		t.Fatalf("insert Thread Room: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE rooms SET parent_room_id=$3,root_message_id=$4
		WHERE id=$1 AND tenant_id=$2
	`, fixture.threadRoomID, fixture.tenantID, fixture.mainRoomID,
		fixture.threadRootMessageID); err != nil {
		t.Fatalf("insert Thread Room relation: %v", err)
	}
}

func (fixture *sendMessagePostgresFixture) createExecutionTask(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	taskID string,
	roomID string,
) {
	t.Helper()
	fixture.nextTaskNumber++
	specHash := sha256.Sum256([]byte("send-message-spec:" + taskID))
	factHash := sha256.Sum256([]byte("send-message-fact:" + taskID))
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id)
		VALUES($1,$2,$3,'task',$1,$4,$4)
	`, taskID, fixture.tenantID, fixture.nextTaskNumber, fixture.agentActorID); err != nil {
		t.Fatalf("insert current alterEgo Task: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_generations(
			task_id,tenant_id,generation,result_agent_actor_id,
			spec,spec_hash
		) VALUES($1,$2,1,$3,'{}'::jsonb,$4)
	`, taskID, fixture.tenantID, fixture.agentActorID, specHash[:]); err != nil {
		t.Fatalf("insert current Task generation: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_participants(
			task_id,tenant_id,generation,actor_id,
			agent_management_id,execution_context_ref
		) VALUES($1,$2,1,$3,$4,$5::jsonb)
	`, taskID, fixture.tenantID, fixture.agentActorID, fixture.agentManagementID,
		fmt.Sprintf(`{"kind":"alter_ego","agentId":%q,"taskId":%q}`, fixture.agentManagementID, taskID)); err != nil {
		t.Fatalf("insert current Task participant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
		VALUES($1,$2,$3)
	`, taskID, fixture.tenantID, fixture.agentActorID); err != nil {
		t.Fatalf("insert current Task Meta Inbox: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_facts(
			id,task_id,tenant_id,generation,execution_revision,fact_kind,execution_status,
			control_settled_revision,payload,payload_hash,caused_by_actor_id
		) VALUES($1,$2,$3,1,1,'TASK_EXECUTION_CHANGED','running',0,'{}'::jsonb,$4,$5)
	`, "task_fact_sm_"+fixture.suffix, taskID, fixture.tenantID, factHash[:], fixture.ownerActorID); err != nil {
		t.Fatalf("insert current Task execution fact: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE work_items
		SET state='in_progress',task_execution_generation=1,
		    task_execution_status='running',task_execution_revision=1,
		    task_desired_control='run',task_control_revision=0,task_control_settled_revision=0,
		    task_execution_updated_at=clock_timestamp(),task_next_reconcile_at=clock_timestamp(),
		    task_lease_generation=0,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2
	`, taskID, fixture.tenantID); err != nil {
		t.Fatalf("promote current Task: %v", err)
	}
	fixture.createRoom(t, ctx, tx, roomID, true)
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
		VALUES($1,$2,'work',$3,$4)
	`, taskID, fixture.tenantID, roomID, fixture.ownerActorID); err != nil {
		t.Fatalf("link current Task Work Room: %v", err)
	}
}

func (fixture *sendMessagePostgresFixture) createSimpleTask(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	seed simpleTaskSeed,
) {
	t.Helper()
	fixture.nextTaskNumber++
	state := seed.state
	if state == "" {
		state = "open"
	}
	resolution := any(nil)
	if state == "resolved" {
		resolution = "not_planned"
	}
	createdBy := fixture.ownerActorID
	if seed.visibility == "creator" {
		createdBy = fixture.agentActorID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_items(
			id,tenant_id,number,kind,title,state,resolution,created_by_actor_id,updated_by_actor_id,archived_at
		) VALUES($1,$2,$3,'task',$1,$4,$5,$6,$6,CASE WHEN $7::boolean THEN clock_timestamp() ELSE NULL END)
	`, seed.id, fixture.tenantID, fixture.nextTaskNumber, state, resolution, createdBy, seed.archived); err != nil {
		t.Fatalf("insert Task %s: %v", seed.id, err)
	}
	executionStatus := "materializing"
	if state == "resolved" {
		executionStatus = "terminated"
	}
	specHash := sha256.Sum256([]byte("send-message-simple-spec:" + seed.id))
	factHash := sha256.Sum256([]byte("send-message-simple-fact:" + seed.id))
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_generations(
			task_id,tenant_id,generation,result_agent_actor_id,
			spec,spec_hash
		) VALUES($1,$2,1,$3,'{}'::jsonb,$4)
	`, seed.id, fixture.tenantID, fixture.agentActorID, specHash[:]); err != nil {
		t.Fatalf("insert Task %s generation: %v", seed.id, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_participants(
			task_id,tenant_id,generation,actor_id,
			agent_management_id,execution_context_ref
		) VALUES($1,$2,1,$3,$4,$5::jsonb)
	`, seed.id, fixture.tenantID, fixture.agentActorID, fixture.agentManagementID,
		fmt.Sprintf(`{"kind":"alter_ego","agentId":%q,"taskId":%q}`, fixture.agentManagementID, seed.id)); err != nil {
		t.Fatalf("insert Task %s participant: %v", seed.id, err)
	}
	if state == "resolved" {
		if _, err := tx.Exec(ctx, `
			UPDATE task_execution_generations
			SET terminal_status='terminated',terminal_reason_code='test_terminal',terminal_at=clock_timestamp()
			WHERE task_id=$1 AND tenant_id=$2 AND generation=1
		`, seed.id, fixture.tenantID); err != nil {
			t.Fatalf("terminate Task %s generation: %v", seed.id, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
		VALUES($1,$2,$3)
	`, seed.id, fixture.tenantID, fixture.agentActorID); err != nil {
		t.Fatalf("insert Task %s Meta Inbox: %v", seed.id, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_execution_facts(
			id,task_id,tenant_id,generation,execution_revision,fact_kind,execution_status,
			control_settled_revision,payload,payload_hash,caused_by_actor_id
		) VALUES($1,$2,$3,1,1,'TASK_EXECUTION_CHANGED',$4,0,'{}'::jsonb,$5,$6)
	`, "task_fact_sm_"+strings.ReplaceAll(seed.id, ":", "_"), seed.id, fixture.tenantID,
		executionStatus, factHash[:], fixture.ownerActorID); err != nil {
		t.Fatalf("insert Task %s execution fact: %v", seed.id, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE work_items
		SET task_execution_generation=1,
		    task_execution_status=$3,task_execution_revision=1,
		    task_desired_control='run',task_control_revision=0,task_control_settled_revision=0,
		    task_execution_updated_at=clock_timestamp(),task_next_reconcile_at=clock_timestamp(),
		    task_lease_generation=0,updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2
	`, seed.id, fixture.tenantID, executionStatus); err != nil {
		t.Fatalf("promote Task %s: %v", seed.id, err)
	}
	var err error
	switch seed.visibility {
	case "creator":
	case "assignment":
		_, err = tx.Exec(ctx, `
			INSERT INTO work_item_assignments(work_item_id,tenant_id,actor_id,assigned_by_actor_id)
			VALUES($1,$2,$3,$4)
		`, seed.id, fixture.tenantID, fixture.agentActorID, fixture.ownerActorID)
	case "description":
		_, err = tx.Exec(ctx, `
			INSERT INTO work_item_description_references(work_item_id,tenant_id,actor_id,ordinal)
			VALUES($1,$2,$3,0)
		`, seed.id, fixture.tenantID, fixture.agentActorID)
	case "comment", "deleted_comment":
		commentID := "comment_sm_" + strings.ReplaceAll(seed.id, ":", "_")
		deleted := seed.visibility == "deleted_comment"
		body := "visible reference"
		if deleted {
			body = ""
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO work_item_comments(
				id,work_item_id,tenant_id,author_actor_id,body,segments,deleted_at
			) VALUES($1,$2,$3,$4,$5,'[]'::jsonb,CASE WHEN $6::boolean THEN clock_timestamp() ELSE NULL END)
		`, commentID, seed.id, fixture.tenantID, fixture.ownerActorID, body, deleted); err == nil {
			_, err = tx.Exec(ctx, `
				INSERT INTO work_item_comment_references(comment_id,work_item_id,tenant_id,actor_id)
				VALUES($1,$2,$3,$4)
			`, commentID, seed.id, fixture.tenantID, fixture.agentActorID)
		}
	case "access":
		_, err = tx.Exec(ctx, `
			INSERT INTO work_item_access_grants(work_item_id,tenant_id,actor_id,granted_by_actor_id)
			VALUES($1,$2,$3,$4)
		`, seed.id, fixture.tenantID, fixture.agentActorID, fixture.ownerActorID)
	default:
		t.Fatalf("unknown Task visibility %q", seed.visibility)
	}
	if err != nil {
		t.Fatalf("insert Task %s visibility: %v", seed.id, err)
	}
	fixture.createRoom(t, ctx, tx, seed.roomID, seed.agentMember)
	if seed.deletingRoom {
		if _, err := tx.Exec(ctx, `
			UPDATE rooms
			SET deletion_started_at=clock_timestamp(),deletion_started_by_actor_id=$2,updated_at=clock_timestamp()
			WHERE id=$1
		`, seed.roomID, fixture.ownerActorID); err != nil {
			t.Fatalf("mark Room %s deleting: %v", seed.roomID, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
		VALUES($1,$2,'work',$3,$4)
	`, seed.id, fixture.tenantID, seed.roomID, fixture.ownerActorID); err != nil {
		t.Fatalf("link Task %s Work Room: %v", seed.id, err)
	}
}

func (fixture *sendMessagePostgresFixture) createIssue(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	issueID string,
	roomID string,
) {
	t.Helper()
	fixture.nextTaskNumber++
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id)
		VALUES($1,$2,$3,'issue',$1,$4,$4)
	`, issueID, fixture.tenantID, fixture.nextTaskNumber, fixture.agentActorID); err != nil {
		t.Fatalf("insert Issue %s: %v", issueID, err)
	}
	fixture.createRoom(t, ctx, tx, roomID, true)
	if _, err := tx.Exec(ctx, `
		INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
		VALUES($1,$2,'work',$3,$4)
	`, issueID, fixture.tenantID, roomID, fixture.ownerActorID); err != nil {
		t.Fatalf("link Issue %s Work Room: %v", issueID, err)
	}
}

func (fixture *sendMessagePostgresFixture) createDocumentVersion(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	roomID string,
	documentID string,
	versionID string,
	label string,
) {
	t.Helper()
	if _, err := tx.Exec(ctx, `
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,
			creator_actor_id,creator_actor_kind,status
		) VALUES($1,$2,$3,'plain_text',$4,'human',$4,'human','active')
	`, documentID, fixture.tenantID, label+".txt", fixture.ownerActorID); err != nil {
		t.Fatalf("insert %s Document: %v", label, err)
	}
	objectHash := sha256.Sum256([]byte("send-message-object:" + versionID))
	objectID := fmt.Sprintf("object_%x", objectHash[:16])
	if _, err := tx.Exec(ctx, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES($1,$2,$3,1,$4,'plain_text','text/plain',12,$5,$6,'ordinary_upload',$7)
	`, versionID, fixture.tenantID, documentID, label+".txt",
		strings.Repeat("a", sha256.Size*2), objectID, fixture.ownerActorID); err != nil {
		t.Fatalf("insert %s Document Version: %v", label, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2 WHERE id=$1`, documentID, versionID); err != nil {
		t.Fatalf("advance %s Document current Version: %v", label, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status
		) VALUES($1,$2,$3,'room',$4,'active')
	`, "binding_sm_file_"+label+"_"+fixture.suffix, fixture.tenantID, documentID, roomID); err != nil {
		t.Fatalf("bind %s Document to Room: %v", label, err)
	}
}

func (fixture *sendMessagePostgresFixture) createNextDocumentVersion(
	t *testing.T,
	ctx context.Context,
	documentID string,
	versionID string,
	versionNumber int,
	label string,
) {
	t.Helper()
	objectHash := sha256.Sum256([]byte("send-message-object:" + versionID))
	if _, err := fixture.pool.Exec(ctx, `WITH inserted AS (
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,
			base_version_id
		)
		SELECT $1,$2,$3,$4,$5,'plain_text','text/plain',12,$6,$7,'replacement_upload',$8,
		       document.current_version_id
		FROM documents document
		WHERE document.id=$3 AND document.tenant_id=$2
		RETURNING id,tenant_id,document_id
	)
	UPDATE documents document SET current_version_id=inserted.id
	FROM inserted WHERE document.id=inserted.document_id AND document.tenant_id=inserted.tenant_id
	`, versionID, fixture.tenantID, documentID, versionNumber, label+".txt",
		strings.Repeat("b", sha256.Size*2), fmt.Sprintf("object_%x", objectHash[:16]), fixture.ownerActorID); err != nil {
		t.Fatalf("insert next %s Document Version: %v", label, err)
	}
}

func (fixture *sendMessagePostgresFixture) issueCredential(t *testing.T, ctx context.Context) sendMessageTestCredential {
	t.Helper()
	issued, err := agentcredential.New(fixture.pool).IssueManaged(ctx, fixture.agentManagementID, "send-message-test")
	if err != nil {
		t.Fatalf("issue stable Agent credential: %v", err)
	}
	return sendMessageTestCredential{credentialID: issued.CredentialID, token: issued.AccessToken}
}

func (fixture *sendMessagePostgresFixture) taskScope(ctx context.Context) context.Context {
	return agentauth.WithTarget(ctx, "task", fixture.currentTaskID)
}

// roomScope is the Room Context a Meta CLI sends from its configuration.
func (fixture *sendMessagePostgresFixture) roomScope(ctx context.Context) context.Context {
	return agentauth.WithTarget(ctx, "room", fixture.mainRoomID)
}

func (fixture *sendMessagePostgresFixture) scopeForCredential(ctx context.Context, token string) context.Context {
	if token == fixture.alterContext.token {
		return fixture.taskScope(ctx)
	}
	return fixture.roomScope(ctx)
}

func (fixture *sendMessagePostgresFixture) newInput(
	label string,
	inboxID string,
	segments []PreparedSegment,
) Input {
	return Input{
		InvocationID: sendMessageInvocationID(label, fixture.suffix),
		InboxID:      inboxID,
		Atomic:       &AtomicInput{Segments: segments, Uploads: []PreparedUpload{}},
	}
}

func (fixture *sendMessagePostgresFixture) assertRoomMessageShape(t *testing.T, ctx context.Context) {
	t.Helper()
	result, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, fixture.coreInput)
	if err != nil {
		t.Fatalf("send structured Room message: %v", err)
	}
	fixture.coreResult = result
	if !result.Accepted || result.Replay || result.InboxID != fixture.coreInput.InboxID || result.MessageID == "" {
		t.Fatalf("fresh Room result=%+v", result)
	}
	var body, author string
	var segments []byte
	if err := fixture.pool.QueryRow(ctx, `
		SELECT body,segments,author_actor_id FROM messages WHERE id=$1
	`, result.MessageID).Scan(&body, &segments, &author); err != nil {
		t.Fatalf("read structured Message: %v", err)
	}
	var storedSegments []messagecreation.Segment
	if err := json.Unmarshal(segments, &storedSegments); err != nil {
		t.Fatalf("decode stored Message segments: %v", err)
	}
	if body != "Hello @Reference report" || author != fixture.agentActorID ||
		!slices.Equal(storedSegments, []messagecreation.Segment{
			{Type: "text", Content: "Hello "},
			{Type: "reference", Content: "@Reference", Target: fixture.ownerActorID, TargetType: "user"},
			{Type: "document", Content: " report", DocumentID: fixture.publishedDocumentID},
		}) {
		t.Fatalf("Message body=%q author=%q segments=%+v", body, author, storedSegments)
	}
	var mentionCount, attachmentCount int64
	if err := fixture.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM messages WHERE id=$1 AND $2::text=ANY(mentioned_actor_ids)),
		       (SELECT jsonb_array_length(attachments)::bigint FROM messages WHERE id=$1)
	`, result.MessageID, fixture.ownerActorID).Scan(&mentionCount, &attachmentCount); err != nil {
		t.Fatalf("read structured Message relations: %v", err)
	}
	if mentionCount != 1 || attachmentCount != 0 {
		t.Fatalf("mention count=%d attachment rows=%d", mentionCount, attachmentCount)
	}
	var invocationID string
	if err := fixture.pool.QueryRow(ctx, `
		SELECT invocation_id
		FROM command_replays
		WHERE scope='agent:'||$1
		  AND operation='send_message'
		  AND resource_id=$2
	`, fixture.agentActorID, result.MessageID).Scan(&invocationID); err != nil {
		t.Fatalf("read send_message Runtime receipt: %v", err)
	}
	if invocationID != fixture.coreInput.InvocationID {
		t.Fatalf("send_message Runtime receipt invocation=%q, want %q", invocationID, fixture.coreInput.InvocationID)
	}

	invalidDocuments := fixture.newInput(
		"mixed-documents",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{
			{Type: "document", Content: "main", DocumentID: fixture.publishedDocumentID},
			{Type: "document", Content: "foreign", DocumentID: fixture.foreignFileDocumentID},
		},
	)
	before := fixture.factSnapshot(t, ctx)
	if _, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, invalidDocuments); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mixed Room Document authority error=%v want ErrInvalid", err)
	}
	if after := fixture.factSnapshot(t, ctx); after != before {
		t.Fatalf("invalid Documents changed facts: before=%+v after=%+v", before, after)
	}
}

func (fixture *sendMessagePostgresFixture) assertDocumentReferenceAdmission(t *testing.T, ctx context.Context) {
	t.Helper()
	// A meta Context reaches a Task Inbox only as that Task's registered
	// coordinator, so an alterEgo carries the Task cases: this asserts Document
	// reference admission, not Task authority.
	tests := []struct {
		name       string
		label      string
		inboxID    string
		documentID string
		token      string
	}{
		{name: "Room Binding", label: "room-document", inboxID: "room:" + fixture.mainRoomID, documentID: fixture.roomDocumentID, token: fixture.metaContext.token},
		{name: "Task Binding", label: "task-document", inboxID: "task:" + fixture.visibleTaskID, documentID: fixture.taskDocumentID, token: fixture.alterContext.token},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := fixture.newInput(test.label, test.inboxID, []PreparedSegment{{
				Type: "document", Content: "@Plan", DocumentID: test.documentID,
			}})
			result, err := fixture.service.Send(fixture.scopeForCredential(ctx, test.token), test.token, input)
			if err != nil {
				t.Fatalf("send bound Document reference: %v", err)
			}
			var segments []byte
			if err := fixture.pool.QueryRow(ctx, `SELECT segments FROM messages WHERE id=$1`, result.MessageID).Scan(&segments); err != nil {
				t.Fatalf("read Document reference Message: %v", err)
			}
			var stored []messagecreation.Segment
			if err := json.Unmarshal(segments, &stored); err != nil {
				t.Fatalf("decode Document reference Message: %v", err)
			}
			if !slices.Equal(stored, []messagecreation.Segment{{Type: "document", Content: "@Plan", DocumentID: test.documentID}}) {
				t.Fatalf("stored Document segments=%+v want exact document_id=%q and no Document Version", stored, test.documentID)
			}
		})
	}

	cardResult, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, fixture.newInput(
		"native-document-card", "room:"+fixture.mainRoomID, []PreparedSegment{{
			Type: "document", Content: "notes.md", DocumentID: fixture.roomDocumentID, Presentation: "card",
		}},
	))
	if err != nil {
		t.Fatalf("send native Document card: %v", err)
	}
	var cardSegments []byte
	if err := fixture.pool.QueryRow(ctx, `SELECT segments FROM messages WHERE id=$1`, cardResult.MessageID).Scan(&cardSegments); err != nil {
		t.Fatalf("read native Document card Message: %v", err)
	}
	var storedCard []messagecreation.Segment
	if err := json.Unmarshal(cardSegments, &storedCard); err != nil {
		t.Fatalf("decode native Document card Message: %v", err)
	}
	if !slices.Equal(storedCard, []messagecreation.Segment{{
		Type: "document", Content: "notes.md", DocumentID: fixture.roomDocumentID, Presentation: "card",
	}}) {
		t.Fatalf("native Document card changed during admission: %+v", storedCard)
	}

	taskResult, err := fixture.service.Send(fixture.taskScope(ctx), fixture.alterContext.token, fixture.newInput(
		"task-document-label", "task:"+fixture.visibleTaskID, []PreparedSegment{{
			Type: "document", Content: "Task Plan", DocumentID: fixture.taskDocumentID,
		}},
	))
	if err != nil {
		t.Fatalf("send Task Document reference without Room Version: %v", err)
	}
	var taskSegments []byte
	if err := fixture.pool.QueryRow(ctx, `SELECT segments FROM messages WHERE id=$1`, taskResult.MessageID).Scan(&taskSegments); err != nil {
		t.Fatalf("read Task Document reference Message: %v", err)
	}
	var taskStored []messagecreation.Segment
	if err := json.Unmarshal(taskSegments, &taskStored); err != nil {
		t.Fatalf("decode Task Document reference Message: %v", err)
	}
	if !slices.Equal(taskStored, []messagecreation.Segment{{
		Type: "document", Content: "Task Plan", DocumentID: fixture.taskDocumentID,
	}}) {
		t.Fatalf("Task Document reference changed without a matching Room Version: %+v", taskStored)
	}

	failures := []struct {
		name       string
		label      string
		inboxID    string
		documentID string
		token      string
	}{
		{name: "Room Document in Task", label: "foreign-room-document", inboxID: "task:" + fixture.visibleTaskID, documentID: fixture.roomDocumentID, token: fixture.alterContext.token},
		{name: "Task Document in Room", label: "foreign-task-document", inboxID: "room:" + fixture.mainRoomID, documentID: fixture.taskDocumentID, token: fixture.metaContext.token},
	}
	for _, failure := range failures {
		t.Run(failure.name, func(t *testing.T) {
			before := fixture.factSnapshot(t, ctx)
			input := fixture.newInput(failure.label, failure.inboxID, []PreparedSegment{{
				Type: "document", Content: "@Foreign", DocumentID: failure.documentID,
			}})
			if _, err := fixture.service.Send(fixture.scopeForCredential(ctx, failure.token), failure.token, input); !errors.Is(err, ErrInvalid) {
				t.Fatalf("foreign Context Document error=%v want ErrInvalid", err)
			}
			if after := fixture.factSnapshot(t, ctx); after != before {
				t.Fatalf("denied Document reference changed facts: before=%+v after=%+v", before, after)
			}
		})
	}
}

func (fixture *sendMessagePostgresFixture) assertReplayConflictAndCredentialRotation(t *testing.T, ctx context.Context) {
	t.Helper()
	latestVersionID := "version_sm_published_v2_" + fixture.suffix
	fixture.createNextDocumentVersion(
		t,
		ctx,
		fixture.publishedDocumentID,
		latestVersionID,
		2,
		"main-v2",
	)
	replay, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, fixture.coreInput)
	if err != nil {
		t.Fatalf("replay Room message: %v", err)
	}
	if !replay.Replay {
		t.Fatalf("replay result=%+v", replay)
	}
	assertSameSendMessageResult(t, replay, fixture.coreResult)
	written := fixture.factSnapshot(t, ctx)

	conflict := fixture.coreInput
	conflict.Atomic = &AtomicInput{Segments: []PreparedSegment{{Type: "text", Content: "different"}}, Uploads: []PreparedUpload{}}
	if _, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, conflict); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting invocation error=%v want ErrIdempotencyConflict", err)
	}
	if after := fixture.factSnapshot(t, ctx); after != written {
		t.Fatalf("conflict changed facts: before=%+v after=%+v", written, after)
	}
	conflict.InboxID = "task:" + fixture.deletedCommentTaskID
	if _, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, conflict); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting hidden Inbox error=%v want ErrIdempotencyConflict", err)
	}

	if _, err := fixture.pool.Exec(ctx, `
		UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1
	`, fixture.metaContext.credentialID); err != nil {
		t.Fatalf("expire old Agent credential: %v", err)
	}
	newContext := fixture.issueCredential(t, ctx)
	rotationReplay, err := fixture.service.Send(fixture.roomScope(ctx), newContext.token, fixture.coreInput)
	if err != nil || !rotationReplay.Replay {
		t.Fatalf("credential rotation must retain operation receipt: result=%+v err=%v", rotationReplay, err)
	}
	assertSameSendMessageResult(t, rotationReplay, fixture.coreResult)
	if after := fixture.factSnapshot(t, ctx); after != written {
		t.Fatalf("credential rotation replay changed facts: before=%+v after=%+v", written, after)
	}
	newContextInput := fixture.coreInput
	newContextInput.InvocationID = sendMessageInvocationID("core-new-context", fixture.suffix)
	created, err := fixture.service.Send(fixture.roomScope(ctx), newContext.token, newContextInput)
	if err != nil {
		t.Fatalf("same request with a new invocation in a new Context: %v", err)
	}
	if created.Replay || created.MessageID == fixture.coreResult.MessageID {
		t.Fatalf("new Context result=%+v", created)
	}
	// A Document reference stays a live reference; the receipt names the
	// Version current when the new invocation committed.
	if len(created.Resources) != 1 || created.Resources[0].SegmentIndex != 2 ||
		created.Resources[0].DocumentID != fixture.publishedDocumentID || created.Resources[0].VersionID != latestVersionID {
		t.Fatalf("new-Context receipt did not name current Version %q: %+v", latestVersionID, created.Resources)
	}
	fixture.metaContext = newContext
}

func (fixture *sendMessagePostgresFixture) assertAlterEgoTaskTarget(t *testing.T, ctx context.Context) {
	t.Helper()
	if fixture.currentTaskID == fixture.visibleTaskID {
		t.Fatal("alterEgo authority Task accidentally equals target Task")
	}
	input := fixture.newInput(
		"alter-other-task",
		"task:"+fixture.visibleTaskID,
		[]PreparedSegment{{Type: "text", Content: "cross-task visible message"}},
	)
	result, err := fixture.service.Send(fixture.taskScope(ctx), fixture.alterContext.token, input)
	if err != nil {
		t.Fatalf("send alterEgo message to different visible Task: %v", err)
	}
	fixture.taskResult = result
	if result.Replay || result.InboxID != input.InboxID || result.MessageID == "" {
		t.Fatalf("alterEgo Task result=%+v", result)
	}
	var roomID, author string
	if err := fixture.pool.QueryRow(ctx, `SELECT room_id,author_actor_id FROM messages WHERE id=$1`, result.MessageID).Scan(&roomID, &author); err != nil {
		t.Fatalf("read alterEgo Task Message: %v", err)
	}
	if roomID != fixture.visibleTaskRoomID || author != fixture.agentActorID {
		t.Fatalf("alterEgo Message room=%q author=%q", roomID, author)
	}
}

func (fixture *sendMessagePostgresFixture) assertTaskVisibility(t *testing.T, ctx context.Context) {
	t.Helper()
	tests := []struct {
		name   string
		taskID string
	}{
		{name: "deleted comment reference", taskID: fixture.deletedCommentTaskID},
		{name: "resolved", taskID: fixture.resolvedTaskID},
		{name: "archived", taskID: fixture.archivedTaskID},
		{name: "deleting Room", taskID: fixture.deletingRoomTaskID},
		{name: "Agent is not a Room member", taskID: fixture.noMembershipTaskID},
		{name: "Work Item is an Issue", taskID: fixture.issueID},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := fixture.factSnapshot(t, ctx)
			input := fixture.newInput(
				"reject-"+test.name,
				"task:"+test.taskID,
				[]PreparedSegment{{Type: "text", Content: "must not persist"}},
			)
			_, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, input)
			if !errors.Is(err, ErrInboxUnavailable) {
				t.Fatalf("Task %s error=%v want ErrInboxUnavailable", test.taskID, err)
			}
			if after := fixture.factSnapshot(t, ctx); after != before {
				t.Fatalf("rejected Task changed facts: before=%+v after=%+v", before, after)
			}
		})
	}
}

func (fixture *sendMessagePostgresFixture) assertConcurrentFirstInvocation(t *testing.T, ctx context.Context) {
	t.Helper()
	input := fixture.newInput(
		"concurrent",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{{Type: "text", Content: "one concurrent message"}},
	)
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
			results[index], errorsByCaller[index] = fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, input)
		}()
	}
	close(start)
	wait.Wait()
	first := -1
	for index, err := range errorsByCaller {
		if err != nil {
			t.Fatalf("concurrent caller %d error: %v", index, err)
		}
		if !results[index].Replay {
			if first != -1 {
				t.Fatalf("multiple first writes: %d and %d", first, index)
			}
			first = index
		}
	}
	if first == -1 {
		t.Fatal("concurrent invocation has no first writer")
	}
	for _, result := range results {
		assertSameSendMessageResult(t, result, results[first])
	}
}

func (fixture *sendMessagePostgresFixture) assertAtomicRollback(t *testing.T, ctx context.Context) {
	t.Helper()
	seed := fixture.newInput(
		"atomic-seed",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{{Type: "text", Content: "seed"}},
	)
	seeded, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, seed)
	if err != nil {
		t.Fatalf("send seed invocation: %v", err)
	}
	input := fixture.newInput(
		"atomic",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{{Type: "text", Content: "must roll back"}},
	)
	// A receipt under another key already holds this invocation, so the call
	// writes its Message and Event before its own receipt collides.
	if _, err := fixture.pool.Exec(ctx, `
		INSERT INTO command_replays(scope,operation,key,state,request_hash,resource_id,response_status,response_body,invocation_id)
		SELECT scope,operation,'held-'||key,'completed',request_hash,resource_id,response_status,response_body,$3
		FROM command_replays WHERE scope='agent:'||$1 AND resource_id=$2
	`, fixture.agentActorID, seeded.MessageID, input.InvocationID); err != nil {
		t.Fatalf("hold the invocation under another key: %v", err)
	}
	before := fixture.factSnapshot(t, ctx)
	if _, err := fixture.service.Send(fixture.roomScope(ctx), fixture.metaContext.token, input); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("reused invocation error=%v want ErrIdempotencyConflict", err)
	}
	if after := fixture.factSnapshot(t, ctx); after != before {
		t.Fatalf("late failure changed facts: before=%+v after=%+v", before, after)
	}
}

func (fixture *sendMessagePostgresFixture) assertReplayRechecksTarget(t *testing.T, ctx context.Context) {
	t.Helper()
	if fixture.taskResult.MessageID == "" {
		t.Fatal("Task replay fixture was not created")
	}
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE work_items SET archived_at=clock_timestamp(),updated_at=clock_timestamp()
		WHERE id=$1 AND tenant_id=$2
	`, fixture.visibleTaskID, fixture.tenantID); err != nil {
		t.Fatalf("archive replay target Task: %v", err)
	}
	input := fixture.newInput(
		"alter-other-task",
		"task:"+fixture.visibleTaskID,
		[]PreparedSegment{{Type: "text", Content: "cross-task visible message"}},
	)
	if _, err := fixture.service.Send(fixture.taskScope(ctx), fixture.alterContext.token, input); !errors.Is(err, ErrInboxUnavailable) {
		t.Fatalf("archived Task replay error=%v want ErrInboxUnavailable", err)
	}
}

func (fixture *sendMessagePostgresFixture) assertRoomReplayRechecksMembership(t *testing.T, ctx context.Context) {
	t.Helper()
	roomID := "room_sm_replay_auth_" + fixture.suffix
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin Room replay authority fixture: %v", err)
	}
	fixture.createRoom(t, ctx, tx, roomID, true)
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit Room replay authority fixture: %v", err)
	}
	input := fixture.newInput(
		"room-replay-authority",
		"room:"+roomID,
		[]PreparedSegment{{Type: "text", Content: "authority replay"}},
	)
	replayRoomScope := agentauth.WithTarget(ctx, "room", roomID)
	created, err := fixture.service.Send(replayRoomScope, fixture.metaContext.token, input)
	if err != nil || created.Replay {
		t.Fatalf("create Room authority replay fixture: result=%+v error=%v", created, err)
	}
	if _, err := fixture.pool.Exec(ctx, `
		DELETE FROM room_members WHERE room_id=$1 AND actor_id=$2
	`, roomID, fixture.agentActorID); err != nil {
		t.Fatalf("revoke Agent Room membership: %v", err)
	}
	before := fixture.factSnapshot(t, ctx)
	// The revoked membership no longer admits the Room Context itself.
	if _, err := fixture.service.Send(replayRoomScope, fixture.metaContext.token, input); !errors.Is(err, agentauth.ErrForbidden) {
		t.Fatalf("Room replay after membership revocation error=%v want ErrToolForbidden", err)
	}
	if after := fixture.factSnapshot(t, ctx); after != before {
		t.Fatalf("denied Room replay changed facts: before=%+v after=%+v", before, after)
	}
}

// A Room or Thread write without the caller's Room Context, or with another
// Room's Context, is forbidden even when the Agent is a member of the target.
func (fixture *sendMessagePostgresFixture) assertRoomContextRequired(t *testing.T, ctx context.Context) {
	t.Helper()
	otherRoomID := "room_sm_other_context_" + fixture.suffix
	tx, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin other Room Context fixture: %v", err)
	}
	fixture.createRoom(t, ctx, tx, otherRoomID, true)
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit other Room Context fixture: %v", err)
	}
	tests := []struct {
		name    string
		scope   context.Context
		inboxID string
	}{
		{name: "Room without Room Context", scope: ctx, inboxID: "room:" + fixture.mainRoomID},
		{name: "Thread without Room Context", scope: ctx, inboxID: "thread:" + fixture.threadRoomID},
		{name: "Room from another Room Context", scope: agentauth.WithTarget(ctx, "room", otherRoomID), inboxID: "room:" + fixture.mainRoomID},
		{name: "Thread from another Room Context", scope: agentauth.WithTarget(ctx, "room", otherRoomID), inboxID: "thread:" + fixture.threadRoomID},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := fixture.factSnapshot(t, ctx)
			input := fixture.newInput(
				fmt.Sprintf("room-context-required-%d", index), test.inboxID,
				[]PreparedSegment{{Type: "text", Content: "must not persist"}},
			)
			if _, err := fixture.service.Send(test.scope, fixture.metaContext.token, input); !errors.Is(err, ErrForbidden) {
				t.Fatalf("Room write error=%v want ErrForbidden", err)
			}
			if after := fixture.factSnapshot(t, ctx); after != before {
				t.Fatalf("forbidden Room write changed facts: before=%+v after=%+v", before, after)
			}
		})
	}
	input := fixture.newInput(
		"room-context-own-room", "room:"+otherRoomID,
		[]PreparedSegment{{Type: "text", Content: "own Room Context"}},
	)
	if result, err := fixture.service.Send(agentauth.WithTarget(ctx, "room", otherRoomID), fixture.metaContext.token, input); err != nil || !result.Accepted {
		t.Fatalf("own Room Context write result=%+v error=%v", result, err)
	}
}

func (fixture *sendMessagePostgresFixture) assertCredentialLifecycle(t *testing.T, ctx context.Context) {
	t.Helper()
	before := fixture.factSnapshot(t, ctx)
	revoked := fixture.metaContext
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE agent_access_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1
	`, revoked.credentialID); err != nil {
		t.Fatalf("expire Agent credential: %v", err)
	}
	input := fixture.newInput(
		"revoked",
		"room:"+fixture.mainRoomID,
		[]PreparedSegment{{Type: "text", Content: "must not persist"}},
	)
	if _, err := fixture.service.Send(ctx, revoked.token, input); !errors.Is(err, agentauth.ErrCredentialInvalid) {
		t.Fatalf("revoked credential error=%v want ErrContextInvalid", err)
	}

	inactive := fixture.issueCredential(t, ctx)
	if _, err := fixture.pool.Exec(ctx, `
		UPDATE agent_registrations
		SET status='deleting',updated_at=clock_timestamp()
		WHERE actor_id=$1 AND tenant_id=$2
	`, fixture.agentActorID, fixture.tenantID); err != nil {
		t.Fatalf("deactivate Agent registration: %v", err)
	}
	input.InvocationID = sendMessageInvocationID("inactive", fixture.suffix)
	if _, err := fixture.service.Send(ctx, inactive.token, input); !errors.Is(err, agentauth.ErrCredentialInvalid) {
		t.Fatalf("inactive Agent error=%v want ErrContextInvalid", err)
	}
	if after := fixture.factSnapshot(t, ctx); after != before {
		t.Fatalf("Credential lifecycle failures changed facts: before=%+v after=%+v", before, after)
	}
}

func (fixture *sendMessagePostgresFixture) factSnapshot(t *testing.T, ctx context.Context) sendMessageFactSnapshot {
	t.Helper()
	var result sendMessageFactSnapshot
	if err := fixture.pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM messages WHERE tenant_id=$1 AND author_actor_id=$2),
			(SELECT count(*) FROM room_events WHERE tenant_id=$1 AND actor_id=$2 AND event_type='message.created'),
			(SELECT coalesce(sum(cardinality(mentioned_actor_ids)),0)::bigint FROM messages WHERE tenant_id=$1),
			(SELECT coalesce(sum(jsonb_array_length(attachments)),0)::bigint FROM messages WHERE tenant_id=$1),
			(SELECT count(*) FROM command_replays WHERE scope='agent:'||$2 AND operation=$3),
			(SELECT count(*) FROM agent_local_runs run JOIN agent_execution_contexts execution ON execution.context_key=run.context_key WHERE execution.tenant_id=$1 AND execution.agent_actor_id=$2)
	`, fixture.tenantID, fixture.agentActorID, idempotencyOperation).Scan(
		&result.messages,
		&result.roomEvents,
		&result.mentions,
		&result.attachments,
		&result.idempotencyKeys,
		&result.localRuns,
	); err != nil {
		t.Fatalf("read send_message fact snapshot: %v", err)
	}
	return result
}

func sendMessageInvocationID(label, suffix string) string {
	digest := sha256.Sum256([]byte("MCP send_message invocation:" + label + ":" + suffix))
	return fmt.Sprintf("agent-invocation-sha256:%x", digest[:])
}

func assertSameSendMessageResult(t *testing.T, got, want Result) {
	t.Helper()
	if got.Accepted != want.Accepted || got.InboxID != want.InboxID || got.MessageID != want.MessageID {
		t.Fatalf("result=%+v want persisted fields from %+v", got, want)
	}
}
