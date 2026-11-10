package integration_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"
)

// The sweep deletes the snapshots a later History point covers, and keeps every
// Revision that something still reads.
func TestDocumentRetentionDeletesReleasedRevisionsAndKeepsReadOnes(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	agentResults := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: applyToBody(pool, func(
		document.ApplyRequest, []byte,
	) ([]byte, []byte, []string, []string, string, error) {
		agentResults++
		return []byte{4, 5, 6, byte(agentResults)}, []byte{2}, nil, nil, "Agent title", nil
	})}, objects)
	save := openDocumentRetentionSession(t, service, pool)
	agentEdit := func(invocationID string) {
		t.Helper()
		result, err := service.ApplySemanticMutation(ctx, semanticMutationInput(
			issueAgentPrincipal(t, pool, "agent_document_a"), invocationID))
		if err != nil || result.Status != document.SemanticMutationApplied {
			t.Fatalf("Agent edit %s=%+v error=%v", invocationID, result, err)
		}
	}
	// The fixture holds seq 0 and the head at seq 1. Agent edits record History
	// at seq 4 and 7; Human saves fill the rest up to the head at seq 9. A
	// Human snapshot before an Agent edit is not a History point, so that
	// edit's point covers it.
	save("retention_seq_2", 1)
	save("retention_seq_3", 2)
	agentEdit("invocation-retention-seq-4")
	save("retention_seq_5", 4)
	save("retention_seq_6", 5)
	agentEdit("invocation-retention-seq-7")
	save("retention_seq_8", 7)
	save("retention_seq_9", 8)

	revisionAt := func(seq int) string {
		t.Helper()
		var id string
		if err := pool.QueryRow(ctx, `SELECT id FROM document_revisions
			WHERE document_id='document_human_a' AND persisted_seq=$1`, seq).Scan(&id); err != nil {
			t.Fatalf("Revision at seq %d: %v", seq, err)
		}
		return id
	}
	// A latest projection reads seq 2, a pending Room creation approval froze
	// seq 0, and a decided one froze seq 1.
	if _, err := pool.Exec(ctx, `
		INSERT INTO document_latest_projections(
			tenant_id,document_id,revision_id,persisted_seq,full_state_fingerprint,representation_format,
			filename,media_type,content_object_id,size_bytes,sha256,input_schema_version
		) SELECT tenant_id,document_id,id,persisted_seq,full_state_fingerprint,'markdown',
			'retention.md','text/markdown','object_latest_retention',1,repeat('e',64),1
		FROM document_revisions WHERE id=$1;
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES
			('message_retention_pending','tenant_document_a','room_document_a','actor_agent_a','Create?','[{"type":"text","content":"Create?"}]'),
			('message_retention_decided','tenant_document_a','room_document_a','actor_agent_a','Create?','[{"type":"text","content":"Create?"}]'),
			('message_retention_decision','tenant_document_a','room_document_a','actor_human_a','No','[{"type":"text","content":"No"}]');
		INSERT INTO message_cards(message_id,tenant_id,room_id,decision_owner_actor_id,card_type,intent) VALUES
			('message_retention_pending','tenant_document_a','room_document_a','actor_human_a','personal_notice','decision_requested'),
			('message_retention_decided','tenant_document_a','room_document_a','actor_human_a','personal_notice','decision_requested');
		INSERT INTO decisions(
			id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,status,request,view,
			answer,decided_at,decided_by_actor_id,finished_at
		) VALUES
			('approval_retention_pending','tenant_document_a','room_document_a','message_retention_pending',
			 'room_creation','actor_agent_a','actor_human_a','pending',
			 jsonb_build_object('submission_id','retention-pending','fulfillment_snapshot',jsonb_build_object(
				'artifacts',jsonb_build_array(jsonb_build_object(
				'document_id','document_human_a','document_revision_id',$2::text)))),'{}',NULL,NULL,NULL,NULL),
			('approval_retention_decided','tenant_document_a','room_document_a','message_retention_decided',
			 'room_creation','actor_agent_a','actor_human_a','denied',
			 jsonb_build_object('submission_id','retention-decided','fulfillment_snapshot',jsonb_build_object(
				'artifacts',jsonb_build_array(jsonb_build_object(
				'document_id','document_human_a','document_revision_id',$3::text)))),'{}',
			 '{"decision":"deny","comment":"No"}',clock_timestamp(),'actor_human_a',clock_timestamp());
	`, pgx.QueryExecModeSimpleProtocol, revisionAt(2), revisionAt(0), revisionAt(1)); err != nil {
		t.Fatal(err)
	}
	afterLatestHistory := documentRetentionRevisionsAfterLatestHistory(t, pool)

	collector := document.NewRetentionCollector(pool)
	drainDocumentRetention(t, collector)

	if got := documentRetentionRevisionSeqs(t, pool); !slices.Equal(got, []int64{0, 2, 4, 7, 8, 9}) {
		t.Fatalf("Revisions after retention=%v want head, Agent edit History, latest projection, pending approval and uncovered Revisions", got)
	}
	if got := documentRetentionRevisionsAfterLatestHistory(t, pool); !slices.Equal(got, afterLatestHistory) {
		t.Fatalf("Revisions after the latest History changed from %v to %v", afterLatestHistory, got)
	}

	// The next History point credits the editors since the latest one, and
	// the following pass releases the snapshot it now covers.
	// The point is recorded in its own statement: a SELECT over
	// document_revisions reads its snapshot, not the function's update.
	var pointID string
	if err := pool.QueryRow(ctx, `SELECT record_document_history_point('document_human_a','idle')`).Scan(&pointID); err != nil {
		t.Fatal(err)
	}
	var contributors []string
	if err := pool.QueryRow(ctx, `SELECT history_contributor_ids FROM document_revisions WHERE id=$1`,
		pointID).Scan(&contributors); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(contributors, []string{"actor_human_a"}) {
		t.Fatalf("History contributors at seq 9=%v", contributors)
	}
	drainDocumentRetention(t, collector)
	if got := documentRetentionRevisionSeqs(t, pool); !slices.Equal(got, []int64{0, 2, 4, 7, 9}) {
		t.Fatalf("Revisions after the next History=%v", got)
	}
}

// Each foreign key into document_revisions keeps a Revision the sweep must
// not delete. A new one belongs in the sweep's reference check before
// this list.
func TestDocumentRetentionChecksEveryRevisionReference(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool := newUnifiedDocumentFixture(t, "")
	rows, err := pool.Query(t.Context(), `SELECT conrelid::regclass::text FROM pg_constraint
		WHERE contype='f' AND confrelid='document_revisions'::regclass ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	referencing, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"document_latest_projections", "document_versions",
	}
	if !slices.Equal(referencing, want) {
		t.Fatalf("foreign keys into document_revisions=%v want %v", referencing, want)
	}
}

type documentRetentionSession func(label string, basePersistedSeq int64)

// openDocumentRetentionSession returns a Human save of the fixture Document as
// the Runtime makes it. Each save is copied into a Revision, as a History point
// would copy it, so the sweep has a Revision per sequence to judge.
func openDocumentRetentionSession(
	t *testing.T, service *document.Service, pool *pgxpool.Pool,
) documentRetentionSession {
	t.Helper()
	ctx := t.Context()
	credential, err := service.IssueCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	authorID := documentfixture.ConnectionTokenClaims(t, credential.CollaborationCredential).ActorID
	return func(label string, basePersistedSeq int64) {
		t.Helper()
		seq, saved, err := saveDocumentBody(ctx, pool, documentBodySave{
			DocumentID: "document_human_a", BaseSeq: basePersistedSeq,
			State:       []byte("retention state " + label),
			StateVector: []byte{byte(basePersistedSeq + 1)},
			EditorIDs:   []string{authorID},
		})
		if err != nil || !saved || seq != basePersistedSeq+1 {
			t.Fatalf("save %s seq=%d saved=%t error=%v", label, seq, saved, err)
		}
		if _, err := pool.Exec(ctx, `SELECT snapshot_document_body('document_human_a')`); err != nil {
			t.Fatal(err)
		}
	}
}

func drainDocumentRetention(t *testing.T, collector *document.RetentionCollector) {
	t.Helper()
	for {
		worked, err := collector.RunOnce(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if !worked {
			return
		}
	}
}

func documentRetentionRevisionSeqs(t *testing.T, pool *pgxpool.Pool) []int64 {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT persisted_seq FROM document_revisions
		WHERE document_id='document_human_a' ORDER BY persisted_seq`)
	if err != nil {
		t.Fatal(err)
	}
	seqs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		t.Fatal(err)
	}
	return seqs
}

// documentRetentionRevisionsAfterLatestHistory lists the Revisions after the
// latest History point: each one's seq, author and creation time.
func documentRetentionRevisionsAfterLatestHistory(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT persisted_seq,created_by_actor_id,created_at
		FROM document_revisions
		WHERE document_id='document_human_a' AND persisted_seq>(
			SELECT max(persisted_seq) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL)
		ORDER BY persisted_seq`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var revisions []string
	for rows.Next() {
		var seq int64
		var actorID string
		var createdAt time.Time
		if err := rows.Scan(&seq, &actorID, &createdAt); err != nil {
			t.Fatal(err)
		}
		revisions = append(revisions, fmt.Sprintf("%d/%s/%s", seq, actorID, createdAt.Format(time.RFC3339Nano)))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return revisions
}
