package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// agentTaskAuthorityCase gives the fixture Agent exactly one relation to its
// own Task. The Agent writes the Task's Document whatever the relation, as it
// writes every Document its Human does. CLI Task targets are checked separately.
// Task-target Document creation is retired; Meta publishes into its Room.
type agentTaskAuthorityCase struct {
	relation  string
	cliTarget bool
}

// TestAgentTaskAuthorityStaysPerPath locks the Task rules an Agent meets after
// its document writes became credential-only. CLI Task targets and Document
// publication are checked independently; Document access follows
// none, since the Agent writes every Document its Human does.
func TestAgentTaskAuthorityStaysPerPath(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	cases := []agentTaskAuthorityCase{
		{relation: "creator", cliTarget: true},
		{relation: "assignee", cliTarget: true},
		{relation: "grant", cliTarget: true},
		{relation: "participant", cliTarget: true},
		{relation: "earlier_participant"},
		{relation: "description_reference"},
		{relation: "comment_reference"},
		{relation: "resolved_assignee", cliTarget: true},
		{relation: "unrelated"},
	}
	db, pool := newUnifiedDocumentFixture(t, agentTaskAuthorityFixtureSQL(cases))
	issued, err := agentcredential.New(pool).IssueManaged(ctx, "agent_document_a", "task authority")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := agentcredential.Authenticate(ctx, pool, issued.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	contexts := agentauth.New(pool)
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: func(
		context.Context, document.ImportRequest,
	) (document.ImportedState, error) {
		state := []byte{7, 8, 9}
		return document.ImportedState{
			StateBytes: state, StateBytesSHA256: semanticDigest(state), StateVector: []byte{1},
			FullStateFingerprint: semanticDigest(state), StateHashVersion: 1,
			CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{},
		}, nil
	}}, nil)
	for _, c := range cases {
		taskID := "task_authority_" + c.relation
		documentID := "document_" + taskID
		t.Run(c.relation, func(t *testing.T) {
			authority, err := contexts.Authorize(agentauth.WithTarget(ctx, "task", taskID), issued.AccessToken, "apply_document_semantic_mutation")
			if c.cliTarget != (err == nil) || (err != nil && !errors.Is(err, agentauth.ErrForbidden)) {
				t.Fatalf("CLI Task target: %v", err)
			}
			if err == nil && (authority.Target.ID != taskID || authority.RoomID != "room_"+taskID ||
				(authority.ParticipantTaskID == taskID) != (c.relation == "participant")) {
				t.Fatalf("CLI Task target authority=%+v", authority)
			}
			if got := agentTaskDocumentAccess(t, ctx, db, documentID); got != "write" {
				t.Fatalf("Agent document access=%s", got)
			}
			if !agentTaskConnectionWrite(t, ctx, pool, taskID, documentID) {
				t.Fatal("recomputing Task access closed the Agent's write connection")
			}
			if c.relation == "participant" {
				_, denied := contexts.Authorize(agentauth.WithTarget(ctx, "task", taskID), issued.AccessToken, "create_document")
				if !errors.Is(denied, agentauth.ErrTaskContextForbidden) {
					t.Fatalf("Task participant publication: %v", denied)
				}
			}
			_, err = service.CreateAgentDocument(ctx, document.CreateAgentDocumentInput{
				Principal: &principal, TargetKind: "task", TargetID: taskID,
				SourceInvocationID: "task-authority-" + c.relation, Title: "Task authority", Markdown: "body",
			})
			// ADR 0162 rejects every Task target. Positive Room publication is
			// covered by TestUnifiedDocumentAgentRoomCreateBindsTheRoomAsManager
			// and TestAgentCLIDocumentsUseBusinessAuthorityWithoutRun.
			if !errors.Is(err, document.ErrNotFound) {
				t.Fatalf("document creation: %v", err)
			}
		})
	}
}

// agentTaskAuthorityFixtureSQL seeds one managed Task per case, each with its
// own Work Room the Agent belongs to and one bound editor Document. Another
// Agent is every Task's result participant, so only the case relation differs.
func agentTaskAuthorityFixtureSQL(cases []agentTaskAuthorityCase) string {
	var fixture strings.Builder
	fixture.WriteString(`
INSERT INTO actors(id,tenant_id,kind,display_name,handle)
 VALUES('actor_task_result','tenant_document_a','agent','Result Agent','task-result');
`)
	for index, c := range cases {
		taskID := "task_authority_" + c.relation
		creator, state, resolution, generation := "actor_human_a", "in_progress", "NULL", 1
		switch c.relation {
		case "creator":
			creator = "actor_agent_a"
		case "earlier_participant":
			generation = 2
		case "resolved_assignee":
			state, resolution = "resolved", "'failed'"
		}
		execution := fmt.Sprintf("%d,'idle',1,'run',0,0,now(),now(),0", generation)
		if c.relation == "resolved_assignee" {
			// Resolved Tasks retain generation history but have no live projection.
			execution = "NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL"
		}
		fmt.Fprintf(&fixture, `
INSERT INTO work_items(id,tenant_id,number,kind,title,state,resolution,created_by_actor_id,updated_by_actor_id,
 task_execution_generation,task_execution_status,task_execution_revision,task_desired_control,task_control_revision,
 task_control_settled_revision,task_execution_updated_at,task_next_reconcile_at,task_lease_generation)
 VALUES('%[1]s','tenant_document_a',%[2]d,'task','Task authority','%[3]s',%[4]s,'%[5]s','%[5]s',%[6]s);
INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id) VALUES('%[1]s','tenant_document_a','actor_task_result');
INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES('room_%[1]s','tenant_document_a','Task work','actor_human_a'),
 ('origin_%[1]s','tenant_document_a','Task origin','actor_human_a');
INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
 ('origin_%[1]s','tenant_document_a','actor_human_a','owner','actor_human_a'),
 ('origin_%[1]s','tenant_document_a','actor_agent_a','member','actor_human_a'),
 ('room_%[1]s','tenant_document_a','actor_human_a','owner','actor_human_a'),
 ('room_%[1]s','tenant_document_a','actor_agent_a','member','actor_human_a');
INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
 VALUES('%[1]s','tenant_document_a','work','room_%[1]s','actor_human_a'),
 ('%[1]s','tenant_document_a','origin','origin_%[1]s','actor_human_a');
INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
 VALUES('document_%[1]s','tenant_document_a','Task document','blocknote','actor_human_a','human','actor_human_a','human','active');
INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,work_item_id,role,status)
 VALUES('binding_%[1]s','tenant_document_a','document_%[1]s','task','%[1]s','editor','active');
`, taskID, 301+index, state, resolution, creator, execution)
		for current := 1; current <= generation; current++ {
			fmt.Fprintf(&fixture, `
INSERT INTO task_execution_generations(task_id,tenant_id,generation,result_agent_actor_id,spec,spec_hash)
 VALUES('%[1]s','tenant_document_a',%[2]d,'actor_task_result','{}',decode(repeat('00',32),'hex'));
INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref)
 VALUES('%[1]s','tenant_document_a',%[2]d,'actor_task_result','agent_task_result','{}');
`, taskID, current)
		}
		switch c.relation {
		case "assignee", "resolved_assignee":
			fmt.Fprintf(&fixture, `INSERT INTO work_item_assignments(work_item_id,tenant_id,actor_id,assigned_by_actor_id)
 VALUES('%s','tenant_document_a','actor_agent_a','actor_human_a');`, taskID)
		case "grant":
			fmt.Fprintf(&fixture, `INSERT INTO work_item_access_grants(work_item_id,tenant_id,actor_id,granted_by_actor_id)
 VALUES('%s','tenant_document_a','actor_agent_a','actor_human_a');`, taskID)
		case "participant", "earlier_participant":
			// The first generation names the Agent; only the current one authorizes.
			fmt.Fprintf(&fixture, `INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref)
 VALUES('%[1]s','tenant_document_a',1,'actor_agent_a','agent_document_a','{}');
INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id) VALUES('%[1]s','tenant_document_a','actor_agent_a');`, taskID)
		case "description_reference":
			fmt.Fprintf(&fixture, `INSERT INTO work_item_description_references(work_item_id,tenant_id,actor_id,ordinal)
 VALUES('%s','tenant_document_a','actor_agent_a',0);`, taskID)
		case "comment_reference":
			fmt.Fprintf(&fixture, `INSERT INTO work_item_comments(id,work_item_id,tenant_id,author_actor_id,body,segments)
 VALUES('comment_%[1]s','%[1]s','tenant_document_a','actor_human_a','@Agent A','[]');
INSERT INTO work_item_comment_references(comment_id,work_item_id,tenant_id,actor_id)
 VALUES('comment_%[1]s','%[1]s','tenant_document_a','actor_agent_a');`, taskID)
		}
	}
	return fixture.String()
}

func agentTaskDocumentAccess(t *testing.T, ctx context.Context, db *sql.DB, documentID string) string {
	t.Helper()
	var read, write bool
	err := db.QueryRowContext(ctx, `SELECT can_read,can_write
		FROM resolve_agent_document_access_v2('agent_document_a',$1)`, documentID).Scan(&read, &write)
	if errors.Is(err, sql.ErrNoRows) {
		return "none"
	}
	if err != nil {
		t.Fatal(err)
	}
	return agentTaskAccessLevel(read, write)
}

// agentTaskConnectionWrite recomputes the Agent's access to the Task's
// Documents without committing it and reports whether it can still write: an
// Actor that cannot gets a disconnect of its connections.
func agentTaskConnectionWrite(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID, documentID string) bool {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := document.RecomputeTaskActorAccess(ctx, tx, "tenant_document_a", taskID, "actor_agent_a", "actor_human_a"); err != nil {
		t.Fatal(err)
	}
	var disconnected bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM river_job
		WHERE kind='document.runtime_disconnect' AND args->>'document_id'=$1
		  AND args->>'actor_id'='actor_agent_a')`,
		documentID).Scan(&disconnected); err != nil {
		t.Fatal(err)
	}
	return !disconnected
}

func agentTaskAccessLevel(read, write bool) string {
	switch {
	case read && write:
		return "write"
	case read:
		return "read"
	}
	return "none"
}
