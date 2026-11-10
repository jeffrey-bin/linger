package integration_test

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// The Space's Human reads every active Document, whoever owns it and however
// it is bound; Get, the Library, search, the folder preview check and the SQL
// resolver agree. A Wiki page stays read-only, and the trash ends access.
func TestHumanReadsEveryActiveDocumentOfTheSpace(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	service := document.New(env.pool)
	wikiID := "wiki_read_rule_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES($1,$2,'actor_acme_alice')`, wikiID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, ownerID, ownerKind string
		wikiPage, writable       bool
	}{
		{name: "human", ownerID: "actor_acme_alice", ownerKind: "human", writable: true},
		{name: "agent", ownerID: "actor_acme_official", ownerKind: "agent", writable: true},
		{name: "wiki_page", ownerID: "actor_acme_official", ownerKind: "agent", wikiPage: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			documentID := "document_read_rule_" + testCase.name + "_" + suffix
			if _, err := env.pool.Exec(ctx, `INSERT INTO documents(
				id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
			) VALUES($1,$2,$3,'txt',$4,$5,$4,$5,'active')`,
				documentID, acmeTenant, "Read rule "+testCase.name+" "+suffix,
				testCase.ownerID, testCase.ownerKind); err != nil {
				t.Fatal(err)
			}
			if testCase.wikiPage {
				if _, err := env.pool.Exec(ctx, `INSERT INTO document_context_bindings(
					id,tenant_id,document_id,binding_kind,wiki_id,status,role
				) VALUES($1,$2,$3,'wiki_page',$4,'active','viewer')`,
					"binding_read_rule_"+suffix, acmeTenant, documentID, wikiID); err != nil {
					t.Fatal(err)
				}
			}
			assertHumanDocumentReader(t, env, service, documentID, true, testCase.writable)
			if _, err := env.pool.Exec(ctx, `UPDATE documents SET status='trashed',
				trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp())
				WHERE id=$1`, documentID); err != nil {
				t.Fatal(err)
			}
			assertHumanDocumentReader(t, env, service, documentID, false, false)
		})
	}
}

func assertHumanDocumentReader(
	t *testing.T, env *testEnv, service *document.Service, documentID string, readable, writable bool,
) {
	t.Helper()
	ctx := context.Background()
	value, getErr := service.Get(ctx, "account_alice", documentID)
	if readable != (getErr == nil) || (getErr != nil && !errors.Is(getErr, document.ErrNotFound)) {
		t.Fatalf("Get readable=%t error=%v", readable, getErr)
	}
	if getErr == nil && value.Capabilities.Write != writable {
		t.Fatalf("Get write=%t want %t", value.Capabilities.Write, writable)
	}
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	preview, err := document.CanReadInTx(ctx, tx, "account_alice", documentID)
	if err != nil || preview != readable {
		t.Fatalf("CanReadInTx=%t error=%v want %t", preview, err, readable)
	}
	var title string
	if err := tx.QueryRow(ctx, `SELECT title FROM documents WHERE id=$1`, documentID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	hits, err := service.Search(ctx, document.SearchInput{AccountID: "account_alice", Query: title, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if searched := slices.ContainsFunc(hits.Items, func(item document.Document) bool {
		return item.ID == documentID
	}); searched != readable {
		t.Fatalf("search contains=%t want %t", searched, readable)
	}
	var resolverRead, resolverWrite bool
	if err := tx.QueryRow(ctx, `SELECT coalesce(bool_or(can_read),false),coalesce(bool_or(can_write),false)
		FROM resolve_human_document_access_v2('account_alice',$1)`,
		documentID).Scan(&resolverRead, &resolverWrite); err != nil {
		t.Fatal(err)
	}
	if resolverRead != readable || resolverWrite != writable {
		t.Fatalf("resolver read=%t write=%t want %t %t", resolverRead, resolverWrite, readable, writable)
	}
}
