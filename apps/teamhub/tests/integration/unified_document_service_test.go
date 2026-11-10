package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentServiceOwnerReadsLibraryAndVersions(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentFixture(t, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_service_one','tenant_document_a','document_human_a',1,'service.md','markdown',
			'text/markdown',7,repeat('7',64),'object_service_one','ordinary_upload','actor_human_a'
		);
		UPDATE documents SET current_version_id='version_service_one'
		WHERE id='document_human_a';
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a');
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status,updated_at
		) VALUES(
			'document_agent_shared','tenant_document_a','Shared Agent document','markdown',
			'actor_agent_a','agent','actor_agent_a','agent','active',
			clock_timestamp()+interval '1 minute'
		);
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status
		) VALUES(
			'binding_agent_shared','tenant_document_a','document_agent_shared','room',
			'room_document_a','active');
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_imported_mail','tenant_document_a','imported-mail-source.md',
			'markdown','actor_human_a','human','actor_human_a','human','active');
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_imported_mail','tenant_document_a','document_imported_mail',1,
			'imported-mail-source.md','markdown','text/markdown',7,repeat('9',64),
			'object_imported_mail','ordinary_upload','actor_human_a');
		UPDATE documents SET current_version_id='version_imported_mail'
		WHERE id='document_imported_mail';
		INSERT INTO wiki_source_items(
			tenant_id,owner_actor_id,source_key,content_sha256,document_id,document_version_id
		) VALUES(
			'tenant_document_a','actor_human_a','mail:fixture:message:1',repeat('9',64),
			'document_imported_mail','version_imported_mail');
	`)
	service := document.New(pool)
	emptyRecent, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewRecent, Limit: 50,
	})
	if err != nil || len(emptyRecent.Items) != 0 || emptyRecent.HasMore {
		t.Fatalf("unopened recent Documents=%#v error=%v", emptyRecent, err)
	}
	value, err := service.Get(ctx, "account_document_a", "document_human_a")
	if err != nil {
		t.Fatal(err)
	}
	if value.ID != "document_human_a" || value.TenantID != "tenant_document_a" ||
		value.Owner.ID != "actor_human_a" || value.Creator.ID != "actor_human_a" ||
		value.CurrentVersion == nil || value.CurrentVersion.ID != "version_service_one" ||
		!value.Capabilities.Read || !value.Capabilities.Write || !value.Capabilities.Delete {
		t.Fatalf("unexpected owner Document: %#v", value)
	}
	ownerRecent, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewRecent, Limit: 50,
	})
	if err != nil || len(ownerRecent.Items) != 1 || ownerRecent.Items[0].ID != "document_human_a" || ownerRecent.HasMore {
		t.Fatalf("successful Get did not record the recent open=%#v error=%v", ownerRecent, err)
	}
	shared, err := service.Get(ctx, "account_document_a", "document_agent_shared")
	if err != nil {
		t.Fatalf("open shared Document: %v", err)
	}
	if !shared.Capabilities.Read || !shared.Capabilities.Write || !shared.Capabilities.Comment ||
		shared.CanEditNativeContent || shared.DraftCapability != "none" {
		t.Fatalf("shared Document access mixed authority with native capability: %#v", shared)
	}

	page, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewOwned, Limit: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Imported mail is owned by the Human but is a Wiki input, not a page.
	if len(page.Items) != 1 || page.Items[0].ID != "document_human_a" || page.HasMore {
		t.Fatalf("unexpected owned page: %#v", page)
	}
	for view, wantID := range map[document.View]string{
		document.ViewShared:  "document_agent_shared",
		document.ViewUnfiled: "document_human_a",
	} {
		viewPage, listErr := service.List(ctx, document.ListInput{
			AccountID: "account_document_a", View: view, Limit: 50,
		})
		if listErr != nil {
			t.Fatalf("list %s: %v", view, listErr)
		}
		if len(viewPage.Items) != 1 || viewPage.Items[0].ID != wantID {
			t.Fatalf("view %s page=%#v want %s", view, viewPage, wantID)
		}
	}
	recent, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewRecent, Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(recent.Items) != 1 || recent.Items[0].ID != "document_agent_shared" || !recent.HasMore || recent.NextCursor == "" {
		t.Fatalf("unexpected first recent page: %#v", recent)
	}
	secondRecent, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewRecent, Limit: 1, Cursor: recent.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(secondRecent.Items) != 1 || secondRecent.Items[0].ID != "document_human_a" || secondRecent.HasMore {
		t.Fatalf("unexpected second recent page: %#v", secondRecent)
	}
	search, err := service.Search(ctx, document.SearchInput{
		AccountID: "account_document_a", Query: "document", Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(search.Items) != 1 || search.Items[0].ID != "document_agent_shared" ||
		!search.HasMore || search.NextCursor == "" {
		t.Fatalf("unexpected first search page: %#v", search)
	}
	if len(search.Items[0].From) != 1 || search.Items[0].From[0].ContextID != "room_document_a" {
		t.Fatalf("search source metadata: %#v", search.Items[0].From)
	}
	searchNext, err := service.Search(ctx, document.SearchInput{
		AccountID: "account_document_a", Query: "document", Limit: 1, Cursor: search.NextCursor,
	})
	if err != nil || len(searchNext.Items) != 1 || searchNext.Items[0].ID != "document_human_a" || searchNext.HasMore {
		t.Fatalf("unexpected second search page=%#v error=%v", searchNext, err)
	}
	// Only text the reader sees matches: the name of a source Room and an
	// owner's name do, while formats, Actor IDs and binding IDs do not.
	for query, wantID := range map[string]string{"Room A": "document_agent_shared", "Agent A": "document_agent_shared"} {
		visible, searchErr := service.Search(ctx, document.SearchInput{
			AccountID: "account_document_a", Query: query, Limit: 50,
		})
		if searchErr != nil || len(visible.Items) != 1 || visible.Items[0].ID != wantID {
			t.Fatalf("search %q=%#v error=%v want %s", query, visible, searchErr, wantID)
		}
	}
	for _, query := range []string{"note", "markdown", "actor_", "room_document"} {
		hidden, searchErr := service.Search(ctx, document.SearchInput{
			AccountID: "account_document_a", Query: query, Limit: 50,
		})
		if searchErr != nil || len(hidden.Items) != 0 {
			t.Fatalf("search %q matched text the reader does not see=%#v error=%v", query, hidden, searchErr)
		}
	}
	versions, err := service.ListVersions(ctx, document.ListVersionsInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Limit: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(versions.Items) != 1 || versions.Items[0].ID != "version_service_one" || versions.HasMore {
		t.Fatalf("unexpected Version page: %#v", versions)
	}
	if _, err := db.ExecContext(ctx, `UPDATE rooms SET
		deletion_started_at=clock_timestamp()-interval '1 second',
		deletion_started_by_actor_id='actor_human_a',
		deleted_at=clock_timestamp(),deleted_by_actor_id='actor_human_a'
		WHERE id='room_document_a'`); err != nil {
		t.Fatal(err)
	}
	// The Space's Human keeps reading the Document; only the deleted
	// Room's name stops matching it.
	if _, err := service.Get(ctx, "account_document_a", "document_agent_shared"); err != nil {
		t.Fatalf("deleted Room removed the Human's Document access: %v", err)
	}
	deletedRoomSearch, err := service.Search(ctx, document.SearchInput{
		AccountID: "account_document_a", Query: "Room A", Limit: 50,
	})
	if err != nil || len(deletedRoomSearch.Items) != 0 {
		t.Fatalf("deleted Room name still matched=%#v error=%v", deletedRoomSearch, err)
	}

	// My pages visibility does not revoke direct access or change search and Recent.
	importedSearch, err := service.Search(ctx, document.SearchInput{
		AccountID: "account_document_a", Query: "imported-mail-source", Limit: 50,
	})
	if err != nil || len(importedSearch.Items) != 1 || importedSearch.Items[0].ID != "document_imported_mail" {
		t.Fatalf("imported source search=%#v error=%v", importedSearch, err)
	}
	if _, err := service.Get(ctx, "account_document_a", "document_imported_mail"); err != nil {
		t.Fatalf("imported source direct read: %v", err)
	}
	importedRecent, err := service.List(ctx, document.ListInput{
		AccountID: "account_document_a", View: document.ViewRecent, Limit: 1,
	})
	if err != nil || len(importedRecent.Items) != 1 || importedRecent.Items[0].ID != "document_imported_mail" {
		t.Fatalf("opened imported source Recent=%#v error=%v", importedRecent, err)
	}
}

// The Space's Human owns every active Document's access: the envelope names
// the owner source only for the Human's own Documents, and a Binding adds none.
func TestUnifiedDocumentAccessV2GivesTheHumanOwnerAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Document Access V2 "+suffix, "document-access-v2-room-"+suffix)
	// Reading the Wiki never creates its root; the first source upload does.
	wikiID, _, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, false)
	workItemID := "work_item_document_access_v2_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document Access V2','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}

	type accessCase struct {
		name, documentID, ownerID, bindingID, bindingKind, contextID, wantRole string
		ownSource                                                              bool
	}
	cases := []accessCase{
		{
			name: "owner", documentID: "document_access_v2_owner_" + suffix,
			ownerID: "actor_acme_alice", wantRole: "owner", ownSource: true,
		},
		{
			name: "room", documentID: "document_access_v2_room_" + suffix,
			ownerID: "actor_acme_official", bindingID: "binding_access_v2_room_" + suffix,
			bindingKind: "room", contextID: roomID, wantRole: "owner",
		},
		{
			name: "task", documentID: "document_access_v2_task_" + suffix,
			ownerID: "actor_acme_official", bindingID: "binding_access_v2_task_" + suffix,
			bindingKind: "task", contextID: workItemID, wantRole: "owner",
		},
		{
			name: "wiki", documentID: "document_access_v2_wiki_" + suffix,
			ownerID: "actor_acme_official", bindingID: "binding_access_v2_wiki_" + suffix,
			bindingKind: "wiki_source", contextID: wikiID, wantRole: "owner",
		},
	}

	for _, testCase := range cases {
		if _, err := env.pool.Exec(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) SELECT $1,$2,$3,'blocknote',actor.id,actor.kind,actor.id,actor.kind,'active'
		FROM actors actor WHERE actor.id=$4 AND actor.tenant_id=$2`,
			testCase.documentID, acmeTenant, "Document Access V2 "+testCase.name, testCase.ownerID); err != nil {
			t.Fatal(err)
		}
		if testCase.bindingID == "" {
			continue
		}
		if _, err := env.pool.Exec(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,work_item_id,wiki_id,status
		) VALUES($1,$2,$3,$4,
			CASE WHEN $4='room' THEN $5 END,
			CASE WHEN $4='task' THEN $5 END,
			CASE WHEN $4 IN ('wiki_source','wiki_page') THEN $5 END,'active')`,
			testCase.bindingID, acmeTenant, testCase.documentID, testCase.bindingKind, testCase.contextID); err != nil {
			t.Fatal(err)
		}
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, _, body := env.request(alice, http.MethodGet,
				"/v0/documents/"+testCase.documentID, nil, "")
			if status != http.StatusOK {
				t.Fatalf("get Document status=%d body=%s", status, body)
			}
			var response struct {
				Capabilities struct {
					Read, Write, Manage, Comment bool
				} `json:"capabilities"`
				AccessV2 *struct {
					SchemaVersion     int    `json:"schema_version"`
					ContentRole       string `json:"content_role"`
					AuthorizationMode string `json:"authorization_mode"`
					Policy            struct {
						SchemaVersion int    `json:"schema_version"`
						LinkScope     string `json:"link_scope"`
					} `json:"policy"`
					Requests []any `json:"requests"`
					Sources  []struct {
						SchemaVersion int    `json:"schema_version"`
						SourceID      string `json:"source_id"`
						SourceKind    string `json:"source_kind"`
						SourceVersion int64  `json:"source_version"`
						Status        string `json:"status"`
						Role          string `json:"role"`
						Provenance    struct {
							SchemaVersion int    `json:"schema_version"`
							Kind          string `json:"kind"`
							BindingKind   string `json:"binding_kind"`
							ContextID     string `json:"context_id"`
						} `json:"provenance"`
					} `json:"sources"`
				} `json:"access_v2"`
			}
			decode(t, body, &response)
			if response.AccessV2 == nil {
				t.Fatalf("missing V2 envelope body=%s", body)
			}
			access := response.AccessV2
			if access.SchemaVersion != 2 || access.ContentRole != testCase.wantRole ||
				access.AuthorizationMode != "human_native" || access.Policy.SchemaVersion != 2 ||
				access.Policy.LinkScope != "restricted" || len(access.Requests) != 0 ||
				(len(access.Sources) == 1) != testCase.ownSource || len(access.Sources) > 1 {
				t.Fatalf("unexpected V2 envelope=%+v body=%s", access, body)
			}
			if testCase.ownSource {
				source := access.Sources[0]
				if source.SchemaVersion != 2 || source.SourceKind != "owner" ||
					source.Status != "active" || source.Role != "owner" ||
					source.Provenance.SchemaVersion != 2 || source.Provenance.Kind != "owner" ||
					source.SourceID != "owner:"+testCase.documentID || source.SourceVersion != 1 {
					t.Fatalf("unexpected owner source=%+v body=%s", source, body)
				}
			}

			var v2Read, v2Write, v2Manage, v2Comment bool
			var v2Role string
			if err := env.pool.QueryRow(ctx, `SELECT
				v2.can_read,v2.can_write,v2.can_manage,v2.can_comment,v2.content_role
			FROM resolve_human_document_access_v2('account_alice',$1) v2`,
				testCase.documentID).Scan(&v2Read, &v2Write, &v2Manage, &v2Comment, &v2Role); err != nil {
				t.Fatal(err)
			}
			if response.Capabilities.Read != v2Read ||
				response.Capabilities.Write != v2Write || response.Capabilities.Manage != v2Manage ||
				response.Capabilities.Comment != v2Comment || v2Role != testCase.wantRole {
				t.Fatalf("resolver parity v2=%t/%t/%t/%t role=%s response=%+v",
					v2Read, v2Write, v2Manage, v2Comment, v2Role, response.Capabilities)
			}
		})
	}
}

func TestUnifiedDocumentOwnerCommentsWithoutRoomProvenance(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	documentID := "document_unified_comment_" + suffix
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,
			creator_actor_id,creator_actor_kind,status
		) VALUES($1,$2,$3,'plain_text','actor_acme_alice','human',
			'actor_acme_alice','human','active')`, documentID, acmeTenant, "Unified Comment document"); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/documents/"+documentID+"/comment-threads?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("empty unified Comment list status=%d body=%s", status, body)
	}
	var emptyPage roomDocumentCommentThreadPageResponse
	decode(t, body, &emptyPage)
	if len(emptyPage.Items) != 0 || emptyPage.Page.HasMore || emptyPage.Page.NextCursor != "" {
		t.Fatalf("empty unified Comment page=%+v", emptyPage)
	}
	createInput := map[string]any{
		"anchor": map[string]any{
			"quoted_text": "Unified authority", "block_id": "block_unified_authority",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{
			"segments": []map[string]any{{"type": "text", "content": "Owner comment"}},
		},
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/comment-threads", createInput, "unified-comment-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("unified Document owner create Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	if thread.DocumentID != documentID || len(thread.Comments) != 1 {
		t.Fatalf("unified Document Comment thread=%+v", thread)
	}
	var graphWithoutRoom, documentEvents int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM room_document_comment_threads WHERE id=$1 AND room_id IS NULL)+
		(SELECT count(*) FROM room_document_comments WHERE thread_id=$1 AND room_id IS NULL),
		(SELECT count(*) FROM document_events WHERE document_id=$2
		 AND event_type='document.comment_updated' AND resource_id=$1)`,
		thread.ID, documentID).Scan(&graphWithoutRoom, &documentEvents); err != nil {
		t.Fatal(err)
	}
	if graphWithoutRoom != 2 || documentEvents != 1 {
		t.Fatalf("unified Comment evidence graph=%d/2 events=%d", graphWithoutRoom, documentEvents)
	}

	status, _, body = env.request(alice, http.MethodGet,
		"/v0/document-comment-threads/"+thread.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("Document owner Comment read status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
			"parent_comment_id": thread.Comments[0].ID,
			"segments":          []map[string]any{{"type": "text", "content": "Owner reply"}},
		}, "unified-comment-reply-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("unified Document Comment reply status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/document-comments/"+thread.Comments[0].ID, map[string]any{
			"expected_version": 1,
			"segments":         []map[string]any{{"type": "text", "content": "Owner comment edited"}},
		}, "unified-comment-edit-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unified Document Comment edit status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut,
		"/v0/document-comments/"+thread.Comments[0].ID+"/reactions/ack", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("unified Document Comment reaction status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/document-comment-threads/"+thread.ID+"/anchors", map[string]any{
			"quoted_text": "Unified authority moved", "block_id": "block_unified_authority_moved",
			"context_before": "new before", "context_after": "new after",
		}, "unified-comment-reanchor-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unified Document Comment reanchor status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+thread.ID, map[string]any{"resolved": true},
		"unified-comment-resolve-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unified Document Comment resolve status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+thread.ID, map[string]any{"resolved": false},
		"unified-comment-reopen-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unified Document Comment reopen status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/document-comments/"+thread.Comments[0].ID,
		map[string]any{"expected_version": 2}, "unified-comment-delete-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("unified Document Comment delete status=%d body=%s", status, body)
	}
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.comment_updated'`, documentID).Scan(&documentEvents); err != nil {
		t.Fatal(err)
	}
	if documentEvents != 8 {
		t.Fatalf("unified Comment mutation events=%d want=8", documentEvents)
	}
	// An Agent reads the thread without a Binding or grant.
	if _, err := document.NewCommentService(env.pool, nil).GetThreadForAgent(
		t.Context(), acmeOfficialAgentManagementID, thread.ID); err != nil {
		t.Fatalf("Agent Comment read without a grant err=%v", err)
	}
}

func TestUnifiedDocumentCommentsFollowCurrentBindingUnion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Unified Comment Binding "+suffix, "unified-comment-binding-room-"+suffix)
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/members/actor_acme_official", map[string]any{"role": "member"}, "")
	if status != http.StatusOK {
		t.Fatalf("add Agent to Comment Binding Room status=%d body=%s", status, body)
	}
	documentID := "document_unified_comment_binding_" + suffix
	bindingID := "binding_unified_comment_" + suffix
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,
		creator_actor_id,creator_actor_kind,status
	) VALUES($1,$2,'Binding Comment','blocknote','actor_acme_alice','human',
		'actor_acme_alice','human','active')`, documentID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES($1,$2,$3,'room',$4,'active')`, bindingID, acmeTenant, documentID, roomID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/documents/"+documentID+"/comment-threads", map[string]any{
			"anchor": map[string]any{
				"quoted_text": "Binding authority", "block_id": "block_binding_authority",
				"context_before": "before", "context_after": "after",
			},
			"initial_comment": map[string]any{
				"segments": []map[string]any{{"type": "text", "content": "Binding comment"}},
			},
		}, "unified-comment-binding-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("Binding authority Comment create status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	// The Agent reads and replies through the MCP comment tools, which share
	// these Binding-aware domain calls.
	comments := document.NewCommentService(env.pool, nil)
	if _, err := comments.GetThreadForAgent(t.Context(), acmeOfficialAgentManagementID, thread.ID); err != nil {
		t.Fatalf("Agent Binding Comment read: %v", err)
	}
	agentReply := document.AgentReplyInput{
		AgentManagementID: acmeOfficialAgentManagementID, ThreadID: thread.ID,
		IdempotencyKey: "unified-comment-agent-reply-" + suffix, ParentCommentID: &thread.Comments[0].ID,
		Segments: []document.Segment{{Type: "text", Content: "Agent Binding reply"}},
	}
	created, err := comments.ReplyForAgent(t.Context(), agentReply)
	if err != nil || created.Replay {
		t.Fatalf("Agent Binding Comment reply=%+v err=%v", created, err)
	}
	replayed, err := comments.ReplyForAgent(t.Context(), agentReply)
	if err != nil || !replayed.Replay || replayed.Comment.ID != created.Comment.ID {
		t.Fatalf("Agent Binding Comment replay=%+v err=%v", replayed, err)
	}
	var commentEvents, legacyRoomEvents int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM document_events WHERE document_id=$1 AND resource_id=$2),
		(SELECT count(*) FROM room_events
		 WHERE room_id=$3 AND event_type='document.comment.changed' AND resource_id=$2)`,
		documentID, thread.ID, roomID).Scan(&commentEvents, &legacyRoomEvents); err != nil {
		t.Fatal(err)
	}
	if commentEvents != 2 {
		t.Fatalf("Comment Document events=%d want=2", commentEvents)
	}
	if legacyRoomEvents != 0 {
		t.Fatalf("Comment mutations wrote %d legacy Room events", legacyRoomEvents)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1 WHERE id=$1`, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, err := comments.GetThreadForAgent(t.Context(), acmeOfficialAgentManagementID, thread.ID); err != nil {
		t.Fatalf("Agent Comment read after its Binding was suspended err=%v", err)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/document-comment-threads/"+thread.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("owner authority after Binding suspend status=%d body=%s", status, body)
	}
}

func TestUnifiedDocumentPersonalTreeMutationsAreScopedAndIdempotent(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
		 'revision_human_a','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)

	tree, err := service.GetMyTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 0 {
		t.Fatalf("empty tree=%#v error=%v", tree, err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,sort_key
		) VALUES('placement_tree_document_a','tenant_document_a','personal',
			'actor_human_a','document','document_human_a','document_human_a')
	`); err != nil {
		t.Fatal(err)
	}
	tree, err = service.GetMyTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 1 || tree[0].Document == nil ||
		tree[0].Document.ID != "document_human_a" || tree[0].Document.Title != "Human document" ||
		tree[0].Document.Owner.ID != "actor_human_a" || !tree[0].Document.CanEditNativeContent ||
		!tree[0].Document.Capabilities.Write || !tree[0].Document.Capabilities.Comment {
		t.Fatalf("tenant tree summary=%#v error=%v", tree, err)
	}
	root, err := service.CreateFolder(ctx, document.CreateFolderInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		Name: "Projects",
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := service.CreateFolder(ctx, document.CreateFolderInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		ParentID: &root.ID, Name: "Child",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteFolder(ctx, document.DeleteFolderInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		PlacementID: root.ID,
	}); !errors.Is(err, document.ErrFolderNotEmpty) {
		t.Fatalf("delete non-empty error=%v", err)
	}
	if _, err := service.UpdatePlacement(ctx, document.UpdatePlacementInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		PlacementID: root.ID, ParentID: &child.ID,
	}); !errors.Is(err, document.ErrConflict) {
		t.Fatalf("descendant cycle error=%v", err)
	}
	child, err = service.UpdatePlacement(ctx, document.UpdatePlacementInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		PlacementID: child.ID, Name: "Renamed",
		MoveToRoot: true,
	})
	if err != nil || child.ParentID != nil || child.Name != "Renamed" {
		t.Fatalf("updated child=%#v error=%v", child, err)
	}
	if err := service.DeleteFolder(ctx, document.DeleteFolderInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		PlacementID: root.ID,
	}); err != nil {
		t.Fatal(err)
	}
	tree, err = service.GetMyTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 2 || tree[1].ID != child.ID {
		t.Fatalf("final tree=%#v error=%v", tree, err)
	}
	if _, err := service.CreateFolder(ctx, document.CreateFolderInput{AccountID: "account_document_a", Name: "No Tenant"}); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("folder without Tenant error=%v", err)
	}
	left, err := service.CreateFolder(ctx, document.CreateFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Name: "Left"})
	if err != nil {
		t.Fatal(err)
	}
	right, err := service.CreateFolder(ctx, document.CreateFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Name: "Right"})
	if err != nil {
		t.Fatal(err)
	}
	moveErrors := make(chan error, 2)
	go func() {
		_, moveErr := service.UpdatePlacement(ctx, document.UpdatePlacementInput{AccountID: "account_document_a", TenantID: "tenant_document_a", PlacementID: left.ID, ParentID: &right.ID})
		moveErrors <- moveErr
	}()
	go func() {
		_, moveErr := service.UpdatePlacement(ctx, document.UpdatePlacementInput{AccountID: "account_document_a", TenantID: "tenant_document_a", PlacementID: right.ID, ParentID: &left.ID})
		moveErrors <- moveErr
	}()
	firstMoveErr, secondMoveErr := <-moveErrors, <-moveErrors
	if (firstMoveErr == nil) == (secondMoveErr == nil) || (firstMoveErr != nil && !errors.Is(firstMoveErr, document.ErrConflict)) || (secondMoveErr != nil && !errors.Is(secondMoveErr, document.ErrConflict)) {
		t.Fatalf("concurrent cycle errors=%v / %v", firstMoveErr, secondMoveErr)
	}
	var cyclic bool
	if err := db.QueryRowContext(ctx, `WITH RECURSIVE ancestry AS (
		SELECT id,parent_id,ARRAY[id] path,false cyclic FROM document_placements
		WHERE id=ANY($1::text[])
		UNION ALL SELECT parent.id,parent.parent_id,child.path||parent.id,parent.id=ANY(child.path)
		FROM document_placements parent JOIN ancestry child ON parent.id=child.parent_id WHERE NOT child.cyclic
	) SELECT coalesce(bool_or(cyclic),false) FROM ancestry`, []string{left.ID, right.ID}).Scan(&cyclic); err != nil {
		t.Fatal(err)
	}
	if cyclic {
		t.Fatal("concurrent moves committed a cycle")
	}
	var documentEvents int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_events`).Scan(&documentEvents); err != nil {
		t.Fatal(err)
	}
	if documentEvents != 0 {
		t.Fatalf("Folder placement Document events=%d want 0", documentEvents)
	}
}

func TestUnifiedDocumentHistoryCheckpointAndExactCurrentRestore(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_human_a','actor_human_a'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)

	empty, err := service.ListHistory(ctx, document.ListHistoryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Limit: 50,
	})
	if err != nil || len(empty.Items) != 0 || empty.HasMore {
		t.Fatalf("empty History=%#v error=%v", empty, err)
	}
	checkpoint, err := service.CreateHistoryCheckpoint(ctx, document.CreateHistoryCheckpointInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
	})
	if err != nil {
		t.Fatal(err)
	}
	var trigger string
	if err := db.QueryRowContext(ctx, `SELECT history_trigger FROM document_revisions WHERE id=$1`,
		checkpoint.ID).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if checkpoint.ID != checkpoint.HistoryEntry.ID || checkpoint.Status != "completed" || trigger != "manual" {
		t.Fatalf("manual checkpoint=%+v trigger=%s", checkpoint, trigger)
	}
	converged, err := service.CreateHistoryCheckpoint(ctx, document.CreateHistoryCheckpointInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
	})
	if err != nil || converged.ID != checkpoint.ID {
		t.Fatalf("same-head checkpoint=%#v error=%v", converged, err)
	}

	page, err := service.ListHistory(ctx, document.ListHistoryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Limit: 50,
	})
	if err != nil || len(page.Items) != 1 || page.Items[0].RevisionID != "revision_human_a" ||
		page.Items[0].Trigger != "manual" || len(page.Items[0].Contributors) != 1 {
		t.Fatalf("History page=%#v error=%v", page, err)
	}
	var draftBefore, historyBefore, versionBefore, eventBefore, idempotencyBefore int
	if err := db.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM document_bodies WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
			(SELECT count(*) FROM document_versions WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_events WHERE document_id='document_human_a'),
			(SELECT count(*) FROM command_replays WHERE scope='account:'||'account_document_a')
	`).Scan(&draftBefore, &historyBefore, &versionBefore, &eventBefore, &idempotencyBefore); err != nil {
		t.Fatal(err)
	}
	result, err := service.RestoreHistoryEntry(ctx, document.RestoreHistoryEntryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		HistoryEntryID: page.Items[0].ID,
	})
	if err != nil || result.Status != document.HistoryRestoreAlreadyCurrent || result.HistoryEntry.ID != page.Items[0].ID {
		t.Fatalf("exact-current restore=%#v error=%v", result, err)
	}
	var draftAfter, historyAfter, versionAfter, eventAfter, idempotencyAfter int
	if err := db.QueryRowContext(ctx, `
		SELECT
			(SELECT count(*) FROM document_bodies WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
			(SELECT count(*) FROM document_versions WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_events WHERE document_id='document_human_a'),
			(SELECT count(*) FROM command_replays WHERE scope='account:'||'account_document_a')
	`).Scan(&draftAfter, &historyAfter, &versionAfter, &eventAfter, &idempotencyAfter); err != nil {
		t.Fatal(err)
	}
	if draftAfter != draftBefore || historyAfter != historyBefore || versionAfter != versionBefore ||
		eventAfter != eventBefore || idempotencyAfter != idempotencyBefore {
		t.Fatalf("already_current side effects draft %d->%d history %d->%d version %d->%d event %d->%d idempotency %d->%d",
			draftBefore, draftAfter, historyBefore, historyAfter, versionBefore, versionAfter,
			eventBefore, eventAfter, idempotencyBefore, idempotencyAfter)
	}
}

// A History point copies the body into a Revision once: a second point of
// the same state keeps the first trigger, and the editors since the previous
// point become its contributors and start over.
func TestUnifiedDocumentHistoryPointCopiesTheBodyOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	_, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := pool.Exec(ctx, `INSERT INTO document_bodies(
		document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids
	) VALUES('document_human_a',3,'\x03','\x03','{}','{}',ARRAY['actor_human_a'])`); err != nil {
		t.Fatal(err)
	}
	var first, second, trigger string
	var contributors, editors []string
	if err := pool.QueryRow(ctx, `SELECT record_document_history_point('document_human_a','idle')`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT record_document_history_point('document_human_a','manual')`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT revision.history_trigger,revision.history_contributor_ids,
		body.last_editor_ids
		FROM document_revisions revision JOIN document_bodies body ON body.document_id=revision.document_id
		WHERE revision.id=$1 AND revision.persisted_seq=3`, first).Scan(
		&trigger, &contributors, &editors); err != nil {
		t.Fatal(err)
	}
	if second != first || trigger != "idle" || len(contributors) != 1 || contributors[0] != "actor_human_a" || len(editors) != 0 {
		t.Fatalf("History point first=%s second=%s trigger=%s contributors=%v editors=%v",
			first, second, trigger, contributors, editors)
	}
}

func TestUnifiedDocumentHistoryHidesTheCreationBody(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids)
		SELECT document_id,0,state_bytes,state_vector,'{}',thread_manifest,ARRAY[created_by_actor_id]
		FROM document_revisions WHERE id='revision_human_a';
		SELECT record_document_history_point('document_human_a','idle')
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)

	page, err := service.ListHistory(ctx, document.ListHistoryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Limit: 50,
	})
	if err != nil || len(page.Items) != 0 || page.HasMore {
		t.Fatalf("creation History page=%#v error=%v", page, err)
	}
	if _, err := service.GetHistoryContent(ctx, "account_document_a", "revision_human_a"); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("creation History content error=%v want not found", err)
	}
}

// restoreApply is a Runtime apply that saves the restored state over the body.
func restoreApply(pool *pgxpool.Pool, calls *int) func(context.Context, document.ApplyRequest) (document.ApplyResult, error) {
	return applyToBody(pool, func(input document.ApplyRequest, _ []byte) ([]byte, []byte, []string, []string, string, error) {
		*calls++
		if input.Restore == nil {
			return nil, nil, nil, nil, "", errors.New("expected a restore change")
		}
		return []byte{2, 3, 4}, []byte{2}, nil, nil, "", nil
	})
}

func TestUnifiedDocumentHistoryRestoreRecordsTheRestoredBody(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentHistoryRestoreFixture(t)
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: restoreApply(pool, &runtimeCalls)}, nil)
	input := document.RestoreHistoryEntryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		HistoryEntryID: "revision_human_a",
	}
	result, err := service.RestoreHistoryEntry(ctx, input)
	if err != nil || result.Status != document.HistoryRestoreRestored || runtimeCalls != 1 ||
		result.HistoryEntry.Trigger != "restore" || result.HistoryEntry.PersistedSeq != 2 {
		t.Fatalf("restore result=%#v runtime calls=%d error=%v", result, runtimeCalls, err)
	}
	var persistedSeq, histories, versions, historyEvents int
	if err := db.QueryRowContext(ctx, `
		SELECT
			(SELECT seq FROM document_bodies WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
			(SELECT count(*) FROM document_versions WHERE document_id='document_human_a'),
			(SELECT count(*) FROM document_events WHERE document_id='document_human_a'
			 AND event_type='document.history_checkpointed')
	`).Scan(&persistedSeq, &histories, &versions, &historyEvents); err != nil {
		t.Fatal(err)
	}
	if persistedSeq != 2 || histories != 2 || versions != 0 || historyEvents != 0 {
		t.Fatalf("restore evidence seq=%d histories=%d versions=%d events=%d",
			persistedSeq, histories, versions, historyEvents)
	}
}

func TestUnifiedDocumentHistoryRestoreOfTheCurrentBodyChangesNothing(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentHistoryRestoreFixture(t)
	if _, err := db.ExecContext(ctx, `SELECT record_document_history_point('document_human_a','manual')`); err != nil {
		t.Fatal(err)
	}
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: restoreApply(pool, &runtimeCalls)}, nil)
	result, err := service.RestoreHistoryEntry(ctx, document.RestoreHistoryEntryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		HistoryEntryID: "revision_restore_current",
	})
	if err != nil || result.Status != document.HistoryRestoreAlreadyCurrent || runtimeCalls != 0 {
		t.Fatalf("current restore result=%#v calls=%d error=%v", result, runtimeCalls, err)
	}
}

func TestUnifiedDocumentHistoryRestoreFailsWhenTheRuntimeIsUnavailable(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentHistoryRestoreFixture(t)
	service := document.NewWithRuntime(pool, documentRuntimeStub{}, nil)
	if _, err := service.RestoreHistoryEntry(ctx, document.RestoreHistoryEntryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		HistoryEntryID: "revision_human_a",
	}); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("restore with the Runtime down error=%v", err)
	}
	var seq, histories, replays int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT seq FROM document_bodies WHERE document_id='document_human_a'),
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM command_replays WHERE key='restore-runtime-down')`).Scan(&seq, &histories, &replays); err != nil {
		t.Fatal(err)
	}
	if seq != 1 || histories != 1 || replays != 0 {
		t.Fatalf("failed restore seq=%d histories=%d replays=%d", seq, histories, replays)
	}
}

func newUnifiedDocumentHistoryRestoreFixture(t *testing.T) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		UPDATE document_revisions SET history_trigger='manual',
			history_contributor_ids=ARRAY['actor_human_a'],history_recorded_at=clock_timestamp()
		WHERE id='revision_human_a';
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES('revision_restore_current','tenant_document_a','document_human_a',1,'\x01',
			repeat('d',64),'\x01',repeat('d',64),'[]'::jsonb,'actor_human_a');
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids)
		VALUES('document_human_a',1,'\x01','\x01','{}','{}',ARRAY['actor_human_a'])
	`); err != nil {
		t.Fatal(err)
	}
	return db, pool
}

func TestUnifiedDocumentCreateBlankIsSingleAggregateAndFailClosed(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,name,sort_key
		) VALUES('placement_create_parent_a','tenant_document_a','personal','actor_human_a','folder','A','a')
	`); err != nil {
		t.Fatal(err)
	}

	runtimeCalls := 0
	runtimeFailure := true
	invalidMaterialization := false
	materializer := func(
		_ context.Context,
		input document.ImportRequest,
	) (document.ImportedState, error) {
		runtimeCalls++
		if input.OperationID == "" || input.SourceKind != "blank" {
			t.Fatalf("blank import=%+v", input)
		}
		if runtimeFailure {
			return document.ImportedState{}, document.ErrRuntimeUnavailable
		}
		state := []byte{1, 2, 3}
		result := document.ImportedState{
			StateBytes: state, StateBytesSHA256: unifiedDocumentDigest(state),
			StateVector: []byte{1}, FullStateFingerprint: unifiedDocumentDigest(state),
			StateHashVersion: 1, CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{},
		}
		if invalidMaterialization {
			result.FullStateFingerprint = strings.Repeat("z", 64)
		}
		return result, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: materializer}, nil)
	input := document.CreateDocumentInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
	}
	if _, err := service.Create(ctx, input); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("Runtime failure error=%v", err)
	}
	var documents, revisions, drafts, placements, events, idempotency int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM documents),(SELECT count(*) FROM document_revisions),
		(SELECT count(*) FROM document_bodies),(SELECT count(*) FROM document_placements),
		(SELECT count(*) FROM document_events),(SELECT count(*) FROM command_replays)
	`).Scan(&documents, &revisions, &drafts, &placements, &events, &idempotency); err != nil {
		t.Fatal(err)
	}
	if documents != 1 || revisions != 1 || drafts != 0 || placements != 1 || events != 0 || idempotency != 0 {
		t.Fatalf("Runtime failure partial state documents=%d revisions=%d drafts=%d placements=%d events=%d keys=%d",
			documents, revisions, drafts, placements, events, idempotency)
	}

	runtimeFailure = false
	invalidMaterialization = true
	if _, err := service.Create(ctx, input); !errors.Is(err, document.ErrRuntimeResultInvalid) {
		t.Fatalf("invalid Runtime import error=%v", err)
	}
	invalidMaterialization = false
	created, err := service.Create(ctx, input)
	if err != nil || created.Document.ID == "" || created.Document.Title != "untitled" ||
		created.Document.Format != "blocknote" || created.Document.RepresentationFormat != "markdown" ||
		created.Document.CurrentVersion != nil {
		t.Fatalf("created=%+v error=%v", created, err)
	}
	if runtimeCalls != 3 {
		t.Fatalf("Runtime calls=%d", runtimeCalls)
	}
	var persistedSeq, versionCount, placementCount, eventCount int
	var stateStatus string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT seq FROM document_bodies WHERE document_id=$1),
		(SELECT state_status FROM document_revisions WHERE document_id=$1),
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_placements WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1)
	`, created.Document.ID).Scan(
		&persistedSeq, &stateStatus, &versionCount, &placementCount, &eventCount,
	); err != nil {
		t.Fatal(err)
	}
	if persistedSeq != 0 || stateStatus != "available" || versionCount != 0 || placementCount != 1 ||
		eventCount != 1 {
		t.Fatalf("created aggregate seq=%d state=%s versions=%d placements=%d events=%d",
			persistedSeq, stateStatus, versionCount, placementCount, eventCount)
	}
	if _, err := service.Create(ctx, document.CreateDocumentInput{
		AccountID: input.AccountID,
	}); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("create without Tenant error=%v", err)
	}
	tenantACreated, err := service.Create(ctx, document.CreateDocumentInput{
		AccountID: input.AccountID, TenantID: "tenant_document_a",
	})
	if err != nil || tenantACreated.Document.TenantID != "tenant_document_a" {
		t.Fatalf("Tenant A create=%+v error=%v", tenantACreated, err)
	}
}

func TestUnifiedDocumentUploadCreatesOnlyFileAggregateAndCompensatesObjects(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,name,sort_key
		) VALUES('placement_upload_parent_a','tenant_document_a','personal','actor_human_a','folder','A','a')
	`); err != nil {
		t.Fatal(err)
	}
	objectRoot := t.TempDir()
	localObjects, err := artifactstore.NewLocalStore(objectRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	objects := &countingDocumentObjectStore{ObjectStore: localObjects, failPut: true}
	service := document.NewWithObjectStore(pool, objects)
	parentID := "placement_upload_parent_a"
	input := document.UploadDocumentInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "upload-document-file",
		ParentID: &parentID, Filename: "report.txt", RepresentationFormat: "plain_text",
		MediaType: "text/plain", Content: strings.NewReader("stable upload"),
	}
	if _, err := service.Upload(ctx, input); !errors.Is(err, document.ErrObjectStoreUnavailable) {
		t.Fatalf("ObjectStore failure error=%v", err)
	}
	assertUnifiedDocumentUploadCounts(t, ctx, db, "", 1, 1, 0, 0, 1, 0)

	objects.failPut = false
	created, err := service.Upload(ctx, document.UploadDocumentInput{
		AccountID: input.AccountID, TenantID: input.TenantID, IdempotencyKey: input.IdempotencyKey,
		ParentID: input.ParentID, Filename: input.Filename,
		RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType,
		Content: strings.NewReader("stable upload"),
	})
	if err != nil || created.Replayed || created.Document.ID == "" ||
		created.Document.Title != "report.txt" || created.Document.Format != "plain_text" ||
		created.Document.CurrentVersion == nil || created.Document.DraftCapability != "none" {
		t.Fatalf("created=%+v error=%v", created, err)
	}
	replayed, err := service.Upload(ctx, document.UploadDocumentInput{
		AccountID: input.AccountID, TenantID: input.TenantID, IdempotencyKey: input.IdempotencyKey,
		ParentID: input.ParentID, Filename: input.Filename,
		RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType,
		Content: strings.NewReader("stable upload"),
	})
	if err != nil || !replayed.Replayed || replayed.Document.ID != created.Document.ID {
		t.Fatalf("replayed=%+v error=%v", replayed, err)
	}
	if _, err := service.Upload(ctx, document.UploadDocumentInput{
		AccountID: input.AccountID, TenantID: input.TenantID, IdempotencyKey: input.IdempotencyKey,
		ParentID: input.ParentID, Filename: "different.txt",
		RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType,
		Content: strings.NewReader("stable upload"),
	}); !errors.Is(err, document.ErrIdempotencyConflict) {
		t.Fatalf("idempotency conflict error=%v", err)
	}
	assertUnifiedDocumentUploadCounts(t, ctx, db, created.Document.ID, 2, 1, 0, 1, 2, 1)
	entries, err := os.ReadDir(objectRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || objects.puts != 4 {
		t.Fatalf("stored objects=%d puts=%d", len(entries), objects.puts)
	}

	empty, err := service.Upload(ctx, document.UploadDocumentInput{
		AccountID: input.AccountID, TenantID: input.TenantID, IdempotencyKey: "upload-empty-document",
		ParentID: input.ParentID, Filename: "empty.bin", RepresentationFormat: "binary",
		MediaType: "application/octet-stream", Content: strings.NewReader(""),
	})
	if err != nil || empty.Document.CurrentVersion == nil {
		t.Fatalf("empty upload=%+v error=%v", empty, err)
	}
	var emptySize int64
	if err := db.QueryRowContext(ctx, `SELECT size_bytes FROM document_versions WHERE id=$1`,
		empty.Document.CurrentVersion.ID).Scan(&emptySize); err != nil || emptySize != 0 {
		t.Fatalf("empty size=%d error=%v", emptySize, err)
	}

	replacementInput := document.UploadDocumentVersionInput{
		AccountID: input.AccountID, DocumentID: created.Document.ID,
		ExpectedCurrentVersionID: created.Document.CurrentVersion.ID,
		IdempotencyKey:           "replace-document-file", Filename: "report-v2.txt",
		RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType,
		Content: strings.NewReader("replacement upload"),
	}
	objects.failPut = true
	if _, err := service.UploadVersion(ctx, replacementInput); !errors.Is(err, document.ErrObjectStoreUnavailable) {
		t.Fatalf("replacement ObjectStore failure error=%v", err)
	}
	objects.failPut = false
	replacement, err := service.UploadVersion(ctx, replacementInput)
	if err != nil || replacement.Replayed || replacement.Version.VersionNumber != 2 ||
		replacement.Version.BaseVersionID == nil || *replacement.Version.BaseVersionID != created.Document.CurrentVersion.ID ||
		replacement.Version.Source != "replacement_upload" {
		t.Fatalf("replacement=%+v error=%v", replacement, err)
	}
	replay, err := service.UploadVersion(ctx, document.UploadDocumentVersionInput{
		AccountID: replacementInput.AccountID, DocumentID: replacementInput.DocumentID,
		ExpectedCurrentVersionID: replacementInput.ExpectedCurrentVersionID,
		IdempotencyKey:           replacementInput.IdempotencyKey, Filename: replacementInput.Filename,
		RepresentationFormat: replacementInput.RepresentationFormat, MediaType: replacementInput.MediaType,
		Content: strings.NewReader("replacement upload"),
	})
	if err != nil || !replay.Replayed || replay.Version.ID != replacement.Version.ID {
		t.Fatalf("replacement replay=%+v error=%v", replay, err)
	}
	if _, err := service.UploadVersion(ctx, document.UploadDocumentVersionInput{
		AccountID: replacementInput.AccountID, DocumentID: replacementInput.DocumentID,
		ExpectedCurrentVersionID: replacementInput.ExpectedCurrentVersionID,
		IdempotencyKey:           replacementInput.IdempotencyKey, Filename: "different-v2.txt",
		RepresentationFormat: replacementInput.RepresentationFormat, MediaType: replacementInput.MediaType,
		Content: strings.NewReader("replacement upload"),
	}); !errors.Is(err, document.ErrIdempotencyConflict) {
		t.Fatalf("replacement idempotency conflict error=%v", err)
	}
	if _, err := service.UploadVersion(ctx, document.UploadDocumentVersionInput{
		AccountID: input.AccountID, DocumentID: created.Document.ID,
		ExpectedCurrentVersionID: created.Document.CurrentVersion.ID,
		IdempotencyKey:           "replace-stale-version", Filename: "stale.txt",
		RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType,
		Content: strings.NewReader("stale replacement"),
	}); !errors.Is(err, document.ErrVersionConflict) {
		t.Fatalf("stale replacement error=%v", err)
	}
	if _, err := service.UploadVersion(ctx, document.UploadDocumentVersionInput{
		AccountID: input.AccountID, DocumentID: "document_human_a",
		ExpectedCurrentVersionID: "version-does-not-exist",
		IdempotencyKey:           "replace-native-document", Filename: "native.md",
		RepresentationFormat: "blocknote", MediaType: "text/markdown",
		Content: strings.NewReader("native replacement"),
	}); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("native replacement error=%v", err)
	}
	var replacementVersions, replacementEvents int
	var currentVersionID string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1),
		(SELECT current_version_id FROM documents WHERE id=$1)
	`, created.Document.ID).Scan(&replacementVersions, &replacementEvents, &currentVersionID); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(objectRoot)
	if err != nil {
		t.Fatal(err)
	}
	if replacementVersions != 2 || replacementEvents != 2 || currentVersionID != replacement.Version.ID ||
		len(entries) != 3 || objects.puts != 11 {
		t.Fatalf("replacement versions=%d events=%d current=%s objects=%d puts=%d",
			replacementVersions, replacementEvents, currentVersionID, len(entries), objects.puts)
	}
}

type countingDocumentObjectStore struct {
	artifactstore.ObjectStore
	puts    int
	failPut bool
}

func (store *countingDocumentObjectStore) Put(ctx context.Context, source io.Reader) (artifactstore.Object, error) {
	store.puts++
	if store.failPut {
		return artifactstore.Object{}, document.ErrObjectStoreUnavailable
	}
	return store.ObjectStore.Put(ctx, source)
}

func assertUnifiedDocumentUploadCounts(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	documentID string,
	wantDocuments, wantRevisions, wantDrafts, wantVersions, wantPlacements, wantEvents int,
) {
	t.Helper()
	var documents, revisions, drafts, versions, placements, events int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM documents),
		(SELECT count(*) FROM document_revisions),
		(SELECT count(*) FROM document_bodies),
		(SELECT count(*) FROM document_versions),
		(SELECT count(*) FROM document_placements),
		(SELECT count(*) FROM document_events WHERE document_id=$1)
	`, documentID).Scan(&documents, &revisions, &drafts, &versions, &placements, &events); err != nil {
		t.Fatal(err)
	}
	if documents != wantDocuments || revisions != wantRevisions || drafts != wantDrafts ||
		versions != wantVersions || placements != wantPlacements || events != wantEvents {
		t.Fatalf("counts documents=%d revisions=%d drafts=%d versions=%d placements=%d events=%d",
			documents, revisions, drafts, versions, placements, events)
	}
}

func TestUnifiedDocumentRoomRevocationRecomputesBindingUnionWithoutDocumentFence(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	firstRoomID := env.createRoom(alice, acmeTenant, "Document access source A "+suffix, "document-access-room-a-"+suffix)
	secondRoomID := env.createRoom(alice, acmeTenant, "Document access source B "+suffix, "document-access-room-b-"+suffix)
	for _, roomID := range []string{firstRoomID, secondRoomID} {
		if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
			t.Fatalf("add Agent to access source Room status=%d body=%s", status, body)
		}
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+firstRoomID+"/documents/uploads", "document-access-upload-"+suffix,
		map[string]string{
			"filename": "access.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "access.txt", []byte("binding union evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	if created.ID == "" {
		t.Fatalf("typed upload missing Document identity body=%s", body)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES($1,$2,$3,'room',$4,'active')`, "binding_document_access_second_"+suffix,
		acmeTenant, created.ID, secondRoomID); err != nil {
		t.Fatal(err)
	}
	status, _, body = requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+firstRoomID+"/documents/uploads", "document-access-loss-upload-"+suffix,
		map[string]string{
			"filename": "access-loss.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "access-loss.txt", []byte("single binding access evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("single Binding typed upload status=%d body=%s", status, body)
	}
	var accessLostDocument struct {
		ID string `json:"id"`
	}
	decode(t, body, &accessLostDocument)

	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/rooms/"+firstRoomID+"/members/actor_acme_official", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("begin Room member revocation status=%d body=%s", status, body)
	}
	// The second Room keeps the Agent's access to the first Document, so only
	// An Agent keeps its Human's access, so neither Document is fenced; both
	// Documents' tokens are stale.
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("remaining Binding union fenced the Agent %d times", fences)
	}
	if fences := documentDisconnects(t, env, accessLostDocument.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("Room revocation fenced the Agent %d times", fences)
	}
	for _, documentID := range []string{created.ID, accessLostDocument.ID} {
		if count := documentPermissionCount(t, env, documentID); count < 1 {
			t.Fatalf("revocation left Document %s permission count at %d", documentID, count)
		}
	}
	var accessEvents int
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM document_events
		WHERE document_id IN ($1,$2) AND event_type='document.access_invalidated'`,
		created.ID, accessLostDocument.ID).Scan(&accessEvents); err != nil {
		t.Fatal(err)
	}
	if accessEvents != 2 {
		t.Fatalf("access invalidation events=%d want 2", accessEvents)
	}
}

func TestUnifiedDocumentTaskAssignmentRemovalKeepsAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	firstWorkItemID := "work_item_document_access_a_" + suffix
	secondWorkItemID := "work_item_document_access_b_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES
		($1,$3,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$3),
		 'issue','Document access Task A','actor_acme_alice','actor_acme_alice'),
		($2,$3,(SELECT coalesce(max(number),0)+2 FROM work_items WHERE tenant_id=$3),
		 'issue','Document access Task B','actor_acme_alice','actor_acme_alice')`,
		firstWorkItemID, secondWorkItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_item_assignments(
		work_item_id,tenant_id,actor_id,assigned_by_actor_id
	) VALUES($1,$3,'actor_acme_official','actor_acme_alice'),
	        ($2,$3,'actor_acme_official','actor_acme_alice')`,
		firstWorkItemID, secondWorkItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	upload := func(key, filename string) string {
		t.Helper()
		status, _, body := requestUnifiedDocumentMultipart(
			t, env, alice, "/v0/work-items/"+firstWorkItemID+"/documents/uploads", key,
			map[string]string{
				"filename": filename, "representation_format": "plain_text", "media_type": "text/plain",
			}, filename, []byte("Task Binding union evidence"),
		)
		if status != http.StatusCreated {
			t.Fatalf("Task typed upload status=%d body=%s", status, body)
		}
		var created struct {
			ID string `json:"id"`
		}
		decode(t, body, &created)
		return created.ID
	}
	unionDocumentID := upload("task-access-union-upload-"+suffix, "task-union.txt")
	lostDocumentID := upload("task-access-loss-upload-"+suffix, "task-loss.txt")
	if _, err := env.pool.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,work_item_id,status
	) VALUES($1,$2,$3,'task',$4,'active')`, "binding_task_access_second_"+suffix,
		acmeTenant, unionDocumentID, secondWorkItemID); err != nil {
		t.Fatal(err)
	}

	status, _, body := env.request(alice, http.MethodDelete,
		"/v0/work-items/"+firstWorkItemID+"/assignments/actor_acme_official", nil,
		"task-access-unassign-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("delete Task assignment status=%d body=%s", status, body)
	}
	if fences := documentDisconnects(t, env, unionDocumentID, "actor_acme_official"); fences != 0 {
		t.Fatalf("remaining Task Binding fenced the assignee %d times", fences)
	}
	if fences := documentDisconnects(t, env, lostDocumentID, "actor_acme_official"); fences != 0 {
		t.Fatalf("Task Binding removal fenced the Agent %d times", fences)
	}
}

func TestUnifiedDocumentTaskAccessGrantMutationsKeepAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_grant_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document access grant','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-grant-upload-"+suffix,
		map[string]string{
			"filename": "task-grant.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-grant.txt", []byte("Task grant evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	grantKey := "task-access-grant-" + suffix
	status, _, body = env.request(alice, http.MethodPut,
		"/v0/work-items/"+workItemID+"/access-grants/actor_acme_official", nil, grantKey)
	if status != http.StatusOK {
		t.Fatalf("put Task access grant status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPut,
		"/v0/work-items/"+workItemID+"/access-grants/actor_acme_official", nil, grantKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("put Task access grant replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	grantedCount := documentPermissionCount(t, env, created.ID)
	if grantedCount < 1 {
		t.Fatalf("granted Task access left the permission count at %d", grantedCount)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("granted Task access fenced the Agent %d times", fences)
	}
	revokeKey := "task-access-revoke-" + suffix
	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/access-grants/actor_acme_official", nil, revokeKey)
	if status != http.StatusNoContent {
		t.Fatalf("delete Task access grant status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/access-grants/actor_acme_official", nil, revokeKey)
	if status != http.StatusNoContent || replayHeaders.Get("Idempotent-Replay") != "true" || len(replayBody) != 0 {
		t.Fatalf("delete Task access grant replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if count := documentPermissionCount(t, env, created.ID); count <= grantedCount {
		t.Fatalf("revoked Task access left the permission count at %d", count)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("revoked Task access fenced the Agent %d times", fences)
	}
	var accessEvents int
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.access_invalidated'`, created.ID).Scan(&accessEvents); err != nil {
		t.Fatal(err)
	}
	if accessEvents != 2 {
		t.Fatalf("grant/revoke access events=%d want 2", accessEvents)
	}
}

func TestUnifiedDocumentTaskAssignmentMutationsKeepAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_assignment_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document assignment access','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-assignment-upload-"+suffix,
		map[string]string{
			"filename": "task-assignment.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-assignment.txt", []byte("Task assignment evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	assignmentKey := "task-access-assignment-" + suffix
	status, _, body = env.request(alice, http.MethodPut,
		"/v0/work-items/"+workItemID+"/assignments/actor_acme_official", nil, assignmentKey)
	if status != http.StatusOK {
		t.Fatalf("put Task assignment status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPut,
		"/v0/work-items/"+workItemID+"/assignments/actor_acme_official", nil, assignmentKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("put Task assignment replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	assignedCount := documentPermissionCount(t, env, created.ID)
	if assignedCount < 1 {
		t.Fatalf("assigned Task access left the permission count at %d", assignedCount)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("assigned Task access fenced the Agent %d times", fences)
	}
	revokeKey := "task-access-unassign-added-" + suffix
	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/assignments/actor_acme_official", nil, revokeKey)
	if status != http.StatusNoContent {
		t.Fatalf("delete Task assignment status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/assignments/actor_acme_official", nil, revokeKey)
	if status != http.StatusNoContent || replayHeaders.Get("Idempotent-Replay") != "true" || len(replayBody) != 0 {
		t.Fatalf("delete Task assignment replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if count := documentPermissionCount(t, env, created.ID); count <= assignedCount {
		t.Fatalf("unassigned Task access left the permission count at %d", count)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("unassignment fenced the Agent %d times", fences)
	}
}

func TestUnifiedDocumentRoomDeletionKeepsAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice,
		"Document delivery deletion fence "+suffix, "document-delivery-delete-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Room member status=%d body=%s", status, body)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+roomID+"/documents/uploads", "room-delivery-delete-upload-"+suffix,
		map[string]string{
			"filename": "deletion-fence.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "deletion-fence.txt", []byte("Room deletion delivery fence evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Room typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	if !agentCanReadDocument(t, env, acmeOfficialAgentManagementID, created.ID) {
		t.Fatal("Room member Agent cannot read the Room Document before deletion")
	}

	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil,
		"room-delivery-delete-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("begin Room deletion status=%d body=%s", status, body)
	}
	// The deletion revokes every membership and finishes in its transaction.
	if got := countRows(t, env, `SELECT count(*) FROM room_members WHERE room_id=$1`, roomID); got != 0 {
		t.Fatalf("Room memberships after deletion=%d want=0", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NOT NULL`, roomID); got != 1 {
		t.Fatalf("finished Room deletions=%d want=1", got)
	}
	if !agentCanReadDocument(t, env, acmeOfficialAgentManagementID, created.ID) {
		t.Fatal("the Agent lost its Human's access when the Room was deleted")
	}

	if got := countRows(t, env, `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.access_invalidated'`, created.ID); got != 1 {
		// One invalidation per Document and transaction, however many members lose access.
		t.Fatalf("Room deletion access events=%d want 1", got)
	}
}

func TestUnifiedDocumentTaskDescriptionReferenceMutationsKeepAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	createKey := "task-reference-create-" + suffix
	status, _, body := env.request(alice, http.MethodPost,
		"/v0/tenants/"+acmeTenant+"/work-items", map[string]any{
			"kind": "issue", "title": "Document reference " + suffix,
			"referenced_actor_ids": []string{"actor_acme_official"},
		}, createKey)
	if status != http.StatusCreated {
		t.Fatalf("create referenced Work Item status=%d body=%s", status, body)
	}
	var workItem workItemResponse
	decode(t, body, &workItem)
	status, _, body = requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItem.ID+"/documents/uploads", "task-reference-upload-"+suffix,
		map[string]string{
			"filename": "task-reference.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-reference.txt", []byte("Task structured reference evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("referenced Agent access fences=%d", fences)
	}
	updateKey := "task-reference-remove-" + suffix
	updatePayload := map[string]any{
		"expected_version":     workItem.Version,
		"referenced_actor_ids": []string{},
	}
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/work-items/"+workItem.ID, updatePayload, updateKey)
	if status != http.StatusOK {
		t.Fatalf("remove Work Item reference status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPatch,
		"/v0/work-items/"+workItem.ID, updatePayload, updateKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("remove Work Item reference replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("removed reference fenced the Agent %d times", fences)
	}
}

func TestUnifiedDocumentTaskCommentReferenceCreateAndUpdateKeepAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_comment_reference_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document comment reference','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-comment-reference-upload-"+suffix,
		map[string]string{
			"filename": "task-comment-reference.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-comment-reference.txt", []byte("Task comment reference evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	commentPayload := map[string]any{
		"body": "Review @official",
		"segments": []map[string]any{
			{"type": "text", "content": "Review "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		},
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/comments", commentPayload,
		"task-comment-reference-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create referenced Comment status=%d body=%s", status, body)
	}
	var comment workItemCommentResponse
	decode(t, body, &comment)
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("comment-referenced Agent access fences=%d", fences)
	}
	updatePayload := map[string]any{
		"expected_version": comment.Version,
		"body":             "Reference removed",
		"segments":         []map[string]any{{"type": "text", "content": "Reference removed"}},
	}
	updateKey := "task-comment-reference-remove-" + suffix
	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/work-items/"+workItemID+"/comments/"+comment.ID, updatePayload, updateKey)
	if status != http.StatusOK {
		t.Fatalf("remove Comment reference status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPatch,
		"/v0/work-items/"+workItemID+"/comments/"+comment.ID, updatePayload, updateKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("remove Comment reference replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("removed Comment reference fenced the Agent %d times", fences)
	}
}

func TestUnifiedDocumentTaskCommentReferenceDeleteKeepsAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_comment_delete_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document comment delete','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-comment-delete-upload-"+suffix,
		map[string]string{
			"filename": "task-comment-delete.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-comment-delete.txt", []byte("Task comment delete evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/comments", map[string]any{
			"body": "Delete @official",
			"segments": []map[string]any{
				{"type": "text", "content": "Delete "},
				{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
			},
		}, "task-comment-delete-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create referenced Comment status=%d body=%s", status, body)
	}
	var comment workItemCommentResponse
	decode(t, body, &comment)
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("comment-referenced Agent access fences=%d", fences)
	}
	deleteKey := "task-comment-reference-delete-" + suffix
	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/comments/"+comment.ID,
		map[string]any{"expected_version": comment.Version}, deleteKey)
	if status != http.StatusOK {
		t.Fatalf("delete referenced Comment status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodDelete,
		"/v0/work-items/"+workItemID+"/comments/"+comment.ID,
		map[string]any{"expected_version": comment.Version}, deleteKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(replayBody, body) {
		t.Fatalf("delete referenced Comment replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if fences := documentDisconnects(t, env, created.ID, "actor_acme_official"); fences != 0 {
		t.Fatalf("deleted Comment reference fenced the Agent %d times", fences)
	}
}

func TestUnifiedDocumentTaskResolveAndReopenRecomputeAllActorAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_resolve_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document resolve access','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_item_description_references(
		work_item_id,tenant_id,actor_id,ordinal
	) VALUES($1,$2,'actor_acme_official',0)`, workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-resolve-upload-"+suffix,
		map[string]string{
			"filename": "task-resolve.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-resolve.txt", []byte("Task resolve access evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/transitions", map[string]any{
			"expected_version": 1, "state": "resolved", "resolution": "completed",
		}, "task-document-resolve-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resolve Work Item status=%d body=%s", status, body)
	}
	var resolved workItemResponse
	decode(t, body, &resolved)
	// The owner keeps write through ownership; the assigned Agent loses it with
	// the resolved Task, so only its connection is fenced.
	for _, expected := range []struct {
		actorID string
		fences  int
	}{
		{actorID: "actor_acme_alice", fences: 0},
		{actorID: "actor_acme_official", fences: 0},
	} {
		if fences := documentDisconnects(t, env, created.ID, expected.actorID); fences != expected.fences {
			t.Fatalf("resolved access actor=%s fences=%d want %d", expected.actorID, fences, expected.fences)
		}
	}
	resolvedCount := documentPermissionCount(t, env, created.ID)
	reopenKey := "task-document-reopen-" + suffix
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/transitions", map[string]any{
			"expected_version": resolved.Version, "state": "open",
		}, reopenKey)
	if status != http.StatusOK {
		t.Fatalf("reopen Work Item status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/transitions", map[string]any{
			"expected_version": resolved.Version, "state": "open",
		}, reopenKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("reopen Work Item replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if count := documentPermissionCount(t, env, created.ID); count <= resolvedCount {
		t.Fatalf("reopened Task left the permission count at %d", count)
	}
	// Regaining write disconnects no one.
	for actorID, want := range map[string]int{"actor_acme_alice": 0, "actor_acme_official": 0} {
		if fences := documentDisconnects(t, env, created.ID, actorID); fences != want {
			t.Fatalf("reopened access actor=%s fences=%d", actorID, fences)
		}
	}
}
func TestUnifiedDocumentAgentTaskResolveRecomputesAllActorAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_agent_resolve_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Agent document resolve access','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_item_assignments(
		work_item_id,tenant_id,actor_id,assigned_by_actor_id
	) VALUES($1,$2,'actor_acme_official','actor_acme_alice')`, workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "agent-task-resolve-upload-"+suffix,
		map[string]string{
			"filename": "agent-task-resolve.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "agent-task-resolve.txt", []byte("Agent task resolve access evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	resolveKey := "agent-task-document-resolve-" + suffix
	agentPath := "/v0/agents/" + acmeOfficialAgentManagementID + "/work-items/" + workItemID + "/transitions"
	resolvePayload := map[string]any{
		"expected_version": 1, "state": "resolved", "resolution": "completed",
	}
	status, _, body = agentWorkItemRequest(
		t, env, http.MethodPost, agentPath, teamHubInternalToken, resolveKey, resolvePayload,
	)
	if status != http.StatusOK {
		t.Fatalf("Agent resolve Work Item status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := agentWorkItemRequest(
		t, env, http.MethodPost, agentPath, teamHubInternalToken, resolveKey, resolvePayload,
	)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("Agent resolve Work Item replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	for _, expected := range []struct {
		actorID string
		fences  int
	}{
		{actorID: "actor_acme_alice", fences: 0},
		{actorID: "actor_acme_official", fences: 0},
	} {
		if fences := documentDisconnects(t, env, created.ID, expected.actorID); fences != expected.fences {
			t.Fatalf("Agent-resolved access actor=%s fences=%d want %d", expected.actorID, fences, expected.fences)
		}
	}
}

func TestUnifiedDocumentActiveTenantHumanCanUploadToAgentCreatedTask(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Agent-created Task "+suffix, "agent-created-task-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	taskID, _ := createFixtureDelegatedTask(t, env, roomID, suffix)
	uploadKey := "agent-created-task-human-upload-" + suffix
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice,
		"/v0/work-items/"+taskID+"/documents/uploads", uploadKey,
		map[string]string{
			"filename": "agent-created-task.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "agent-created-task.txt", []byte("Active Tenant Human upload evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("active Tenant Human Task upload status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody := requestUnifiedDocumentMultipart(
		t, env, alice,
		"/v0/work-items/"+taskID+"/documents/uploads", uploadKey,
		map[string]string{
			"filename": "agent-created-task.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "agent-created-task.txt", []byte("Active Tenant Human upload evidence"),
	)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("active Tenant Human Task upload replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
}

func TestUnifiedDocumentTaskArchiveAndUnarchiveRecomputeAllActorAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	workItemID := "work_item_document_archive_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Document archive access','actor_acme_alice','actor_acme_alice')`,
		workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_item_description_references(
		work_item_id,tenant_id,actor_id,ordinal
	) VALUES($1,$2,'actor_acme_official',0)`, workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/work-items/"+workItemID+"/documents/uploads", "task-archive-upload-"+suffix,
		map[string]string{
			"filename": "task-archive.txt", "representation_format": "plain_text", "media_type": "text/plain",
		}, "task-archive.txt", []byte("Task archive access evidence"),
	)
	if status != http.StatusCreated {
		t.Fatalf("Task typed upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	archiveKey := "task-document-archive-" + suffix
	archivePayload := map[string]any{"expected_version": 1}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/archive", archivePayload, archiveKey)
	if status != http.StatusOK {
		t.Fatalf("archive Work Item status=%d body=%s", status, body)
	}
	var archived workItemResponse
	decode(t, body, &archived)
	status, replayHeaders, replayBody := env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/archive", archivePayload, archiveKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("archive Work Item replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	for _, expected := range []struct {
		actorID string
		fences  int
	}{
		{actorID: "actor_acme_alice", fences: 0},
		{actorID: "actor_acme_official", fences: 0},
	} {
		if fences := documentDisconnects(t, env, created.ID, expected.actorID); fences != expected.fences {
			t.Fatalf("archived Task access actor=%s fences=%d want %d", expected.actorID, fences, expected.fences)
		}
	}
	archivedCount := documentPermissionCount(t, env, created.ID)
	unarchiveKey := "task-document-unarchive-" + suffix
	unarchivePayload := map[string]any{"expected_version": archived.Version}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/unarchive", unarchivePayload, unarchiveKey)
	if status != http.StatusOK {
		t.Fatalf("unarchive Work Item status=%d body=%s", status, body)
	}
	status, replayHeaders, replayBody = env.request(alice, http.MethodPost,
		"/v0/work-items/"+workItemID+"/unarchive", unarchivePayload, unarchiveKey)
	if status != http.StatusOK || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("unarchive Work Item replay status=%d replay=%q body=%s",
			status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	if count := documentPermissionCount(t, env, created.ID); count <= archivedCount {
		t.Fatalf("unarchived Task left the permission count at %d", count)
	}
	// Regaining write disconnects no one.
	for actorID, want := range map[string]int{"actor_acme_alice": 0, "actor_acme_official": 0} {
		if fences := documentDisconnects(t, env, created.ID, actorID); fences != want {
			t.Fatalf("unarchived Task access actor=%s fences=%d", actorID, fences)
		}
	}
}

func TestUnifiedDocumentPersonalWikiDeleteSuspendsBindingsAndRecomputesAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	// Reading the Wiki never creates its root; the first source upload does.
	wikiID, _, _ := seedUnifiedWikiPublicAdmission(t, env, alice,
		strconv.FormatInt(time.Now().UnixNano(), 36), false)

	var deletedBefore bool
	var bindingsBefore, permissionCountBefore, fencesBefore, eventsBefore int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT deleted_at IS NOT NULL FROM personal_wikis WHERE id=$1),
		(SELECT count(*) FROM document_context_bindings WHERE wiki_id=$1),
		(SELECT coalesce(sum(permission_count),0) FROM document_permission_counts),
		(SELECT count(*) FROM river_job WHERE kind='document.runtime_disconnect'),
		(SELECT count(*) FROM document_events)
	`, wikiID).Scan(
		&deletedBefore, &bindingsBefore, &permissionCountBefore, &fencesBefore, &eventsBefore,
	); err != nil {
		t.Fatal(err)
	}

	path := "/v0/tenants/" + acmeTenant + "/personal-wiki"
	for _, key := range []string{"forbidden-wiki-delete-first", "forbidden-wiki-delete-replay"} {
		status, _, body := env.request(alice, http.MethodDelete, path, nil, key)
		if status != http.StatusNotFound {
			t.Fatalf("Human Personal Wiki DELETE status=%d body=%s", status, body)
		}
	}

	var deletedAfter bool
	var bindingsAfter, permissionCountAfter, fencesAfter, eventsAfter int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT deleted_at IS NOT NULL FROM personal_wikis WHERE id=$1),
		(SELECT count(*) FROM document_context_bindings WHERE wiki_id=$1),
		(SELECT coalesce(sum(permission_count),0) FROM document_permission_counts),
		(SELECT count(*) FROM river_job WHERE kind='document.runtime_disconnect'),
		(SELECT count(*) FROM document_events)
	`, wikiID).Scan(
		&deletedAfter, &bindingsAfter, &permissionCountAfter, &fencesAfter, &eventsAfter,
	); err != nil {
		t.Fatal(err)
	}
	if deletedBefore || deletedAfter || bindingsAfter != bindingsBefore ||
		permissionCountAfter != permissionCountBefore || fencesAfter != fencesBefore || eventsAfter != eventsBefore {
		t.Fatalf("forbidden Wiki DELETE changed state deleted=%t/%t bindings=%d/%d permission counts=%d/%d fences=%d/%d events=%d/%d",
			deletedBefore, deletedAfter, bindingsBefore, bindingsAfter, permissionCountBefore, permissionCountAfter,
			fencesBefore, fencesAfter, eventsBefore, eventsAfter)
	}
}
func TestUnifiedDocumentLifecycleTrashesAndRestoresBindings(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	insertUnifiedDocumentContextFixture(t, ctx, db)
	if _, err := db.ExecContext(ctx, `
	INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
	VALUES('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a')
	ON CONFLICT DO NOTHING;
	INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES('binding_lifecycle_room','tenant_document_a','document_human_a','room','room_document_a','active');
	INSERT INTO document_placements(
		id,tenant_id,scope_kind,owner_human_actor_id,node_kind,name,sort_key
	) VALUES(
		'placement_lifecycle_folder','tenant_document_a','personal','actor_human_a','folder',
		'Lifecycle folder','folder'
	);
	INSERT INTO document_placements(
		id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,parent_id,sort_key
	) VALUES(
		'placement_lifecycle_document','tenant_document_a','personal','actor_human_a','document',
		'document_human_a','placement_lifecycle_folder','document'
		)`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)
	trashInput := document.TrashDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
	}
	if err := service.Trash(ctx, trashInput); err != nil {
		t.Fatalf("trash error=%v", err)
	}
	if err := service.Trash(ctx, trashInput); err != nil {
		t.Fatalf("trash replay error=%v", err)
	}
	var documentStatus, trashBindingStatus string
	var documentEventCount, disconnects int
	var permissionCount int64
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT status FROM documents WHERE id='document_human_a'),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a'),
		(SELECT status FROM document_context_bindings WHERE id='binding_lifecycle_room'),
		(SELECT permission_count FROM document_permission_counts WHERE document_id='document_human_a'),
		(SELECT count(*) FROM river_job WHERE kind='document.runtime_disconnect'
		  AND args->>'document_id'='document_human_a' AND NOT args ? 'actor_id')
	`).Scan(&documentStatus, &documentEventCount, &trashBindingStatus, &permissionCount, &disconnects); err != nil {
		t.Fatal(err)
	}
	// The trash commits at once and closes every connection after commit; the
	// new permission count keeps tokens issued before the trash from opening
	// after a restore. The replay changes nothing.
	if documentStatus != "trashed" || trashBindingStatus != "suspended" || permissionCount < 1 ||
		documentEventCount != 3 || disconnects != 1 {
		t.Fatalf("trash status=%s binding=%s permission count=%d events=%d disconnects=%d",
			documentStatus, trashBindingStatus, permissionCount, documentEventCount, disconnects)
	}
	if _, err := service.Get(ctx, "account_document_a", "document_human_a"); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("get trashed Document error=%v want not found", err)
	}
	var trashedRecentOpenCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_recent_opens
		WHERE document_id='document_human_a'`).Scan(&trashedRecentOpenCount); err != nil {
		t.Fatal(err)
	}
	if trashedRecentOpenCount != 0 {
		t.Fatalf("trashed Document Get recorded %d recent opens", trashedRecentOpenCount)
	}
	tree, err := service.GetMyTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 1 || tree[0].ID != "placement_lifecycle_folder" {
		t.Fatalf("trashed Document leaked into My Documents tree=%+v error=%v", tree, err)
	}
	if err := service.DeleteFolder(ctx, document.DeleteFolderInput{
		AccountID: "account_document_a", PlacementID: "placement_lifecycle_folder",
	}); !errors.Is(err, document.ErrFolderNotEmpty) {
		t.Fatalf("delete folder containing trashed Document error=%v want folder not empty", err)
	}
	restoreInput := document.RestoreDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
	}
	if err := service.Restore(ctx, restoreInput); err != nil {
		t.Fatalf("restore error=%v", err)
	}
	if err := service.Restore(ctx, restoreInput); err != nil {
		t.Fatalf("restore replay error=%v", err)
	}
	for _, eventType := range []string{"document.trashed", "document.restored"} {
		var resourceID string
		if err := db.QueryRowContext(ctx, `SELECT resource_id FROM document_events
			WHERE document_id='document_human_a' AND event_type=$1`, eventType).Scan(&resourceID); err != nil {
			t.Fatal(err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, insertErr := tx.ExecContext(ctx, `INSERT INTO document_events(
			id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version
		) VALUES(
			'duplicate_' || $1,'tenant_document_a','document_human_a',
			$1,'actor_human_a','lifecycle_operation',$2,1
		)`, eventType, resourceID)
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			t.Fatal(rollbackErr)
		}
		if insertErr == nil {
			t.Errorf("Document lifecycle command emitted duplicate %s events", eventType)
		} else if !strings.Contains(insertErr.Error(), "document_lifecycle_terminal_event_once") {
			t.Fatalf("duplicate %s event failed for an unrelated reason: %v", eventType, insertErr)
		}
	}
	var bindingStatus string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT status FROM documents WHERE id='document_human_a'),
		(SELECT status FROM document_context_bindings WHERE id='binding_lifecycle_room'),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a')
	`).Scan(&documentStatus, &bindingStatus, &documentEventCount); err != nil {
		t.Fatal(err)
	}
	if documentStatus != "active" || bindingStatus != "suspended" || documentEventCount != 4 {
		t.Fatalf("restored status=%s binding=%s events=%d", documentStatus, bindingStatus, documentEventCount)
	}
	var agentAccess int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM resolve_agent_document_access_v2('agent_document_a','document_human_a') WHERE can_read`).Scan(&agentAccess); err != nil {
		t.Fatal(err)
	}
	if agentAccess != 1 {
		t.Fatal("the Agent lost its Human's access to the restored Document")
	}
	tree, err = service.GetMyTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 2 || tree[1].ID != "placement_lifecycle_document" ||
		tree[1].ParentID == nil || *tree[1].ParentID != "placement_lifecycle_folder" {
		t.Fatalf("restored My Documents tree=%+v error=%v", tree, err)
	}
}

func TestUnifiedDocumentLifecyclePublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	documentID := "document_http_lifecycle_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,'tenant_acme','HTTP lifecycle','blocknote','actor_acme_alice','human',
		 'actor_acme_alice','human','active')`, documentID); err != nil {
		t.Fatal(err)
	}

	// Trash and restore are idempotent by state: repeating one changes nothing.
	for _, attempt := range []string{"trash", "repeated trash"} {
		status, _, body := env.request(alice, http.MethodDelete, "/v0/documents/"+documentID, nil, "")
		if status != http.StatusNoContent || len(body) != 0 {
			t.Fatalf("%s status=%d body=%s", attempt, status, body)
		}
	}
	for _, attempt := range []string{"restore", "repeated restore"} {
		status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+documentID+"/restore", nil, "")
		if status != http.StatusNoContent {
			t.Fatalf("%s status=%d body=%s", attempt, status, body)
		}
	}
}

func TestUnifiedDocumentCreateBlankPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, "")
	if status != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", status, body)
	}
	var created struct {
		ID             string `json:"id"`
		Title          string `json:"title"`
		Format         string `json:"format"`
		Representation string `json:"representation_format"`
		CurrentVersion any    `json:"current_version"`
	}
	decode(t, body, &created)
	if created.ID == "" || created.Title != "untitled" || created.Format != "blocknote" ||
		created.Representation != "markdown" || created.CurrentVersion != nil {
		t.Fatalf("created=%+v body=%s", created, body)
	}

	status, _, treeBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/me/document-tree", nil, "")
	if status != http.StatusOK || !strings.Contains(string(treeBody), `"document_id":"`+created.ID+`"`) {
		t.Fatalf("tree status=%d body=%s", status, treeBody)
	}
	var tree struct {
		Items []struct {
			ID         string `json:"id"`
			DocumentID string `json:"document_id"`
		} `json:"items"`
	}
	decode(t, treeBody, &tree)
	if len(tree.Items) != 1 || tree.Items[0].DocumentID != created.ID {
		t.Fatalf("created Document placement tree=%+v", tree.Items)
	}
	status, _, ownerFolderBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/me/document-folders", map[string]any{
		"name": "Owner Folder " + suffix,
	}, "http-create-owner-folder-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("owner folder status=%d body=%s", status, ownerFolderBody)
	}
	var ownerFolder struct {
		ID string `json:"id"`
	}
	decode(t, ownerFolderBody, &ownerFolder)
	status, _, moveBody := env.request(alice, http.MethodPatch,
		"/v0/tenants/"+acmeTenant+"/me/document-placements/"+tree.Items[0].ID, map[string]any{
			"parent_id": ownerFolder.ID,
		}, "")
	if status != http.StatusOK || !strings.Contains(string(moveBody), `"parent_id":"`+ownerFolder.ID+`"`) {
		t.Fatalf("move Document placement status=%d body=%s", status, moveBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_events
		WHERE document_id=$1 AND event_type='document.placement_updated'`, created.ID); got != 1 {
		t.Fatalf("Document placement events=%d want 1", got)
	}

	status, _, unknownBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{
		"unknown": true,
	}, "http-create-unknown-json-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("unknown JSON status=%d body=%s", status, unknownBody)
	}

	var documentCount, revisionCount, draftCount, versionCount, placementCount, eventCount int
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM documents WHERE id=$1),
		(SELECT count(*) FROM document_revisions WHERE document_id=$1),
		(SELECT count(*) FROM document_bodies WHERE document_id=$1),
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_placements WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1)
	`, created.ID).Scan(&documentCount, &revisionCount, &draftCount, &versionCount, &placementCount,
		&eventCount); err != nil {
		t.Fatal(err)
	}
	if documentCount != 1 || revisionCount != 1 || draftCount != 1 || versionCount != 0 ||
		placementCount != 1 || eventCount != 2 {
		t.Fatalf("aggregate documents=%d revisions=%d drafts=%d versions=%d placements=%d events=%d",
			documentCount, revisionCount, draftCount, versionCount, placementCount, eventCount)
	}
}

func TestUnifiedDocumentCreateNativeRepresentationFormatsPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	createdIDs := map[string]string{}
	for _, format := range []string{"markdown", "html"} {
		t.Run(format, func(t *testing.T) {
			status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{
				"representation_format": format,
			}, "native-representation-"+format)
			var created struct {
				ID                   string `json:"id"`
				Title                string `json:"title"`
				Format               string `json:"format"`
				RepresentationFormat string `json:"representation_format"`
				DraftCapability      string `json:"draft_capability"`
				CurrentVersion       any    `json:"current_version"`
			}
			decode(t, body, &created)
			if status != http.StatusCreated || created.ID == "" || created.Title != "untitled" ||
				created.Format != "blocknote" || created.RepresentationFormat != format ||
				created.DraftCapability != "write" || created.CurrentVersion != nil {
				t.Fatalf("create native %s status=%d created=%+v body=%s", format, status, created, body)
			}
			createdIDs[format] = created.ID
		})
	}
	status, _, searchBody := env.request(alice, http.MethodGet,
		"/v0/library/documents/search?q=untitled&limit=50", nil, "")
	var search struct {
		Items []struct {
			ID                   string `json:"id"`
			RepresentationFormat string `json:"representation_format"`
		} `json:"items"`
	}
	decode(t, searchBody, &search)
	found := map[string]string{}
	for _, item := range search.Items {
		found[item.ID] = item.RepresentationFormat
	}
	if status != http.StatusOK || found[createdIDs["html"]] != "html" || found[createdIDs["markdown"]] != "markdown" {
		t.Fatalf("native search status=%d result=%+v body=%s", status, search, searchBody)
	}
}

func TestUnifiedDocumentRoomCreateIsSingleAggregate(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	roomID := env.createRoom(alice, acmeTenant, "Native Document "+suffix, "native-document-room-"+suffix)

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "")
	if status != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", status, body)
	}
	var created struct {
		ID             string `json:"id"`
		Title          string `json:"title"`
		Format         string `json:"format"`
		Representation string `json:"representation_format"`
		CurrentVersion any    `json:"current_version"`
		Owner          struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"owner"`
		From []struct {
			BindingKind string `json:"binding_kind"`
			ContextID   string `json:"context_id"`
		} `json:"from"`
	}
	decode(t, body, &created)
	if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND role='editor'`, created.ID, roomID); got != 1 {
		t.Fatalf("Human Room create editor bindings=%d", got)
	}

	if created.ID == "" || created.Title != "untitled" || created.Format != "blocknote" ||
		created.Representation != "markdown" ||
		created.CurrentVersion != nil || created.Owner.ID != "actor_acme_alice" ||
		created.Owner.Kind != "human" || len(created.From) != 1 ||
		created.From[0].BindingKind != "room" || created.From[0].ContextID != roomID {
		t.Fatalf("created=%+v body=%s", created, body)
	}

	status, _, getBody := env.request(alice, http.MethodGet, "/v0/documents/"+created.ID, nil, "")
	if status != http.StatusOK || string(getBody) != string(body) {
		t.Fatalf("get status=%d equal=%t body=%s", status, string(getBody) == string(body), getBody)
	}
	status, _, credentialBody := env.request(alice, http.MethodPost,
		"/v0/documents/"+created.ID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("collaboration credential status=%d body=%s", status, credentialBody)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, credentialBody, &credential)
	if credential.DocumentID != created.ID || len(credential.CollaborationCredential) < 32 ||
		credential.claims(t).ActorID != "actor_acme_alice" {
		t.Fatalf("collaboration credential=%+v body=%s", credential, credentialBody)
	}
	opened, ok := loadRuntimeDocumentBody(t, env, credential.DocumentID)
	if !ok || opened.PermissionCount != credential.claims(t).PermissionCount || opened.Seq != 0 {
		t.Fatalf("loaded body=%+v ok=%t", opened, ok)
	}
	if _, ok := loadRuntimeDocumentBody(t, env, "document_missing_"+suffix); ok {
		t.Fatal("the Runtime loaded a missing Document")
	}

	var documents, revisions, drafts, versions, bindings, placements, events int
	var placementOwnerID, placementParentID string
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM documents WHERE id=$1),
		(SELECT count(*) FROM document_revisions WHERE document_id=$1),
		(SELECT count(*) FROM document_bodies WHERE document_id=$1),
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id=$1 AND binding_kind='room' AND room_id=$2 AND status='active'),
		(SELECT count(*) FROM document_placements WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1),
		(SELECT owner_human_actor_id FROM document_placements WHERE document_id=$1),
		(SELECT coalesce(parent_id,'') FROM document_placements WHERE document_id=$1)
	`, created.ID, roomID).Scan(&documents, &revisions, &drafts, &versions, &bindings,
		&placements, &events,
		&placementOwnerID, &placementParentID); err != nil {
		t.Fatal(err)
	}
	if documents != 1 || revisions != 1 || drafts != 1 || versions != 0 || bindings != 1 ||
		placements != 1 || placementOwnerID != "actor_acme_alice" || placementParentID != "" ||
		events != 1 {
		// A new Document has no connection token to invalidate: its only event is the creation.
		t.Fatalf("aggregate documents=%d revisions=%d drafts=%d versions=%d bindings=%d placements=%d placement=%s/%q events=%d",
			documents, revisions, drafts, versions, bindings, placements, placementOwnerID,
			placementParentID, events)
	}
}

func TestUnifiedDocumentRoomCreateFailsClosed(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	aliceRoomID := env.createRoom(alice, acmeTenant, "Alice native Document "+suffix, "alice-native-document-room-"+suffix)
	key := "native-room-document-fail-closed-" + suffix

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+aliceRoomID+"/documents", map[string]any{}, key)
	if status != http.StatusCreated {
		t.Fatalf("seed create status=%d body=%s", status, body)
	}
	for _, attempt := range []struct {
		name, roomID, key string
		body              any
		want              int
	}{
		{name: "unknown-room", roomID: "room_missing_" + suffix, key: "native-room-document-missing-" + suffix, body: map[string]any{}, want: http.StatusNotFound},
		{name: "unknown-field", roomID: aliceRoomID, key: "native-room-document-unknown-" + suffix, body: map[string]any{"title": "forbidden"}, want: http.StatusBadRequest},
	} {
		t.Run(attempt.name, func(t *testing.T) {
			status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+attempt.roomID+"/documents", attempt.body, attempt.key)
			if status != attempt.want {
				t.Fatalf("status=%d want=%d body=%s", status, attempt.want, body)
			}
		})
	}
	if got := countRows(t, env, `SELECT count(*) FROM documents`); got != 1 {
		t.Fatalf("rejected Room creates changed Document count=%d want=1", got)
	}

	failingEnv, failingAlice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{failBlankMaterialization: true})
	failingRoomID := failingEnv.createRoom(failingAlice, acmeTenant, "Failing native Document "+suffix,
		"failing-native-document-room-"+suffix)
	status, _, body = failingEnv.request(failingAlice, http.MethodPost, "/v0/rooms/"+failingRoomID+"/documents",
		map[string]any{}, "native-room-document-runtime-failure-"+suffix)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("Runtime failure status=%d body=%s", status, body)
	}
	var documents, revisions, drafts, bindings, events, idempotency int
	if err := failingEnv.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM documents),
		(SELECT count(*) FROM document_revisions),
		(SELECT count(*) FROM document_bodies),
		(SELECT count(*) FROM document_context_bindings),
		(SELECT count(*) FROM document_events),
		(SELECT count(*) FROM command_replays WHERE operation='document.create.room')
	`).Scan(&documents, &revisions, &drafts, &bindings, &events, &idempotency); err != nil {
		t.Fatal(err)
	}
	if documents != 0 || revisions != 0 || drafts != 0 || bindings != 0 || events != 0 || idempotency != 0 {
		t.Fatalf("Runtime failure partial state documents=%d revisions=%d drafts=%d bindings=%d events=%d keys=%d",
			documents, revisions, drafts, bindings, events, idempotency)
	}
}

func TestUnifiedDocumentUploadPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	key := "http-upload-document-" + suffix
	content := []byte("ordinary Document upload")
	fields := map[string]string{
		"filename": "upload.txt", "representation_format": "plain_text", "media_type": "text/plain",
	}
	status, headers, body := requestUnifiedDocumentUpload(t, env, alice, key, fields, "upload.txt", content)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("upload status=%d replay=%q body=%s", status, headers.Get("Idempotent-Replay"), body)
	}
	var created struct {
		ID              string `json:"id"`
		Title           string `json:"title"`
		Format          string `json:"format"`
		DraftCapability string `json:"draft_capability"`
		CurrentVersion  *struct {
			ID string `json:"id"`
		} `json:"current_version"`
	}
	decode(t, body, &created)
	if created.ID == "" || created.Title != "upload.txt" || created.Format != "plain_text" ||
		created.DraftCapability != "none" || created.CurrentVersion == nil {
		t.Fatalf("created=%+v body=%s", created, body)
	}
	status, headers, replayBody := requestUnifiedDocumentUpload(t, env, alice, key, fields, "upload.txt", content)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" || string(replayBody) != string(body) {
		t.Fatalf("replay status=%d replay=%q equal=%t body=%s", status,
			headers.Get("Idempotent-Replay"), string(replayBody) == string(body), replayBody)
	}
	unknownFields := map[string]string{
		"filename": "unknown.txt", "representation_format": "plain_text", "unknown": "rejected",
	}
	status, _, invalidBody := requestUnifiedDocumentUpload(
		t, env, alice, "http-upload-unknown-"+suffix, unknownFields, "unknown.txt", content,
	)
	if status != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d body=%s", status, invalidBody)
	}
	status, _, invalidBody = requestUnifiedDocumentUpload(
		t, env, alice, "http-upload-missing-file-"+suffix, fields, "", nil,
	)
	if status != http.StatusBadRequest {
		t.Fatalf("missing file status=%d body=%s", status, invalidBody)
	}
	status, _, tooLargeBody := requestUnifiedDocumentUpload(
		t, env, alice, "http-upload-too-large-"+suffix, fields, "large.bin", make([]byte, (1<<20)+1),
	)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large status=%d body=%s", status, tooLargeBody)
	}
	emptyFields := map[string]string{
		"filename": "empty.bin", "representation_format": "binary",
	}
	status, _, emptyBody := requestUnifiedDocumentUpload(
		t, env, alice, "http-upload-empty-"+suffix, emptyFields, "empty.bin", []byte{},
	)
	if status != http.StatusCreated {
		t.Fatalf("empty upload status=%d body=%s", status, emptyBody)
	}

	var versionCount, revisionCount, draftCount, placementCount, eventCount int
	var objectKey, mediaType string
	var sizeBytes int64
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_revisions WHERE document_id=$1),
		(SELECT count(*) FROM document_bodies WHERE document_id=$1),
		(SELECT count(*) FROM document_placements WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1),
		(SELECT content_object_id FROM document_versions WHERE document_id=$1),
		(SELECT media_type FROM document_versions WHERE document_id=$1),
		(SELECT size_bytes FROM document_versions WHERE document_id=$1)
	`, created.ID).Scan(&versionCount, &revisionCount, &draftCount, &placementCount, &eventCount,
		&objectKey, &mediaType, &sizeBytes); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(env.artifactRoot, objectKey))
	if err != nil {
		t.Fatal(err)
	}
	if versionCount != 1 || revisionCount != 0 || draftCount != 0 || placementCount != 1 ||
		eventCount != 1 || mediaType != "text/plain" || sizeBytes != int64(len(content)) ||
		!bytes.Equal(stored, content) {
		t.Fatalf("aggregate versions=%d revisions=%d drafts=%d placements=%d events=%d media=%s size=%d stored_equal=%t",
			versionCount, revisionCount, draftCount, placementCount, eventCount,
			mediaType, sizeBytes, bytes.Equal(stored, content))
	}

	replacementFields := map[string]string{
		"expected_current_version_id": created.CurrentVersion.ID,
		"filename":                    "upload-v2.txt",
		"representation_format":       "plain_text",
		"media_type":                  "text/plain",
	}
	replacementKey := "http-replace-document-" + suffix
	status, headers, replacementBody := requestUnifiedDocumentVersionUpload(
		t, env, alice, created.ID, replacementKey, replacementFields, "upload-v2.txt", []byte("v2"),
	)
	var replacement struct {
		ID            string  `json:"id"`
		VersionNumber int     `json:"version_number"`
		Source        string  `json:"source"`
		BaseVersionID *string `json:"base_version_id"`
	}
	decode(t, replacementBody, &replacement)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "" ||
		replacement.ID == "" || replacement.VersionNumber != 2 || replacement.Source != "replacement_upload" ||
		replacement.BaseVersionID == nil || *replacement.BaseVersionID != created.CurrentVersion.ID {
		t.Fatalf("replacement status=%d replay=%q value=%+v body=%s",
			status, headers.Get("Idempotent-Replay"), replacement, replacementBody)
	}
	status, headers, replayBody = requestUnifiedDocumentVersionUpload(
		t, env, alice, created.ID, replacementKey, replacementFields, "upload-v2.txt", []byte("v2"),
	)
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" ||
		string(replayBody) != string(replacementBody) {
		t.Fatalf("replacement replay status=%d replay=%q equal=%t body=%s", status,
			headers.Get("Idempotent-Replay"), string(replayBody) == string(replacementBody), replayBody)
	}
	status, _, staleBody := requestUnifiedDocumentVersionUpload(
		t, env, alice, created.ID, "http-replace-stale-"+suffix, replacementFields,
		"stale.txt", []byte("stale"),
	)
	if status != http.StatusConflict || !strings.Contains(string(staleBody), "DOCUMENT_VERSION_CONFLICT") {
		t.Fatalf("stale replacement status=%d body=%s", status, staleBody)
	}
	unknownReplacementFields := map[string]string{
		"expected_current_version_id": replacement.ID, "filename": "unknown.txt",
		"representation_format": "plain_text", "unknown": "rejected",
	}
	status, _, invalidReplacementBody := requestUnifiedDocumentVersionUpload(
		t, env, alice, created.ID, "http-replace-unknown-"+suffix,
		unknownReplacementFields, "unknown.txt", []byte("invalid"),
	)
	if status != http.StatusBadRequest {
		t.Fatalf("unknown replacement field status=%d body=%s", status, invalidReplacementBody)
	}
	emptyReplacementFields := map[string]string{
		"expected_current_version_id": replacement.ID,
		"filename":                    "upload-v3.txt",
		"representation_format":       "plain_text",
	}
	status, _, emptyReplacementBody := requestUnifiedDocumentVersionUpload(
		t, env, alice, created.ID, "http-replace-empty-"+suffix, emptyReplacementFields,
		"upload-v3.txt", []byte{},
	)
	var emptyReplacement struct {
		ID            string `json:"id"`
		VersionNumber int    `json:"version_number"`
	}
	decode(t, emptyReplacementBody, &emptyReplacement)
	if status != http.StatusCreated || emptyReplacement.VersionNumber != 3 {
		t.Fatalf("empty replacement status=%d value=%+v body=%s", status, emptyReplacement, emptyReplacementBody)
	}
	status, _, nativeBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{},
		"http-native-for-replace-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("native create status=%d body=%s", status, nativeBody)
	}
	var native struct {
		ID string `json:"id"`
	}
	decode(t, nativeBody, &native)
	nativeFields := map[string]string{
		"expected_current_version_id": "missing-version",
		"filename":                    "native.md",
		"representation_format":       "blocknote",
	}
	status, _, nativeBody = requestUnifiedDocumentVersionUpload(
		t, env, alice, native.ID, "http-replace-native-"+suffix, nativeFields,
		"native.md", []byte("native"),
	)
	if status != http.StatusBadRequest {
		t.Fatalf("native replacement status=%d body=%s", status, nativeBody)
	}
	var finalVersionCount, finalEventCount int
	var finalCurrentVersionID, finalTitle string
	var emptyReplacementSize int64
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1),
		(SELECT current_version_id FROM documents WHERE id=$1),
		(SELECT title FROM documents WHERE id=$1),
		(SELECT size_bytes FROM document_versions WHERE id=$2)
	`, created.ID, emptyReplacement.ID).Scan(&finalVersionCount, &finalEventCount,
		&finalCurrentVersionID, &finalTitle, &emptyReplacementSize); err != nil {
		t.Fatal(err)
	}
	if finalVersionCount != 3 || finalEventCount != 3 || finalCurrentVersionID != emptyReplacement.ID ||
		finalTitle != "upload-v3.txt" || emptyReplacementSize != 0 {
		t.Fatalf("final versions=%d events=%d current=%s title=%q empty_size=%d",
			finalVersionCount, finalEventCount, finalCurrentVersionID, finalTitle, emptyReplacementSize)
	}
	var opened, nativeOpened struct {
		CurrentVersion json.RawMessage `json:"current_version"`
	}
	status, _, openBody := env.request(alice, http.MethodPost, "/v0/documents/"+created.ID+"/open", nil, "")
	decode(t, openBody, &opened)
	_, _, currentVersionBody := env.request(alice, http.MethodGet, "/v0/document-versions/"+emptyReplacement.ID, nil, "")
	var openedVersion, currentVersion any
	if status != http.StatusOK || json.Unmarshal(opened.CurrentVersion, &openedVersion) != nil ||
		json.Unmarshal(currentVersionBody, &currentVersion) != nil || !reflect.DeepEqual(openedVersion, currentVersion) {
		t.Fatalf("open status=%d current Version=%s want %s", status, opened.CurrentVersion, currentVersionBody)
	}
	status, _, nativeOpenBody := env.request(alice, http.MethodPost, "/v0/documents/"+native.ID+"/open", nil, "")
	decode(t, nativeOpenBody, &nativeOpened)
	if status != http.StatusOK || nativeOpened.CurrentVersion != nil {
		t.Fatalf("native open status=%d body=%s", status, nativeOpenBody)
	}
	versionPath := "/v0/document-versions/" + created.CurrentVersion.ID
	status, _, versionBody := env.request(alice, http.MethodGet, versionPath, nil, "")
	if status != http.StatusOK || !strings.Contains(string(versionBody), `"version_number":1`) ||
		!strings.Contains(string(versionBody), `"source":"ordinary_upload"`) {
		t.Fatalf("old Version metadata status=%d body=%s", status, versionBody)
	}
	contentPath := versionPath + "/content"
	status, contentHeaders, downloaded := requestUnifiedDocumentVersionContent(
		t, env, alice, http.MethodHead, contentPath, nil,
	)
	wantETag := `"` + unifiedDocumentDigest(content) + `"`
	if status != http.StatusOK || len(downloaded) != 0 || contentHeaders.Get("ETag") != wantETag ||
		contentHeaders.Get("Content-Length") != strconv.Itoa(len(content)) ||
		contentHeaders.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("Version HEAD status=%d etag=%q length=%q ranges=%q body=%q", status,
			contentHeaders.Get("ETag"), contentHeaders.Get("Content-Length"),
			contentHeaders.Get("Accept-Ranges"), downloaded)
	}
	status, contentHeaders, downloaded = requestUnifiedDocumentVersionContent(
		t, env, alice, http.MethodGet, contentPath, nil,
	)
	if status != http.StatusOK || !bytes.Equal(downloaded, content) || contentHeaders.Get("Content-Type") != "text/plain" {
		t.Fatalf("Version download status=%d type=%q equal=%t", status,
			contentHeaders.Get("Content-Type"), bytes.Equal(downloaded, content))
	}
	status, contentHeaders, downloaded = requestUnifiedDocumentVersionContent(
		t, env, alice, http.MethodGet, contentPath, map[string]string{"Range": "bytes=1-7"},
	)
	if status != http.StatusPartialContent || !bytes.Equal(downloaded, content[1:8]) ||
		contentHeaders.Get("Content-Range") != fmt.Sprintf("bytes 1-7/%d", len(content)) {
		t.Fatalf("Version range status=%d range=%q body=%q", status,
			contentHeaders.Get("Content-Range"), downloaded)
	}
	status, _, downloaded = requestUnifiedDocumentVersionContent(
		t, env, alice, http.MethodGet, contentPath,
		map[string]string{"Range": "bytes=1-7", "If-Range": `"different"`},
	)
	if status != http.StatusOK || !bytes.Equal(downloaded, content) {
		t.Fatalf("Version If-Range fallback status=%d equal=%t", status, bytes.Equal(downloaded, content))
	}
	status, contentHeaders, _ = requestUnifiedDocumentVersionContent(
		t, env, alice, http.MethodGet, contentPath, map[string]string{"Range": "bytes=999-1000"},
	)
	if status != http.StatusRequestedRangeNotSatisfiable ||
		contentHeaders.Get("Content-Range") != fmt.Sprintf("bytes */%d", len(content)) {
		t.Fatalf("Version invalid range status=%d range=%q", status, contentHeaders.Get("Content-Range"))
	}
	if err := os.WriteFile(filepath.Join(env.artifactRoot, objectKey), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, _, corruptBody := requestUnifiedDocumentVersionContent(t, env, alice, http.MethodHead, contentPath, nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("corrupt Version object status=%d body=%s", status, corruptBody)
	}
}

func TestUnifiedDocumentNativeUploadsCreateDraftAndRetainHTMLSourceVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Native upload "+suffix, "native-upload-room-"+suffix)
	for _, testCase := range []struct {
		name, path, filename, format, mediaType, content string
	}{
		{name: "personal markdown", path: "/v0/tenants/" + acmeTenant + "/documents/uploads", filename: "brief.md", format: "markdown", mediaType: "text/markdown", content: "# Brief\n\nExact markdown.\n"},
		{name: "room html", path: "/v0/rooms/" + roomID + "/documents/uploads", filename: "brief.html", format: "html", mediaType: "text/html", content: "<h1>Brief</h1><p>Exact HTML.</p>"},
		{name: "room html embedded media", path: "/v0/rooms/" + roomID + "/documents/uploads", filename: "media.html", format: "html", mediaType: "text/html", content: `<h1>Media</h1><img src="data:image/png;base64,aW1hZ2U=">`},
		{name: "room styled html", path: "/v0/rooms/" + roomID + "/documents/uploads", filename: "styled.html", format: "html", mediaType: "text/html", content: `<!doctype html><html><head><style>.layout { display: grid; grid-template-columns: 1fr 1fr; color: #b91c1c; }</style></head><body><main class="layout"><h1>Styled HTML</h1><p>Second column</p></main></body></html>`},
		{name: "personal inline styled html", path: "/v0/tenants/" + acmeTenant + "/documents/uploads", filename: "inline.html", format: "html", mediaType: "text/html", content: `<main style="display: flex; gap: 24px"><h1>Inline CSS</h1><p>Second column</p></main>`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fields := map[string]string{"filename": testCase.filename, "representation_format": testCase.format, "media_type": testCase.mediaType}
			key := "native-upload-" + strings.ReplaceAll(testCase.name, " ", "-") + "-" + suffix
			status, _, body := requestUnifiedDocumentMultipart(t, env, alice, testCase.path,
				key, fields, testCase.filename, []byte(testCase.content))
			var created struct {
				ID                   string `json:"id"`
				Title                string `json:"title"`
				Format               string `json:"format"`
				RepresentationFormat string `json:"representation_format"`
				DraftCapability      string `json:"draft_capability"`
				CurrentVersion       any    `json:"current_version"`
			}
			decode(t, body, &created)
			if testCase.format == "html" {
				if status != http.StatusCreated || created.Format != "html" || created.DraftCapability != "none" || created.CurrentVersion == nil {
					t.Fatalf("styled HTML must retain its source Version: status=%d body=%s", status, body)
				}
				// HTML stays the uploaded file; nothing imports it.
				var imports, drafts, assets int
				if err := env.pool.QueryRow(t.Context(), `SELECT
					(SELECT count(*) FROM documents WHERE id=$1 AND native_import_status IS NOT NULL),
					(SELECT count(*) FROM document_bodies WHERE document_id=$1),
					(SELECT count(*) FROM document_assets WHERE document_id=$1)`,
					created.ID).Scan(&imports, &drafts, &assets); err != nil {
					t.Fatal(err)
				}
				if imports != 0 || drafts != 0 || assets != 0 {
					t.Fatalf("HTML upload imports=%d drafts=%d assets=%d", imports, drafts, assets)
				}
				downloadStatus, _, downloaded := env.request(alice, http.MethodGet,
					"/v0/documents/"+created.ID+"/downloads", nil, "")
				if downloadStatus != http.StatusOK || !bytes.Equal(downloaded, []byte(testCase.content)) {
					t.Fatalf("styled HTML download status=%d bytes=%q", downloadStatus, downloaded)
				}
				var previewDocument previewDocumentResponse
				decode(t, body, &previewDocument)
				previewStatus, _, previewBody := env.request(alice, http.MethodPost,
					"/v0/document-versions/"+previewDocument.CurrentVersion.ID+"/preview-sessions", map[string]any{}, "")
				if previewStatus != http.StatusCreated {
					t.Fatalf("styled HTML preview status=%d body=%s", previewStatus, previewBody)
				}
				var preview documentPreviewSessionResponse
				decode(t, previewBody, &preview)
				previewURL, err := url.Parse(preview.PreviewURL)
				if err != nil {
					t.Fatal(err)
				}
				previewStatus, previewHeaders, previewContent := documentPreviewContentRequest(t,
					env.server.URL+previewURL.Path, http.MethodGet, nil)
				if previewStatus != http.StatusOK || !bytes.Equal(previewContent, []byte(testCase.content)) {
					t.Fatalf("styled HTML preview status=%d bytes=%q", previewStatus, previewContent)
				}
				assertDocumentPreviewHeaders(t, previewHeaders)
				replayStatus, replayHeaders, replayBody := requestUnifiedDocumentMultipart(t, env, alice,
					testCase.path, key, fields, testCase.filename, []byte(testCase.content))
				if replayStatus != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
					t.Fatalf("styled HTML replay status=%d body=%s", replayStatus, replayBody)
				}
				return
			}
			expectedTitle := strings.TrimSuffix(testCase.filename, filepath.Ext(testCase.filename))
			if status != http.StatusCreated || created.ID == "" || created.Title != expectedTitle || created.Format != "blocknote" ||
				created.RepresentationFormat != testCase.format || created.DraftCapability != "write" || created.CurrentVersion != nil {
				var migrationStatus string
				_ = env.pool.QueryRow(t.Context(), `SELECT native_import_status
					FROM documents WHERE id=$1`, created.ID).Scan(&migrationStatus)
				t.Fatalf("native upload status=%d created=%+v migration=%s body=%s",
					status, created, migrationStatus, body)
			}
			replayStatus, replayHeaders, replayBody := requestUnifiedDocumentMultipart(t, env, alice,
				testCase.path, key, fields, testCase.filename, []byte(testCase.content))
			if replayStatus != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" ||
				!bytes.Equal(replayBody, body) {
				t.Fatalf("native replay status=%d replay=%q equal=%t body=%s",
					replayStatus, replayHeaders.Get("Idempotent-Replay"), bytes.Equal(replayBody, body), replayBody)
			}
			var revisions, drafts, versions, history, placements, bindings, assets int
			if err := env.pool.QueryRow(t.Context(), `SELECT
				(SELECT count(*) FROM document_revisions WHERE document_id=$1),
				(SELECT count(*) FROM document_bodies WHERE document_id=$1),
				(SELECT count(*) FROM document_versions WHERE document_id=$1),
				(SELECT count(*) FROM document_revisions WHERE document_id=$1 AND history_trigger IS NOT NULL),
				(SELECT count(*) FROM document_placements WHERE document_id=$1 AND owner_human_actor_id='actor_acme_alice'),
				(SELECT count(*) FROM document_context_bindings WHERE document_id=$1 AND room_id=$2 AND status='active'),
				(SELECT count(*) FROM document_assets WHERE document_id=$1 AND status='available')`,
				created.ID, roomID).Scan(&revisions, &drafts, &versions, &history, &placements, &bindings, &assets); err != nil {
				t.Fatal(err)
			}
			if revisions != 1 || drafts != 1 || versions != 0 || history != 0 || placements != 1 || bindings != 0 || assets != 0 {
				t.Fatalf("native aggregate revisions=%d drafts=%d versions=%d history=%d placements=%d bindings=%d assets=%d",
					revisions, drafts, versions, history, placements, bindings, assets)
			}
		})
	}
}

func TestUnifiedDocumentLegacyNativeImportMigrationRetriesAndCutsOverExactlyOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { _ = db.Close() })
	insertUnifiedDocumentIdentityFixture(t, ctx, db)
	root := t.TempDir()
	objects, err := artifactstore.NewLocalStore(root, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	source := []byte("# Legacy brief\n\nExact source bytes.\n")
	object, err := objects.Put(ctx, bytes.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
	) VALUES('document_legacy_native','tenant_document_a','legacy-brief.md','md',
		'actor_human_a','human','actor_human_a','human','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES('version_legacy_native','tenant_document_a','document_legacy_native',1,
		'legacy-brief.md','md','text/markdown',$1,$2,$3,'ordinary_upload','actor_human_a')`,
		len(source), hex.EncodeToString(object.SHA256[:]), object.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE documents
		SET current_version_id='version_legacy_native'
		WHERE id='document_legacy_native'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE documents
		SET native_import_status='pending',native_import_source_version_id='version_legacy_native'
		WHERE id='document_legacy_native'`); err != nil {
		t.Fatal(err)
	}
	var runtimeCalls atomic.Int32
	oldWorkerStarted := make(chan struct{})
	releaseOldWorker := make(chan struct{})
	materializer := func(ctx context.Context, input document.ImportRequest) (document.ImportedState, error) {
		call := runtimeCalls.Add(1)
		if call == 1 {
			return document.ImportedState{}, document.ErrRuntimeUnavailable
		}
		if call == 2 {
			close(oldWorkerStarted)
			select {
			case <-releaseOldWorker:
			case <-ctx.Done():
				return document.ImportedState{}, ctx.Err()
			}
		}
		if input.SourceKind != "markdown" || !bytes.Equal(input.SourceBytes, source) {
			t.Fatalf("legacy import input=%+v bytes=%q", input, input.SourceBytes)
		}
		state := append([]byte("normalized:"), input.SourceBytes...)
		return document.ImportedState{
			StateBytes: state, StateBytesSHA256: unifiedDocumentDigest(state), StateVector: []byte{1},
			FullStateFingerprint: unifiedDocumentDigest(state), StateHashVersion: 1,
			CompleteAssetIDs: append([]string(nil), input.AllowedAssetIDs...), CompleteThreadIDs: []string{},
		}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: materializer}, objects)
	worker := document.NewNativeImportMigrationWorker(service)
	if worked, err := worker.RunDocument(ctx, "document_legacy_native"); !worked || !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("failed migration worked=%t err=%v", worked, err)
	}
	var status, currentVersion string
	var drafts, history int
	if err := db.QueryRowContext(ctx, `SELECT document.native_import_status,document.current_version_id,
		(SELECT count(*) FROM document_bodies WHERE document_id=document.id),
		(SELECT count(*) FROM document_revisions WHERE document_id=document.id AND history_trigger IS NOT NULL)
		FROM documents document
		WHERE document.id='document_legacy_native'`).Scan(&status, &currentVersion, &drafts, &history); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || currentVersion != "version_legacy_native" || drafts != 0 || history != 0 {
		t.Fatalf("failed migration status=%s current=%s drafts=%d history=%d",
			status, currentVersion, drafts, history)
	}
	// The second attempt holds the import claim while it materializes.
	oldResult := make(chan error, 1)
	go func() {
		_, runErr := worker.RunDocument(ctx, "document_legacy_native")
		oldResult <- runErr
	}()
	receiveWithin(t, oldWorkerStarted, 30*time.Second)
	restarted := document.NewNativeImportMigrationWorker(service)
	if worked, err := restarted.RunDocument(ctx, "document_legacy_native"); worked || err != nil {
		t.Fatalf("busy migration worked=%t err=%v, want not worked and no error", worked, err)
	}
	// The River job that finds the row busy snoozes instead of completing.
	job := &river.Job[document.NativeImportMigrationArgs]{
		Args:   document.NativeImportMigrationArgs{DocumentID: "document_legacy_native"},
		JobRow: &rivertype.JobRow{Attempt: 1},
	}
	var snooze *river.JobSnoozeError
	if err := restarted.Work(ctx, job); !errors.As(err, &snooze) {
		t.Fatalf("busy job err=%v, want JobSnooze", err)
	}
	close(releaseOldWorker)
	if oldErr := receiveWithin(t, oldResult, 30*time.Second); oldErr != nil {
		t.Fatalf("holding worker result=%v", oldErr)
	}
	var format, representation, title string
	var current *string
	var versions, revisions int
	var stateBytes []byte
	if err := db.QueryRowContext(ctx, `SELECT document.native_import_status,document.format,
		document.native_representation_format,document.title,document.current_version_id,
		(SELECT count(*) FROM document_versions WHERE document_id=document.id),
		(SELECT count(*) FROM document_revisions WHERE document_id=document.id),
		(SELECT body.state FROM document_bodies body WHERE body.document_id=document.id),
		(SELECT count(*) FROM document_revisions WHERE document_id=document.id AND history_trigger IS NOT NULL)
		FROM documents document
		WHERE document.id='document_legacy_native'`).Scan(&status, &format, &representation,
		&title, &current, &versions, &revisions, &stateBytes, &history); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || format != "blocknote" || representation != "markdown" || title != "legacy-brief" ||
		current != nil || versions != 1 || revisions != 1 || !bytes.Equal(stateBytes, append([]byte("normalized:"), source...)) || history != 0 {
		t.Fatalf("completed migration status=%s format=%s/%s title=%q current=%v versions=%d revisions=%d bytes=%q history=%d",
			status, format, representation, title, current, versions, revisions, stateBytes, history)
	}
	// Replays after completion are no-ops, from either path.
	if worked, err := restarted.RunDocument(ctx, "document_legacy_native"); worked || err != nil {
		t.Fatalf("completed migration replay worked=%t err=%v", worked, err)
	}
	if err := restarted.Work(ctx, job); err != nil {
		t.Fatalf("completed migration job err=%v, want nil", err)
	}
	if runtimeCalls.Load() != 2 {
		t.Fatalf("runtime materialized %d times, want exactly 2 (one failed, one completed)", runtimeCalls.Load())
	}
}

func TestUnifiedDocumentTypedContextUploadsCreateOneAggregatePerSource(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	roomID := env.createRoom(alice, acmeTenant, "Typed upload "+suffix, "typed-upload-room-"+suffix)
	workItemID := "work_item_typed_upload_" + suffix
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_items(
		id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
	) VALUES($1,$2,(SELECT coalesce(max(number),0)+1 FROM work_items WHERE tenant_id=$2),
		'issue','Typed upload','actor_acme_alice','actor_acme_alice')`, workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO work_item_assignments(
		work_item_id,tenant_id,actor_id,assigned_by_actor_id
	) VALUES($1,$2,'actor_acme_official','actor_acme_alice')`, workItemID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(ctx, `INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES($1,$2,'actor_acme_alice')
		ON CONFLICT (tenant_id,owner_actor_id) WHERE deleted_at IS NULL DO NOTHING`,
		"wiki_typed_upload_"+suffix, acmeTenant); err != nil {
		t.Fatal(err)
	}
	var wikiID string
	if err := env.pool.QueryRow(ctx, `SELECT id FROM personal_wikis
		WHERE tenant_id=$1 AND owner_actor_id='actor_acme_alice' AND deleted_at IS NULL`, acmeTenant).Scan(&wikiID); err != nil {
		t.Fatal(err)
	}

	fields := map[string]string{
		"filename": "same.txt", "representation_format": "plain_text", "media_type": "text/plain",
	}
	content := []byte("same bytes in distinct typed sources")
	type uploadCase struct {
		name, path, key, bindingKind, contextColumn, contextID string
		wantPlacement                                          int
	}
	cases := []uploadCase{
		{name: "room", path: "/v0/rooms/" + roomID + "/documents/uploads",
			key: "typed-room-" + suffix, bindingKind: "room", contextColumn: "room_id", contextID: roomID,
			wantPlacement: 1},
		{name: "task", path: "/v0/work-items/" + workItemID + "/documents/uploads",
			key: "typed-task-" + suffix, bindingKind: "task", contextColumn: "work_item_id", contextID: workItemID,
			wantPlacement: 1},
		{name: "wiki", path: "/v0/tenants/" + acmeTenant + "/personal-wiki/documents/uploads",
			key: "typed-wiki-" + suffix, bindingKind: "wiki_source", contextColumn: "wiki_id", contextID: wikiID,
			wantPlacement: 1},
	}
	documentIDs := make(map[string]struct{}, len(cases))
	for _, test := range cases {
		status, headers, body := requestUnifiedDocumentMultipart(
			t, env, alice, test.path, test.key, fields, "same.txt", content,
		)
		if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "" {
			t.Fatalf("%s upload status=%d replay=%q body=%s", test.name, status,
				headers.Get("Idempotent-Replay"), body)
		}
		var created struct {
			ID      string                    `json:"id"`
			Owner   struct{ ID, Kind string } `json:"owner"`
			Creator struct{ ID, Kind string } `json:"creator"`
		}
		decode(t, body, &created)
		if created.ID == "" || created.Owner.ID != "actor_acme_alice" || created.Owner.Kind != "human" ||
			created.Creator.ID != "actor_acme_alice" || created.Creator.Kind != "human" {
			t.Fatalf("%s created=%+v body=%s", test.name, created, body)
		}
		if _, duplicate := documentIDs[created.ID]; duplicate {
			t.Fatalf("typed uploads reused document_id=%s", created.ID)
		}
		documentIDs[created.ID] = struct{}{}
		query := fmt.Sprintf(`SELECT
			(SELECT count(*) FROM document_versions WHERE document_id=$1),
			(SELECT count(*) FROM document_context_bindings
			 WHERE document_id=$1 AND binding_kind=$2 AND %s=$3 AND status='active'),
			(SELECT count(*) FROM document_placements WHERE document_id=$1)`, test.contextColumn)
		var versions, bindings, placements int
		if err := env.pool.QueryRow(ctx, query, created.ID, test.bindingKind, test.contextID).Scan(
			&versions, &bindings, &placements,
		); err != nil {
			t.Fatal(err)
		}
		if versions != 1 || bindings != 1 || placements != test.wantPlacement {
			t.Fatalf("%s aggregate versions=%d bindings=%d placements=%d",
				test.name, versions, bindings, placements)
		}
		replayStatus, replayHeaders, replayBody := requestUnifiedDocumentMultipart(
			t, env, alice, test.path, test.key, fields, "same.txt", content,
		)
		if replayStatus != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" ||
			!bytes.Equal(replayBody, body) {
			t.Fatalf("%s replay status=%d replay=%q equal=%t body=%s", test.name,
				replayStatus, replayHeaders.Get("Idempotent-Replay"), bytes.Equal(replayBody, body), replayBody)
		}
	}

	badFields := map[string]string{
		"parent_id": "forbidden", "filename": "bad.txt", "representation_format": "plain_text",
	}
	status, _, body := requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/rooms/"+roomID+"/documents/uploads", "typed-room-parent-"+suffix,
		badFields, "bad.txt", content)
	if status != http.StatusBadRequest {
		t.Fatalf("Room parent override status=%d body=%s", status, body)
	}
	if _, err := env.pool.Exec(ctx, `UPDATE work_items SET archived_at=clock_timestamp() WHERE id=$1`, workItemID); err != nil {
		t.Fatal(err)
	}
	status, _, body = requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/work-items/"+workItemID+"/documents/uploads", "typed-archived-"+suffix,
		fields, "same.txt", content)
	if status != http.StatusNotFound {
		t.Fatalf("archived Task upload status=%d body=%s", status, body)
	}
}

func TestUnifiedDocumentMetadataUpdatePublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	uploadKey := "http-metadata-upload-" + suffix
	status, _, uploadBody := requestUnifiedDocumentUpload(t, env, alice, uploadKey, map[string]string{
		"filename": "metadata-original.txt", "representation_format": "plain_text", "media_type": "text/plain",
	}, "metadata-original.txt", []byte("immutable Version bytes"))
	if status != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", status, uploadBody)
	}
	var created struct {
		ID             string `json:"id"`
		CurrentVersion *struct {
			ID string `json:"id"`
		} `json:"current_version"`
	}
	decode(t, uploadBody, &created)
	if created.ID == "" || created.CurrentVersion == nil {
		t.Fatalf("created=%+v body=%s", created, uploadBody)
	}

	path := "/v0/documents/" + created.ID
	status, _, body := env.request(alice, http.MethodPatch, path, map[string]any{
		"title": "metadata-renamed.txt",
	}, "")
	var renamed struct {
		ID             string `json:"id"`
		Title          string `json:"title"`
		CurrentVersion *struct {
			ID string `json:"id"`
		} `json:"current_version"`
	}
	decode(t, body, &renamed)
	if status != http.StatusOK || renamed.ID != created.ID ||
		renamed.Title != "metadata-renamed.txt" || renamed.CurrentVersion == nil ||
		renamed.CurrentVersion.ID != created.CurrentVersion.ID {
		t.Fatalf("rename status=%d value=%+v body=%s", status, renamed, body)
	}

	var versionCount, eventCount int
	var currentVersionID, versionFilename string
	if err := env.pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM document_versions WHERE document_id=$1),
		(SELECT count(*) FROM document_events WHERE document_id=$1),
		(SELECT current_version_id FROM documents WHERE id=$1),
		(SELECT filename FROM document_versions WHERE id=$2)
	`, created.ID, created.CurrentVersion.ID).Scan(
		&versionCount, &eventCount, &currentVersionID, &versionFilename,
	); err != nil {
		t.Fatal(err)
	}
	if versionCount != 1 || eventCount != 2 ||
		currentVersionID != created.CurrentVersion.ID || versionFilename != "metadata-original.txt" {
		t.Fatalf("rename aggregate versions=%d events=%d current=%s filename=%q",
			versionCount, eventCount, currentVersionID, versionFilename)
	}

	// A repeated rename finds the title already set.
	status, _, noChangeBody := env.request(alice, http.MethodPatch, path, map[string]any{
		"title": "metadata-renamed.txt",
	}, "")
	if status != http.StatusOK || string(noChangeBody) != string(body) {
		t.Fatalf("repeated rename status=%d equal=%t body=%s", status,
			string(noChangeBody) == string(body), noChangeBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_events WHERE document_id=$1`, created.ID); got != eventCount {
		t.Fatalf("no-change side effects events=%d want=%d", got, eventCount)
	}

	status, _, invalidBody := env.request(alice, http.MethodPatch, path, map[string]any{
		"title": "metadata-invalid.txt", "unknown": true,
	}, "http-metadata-unknown-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("unknown JSON status=%d body=%s", status, invalidBody)
	}
	status, _, nativeBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{},
		"http-native-for-metadata-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("native create status=%d body=%s", status, nativeBody)
	}
	var native struct {
		ID string `json:"id"`
	}
	decode(t, nativeBody, &native)
	status, _, nativeBody = env.request(alice, http.MethodPatch, "/v0/documents/"+native.ID, map[string]any{
		"title": "native-must-use-draft",
	}, "http-metadata-native-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("native metadata status=%d body=%s", status, nativeBody)
	}

	status, _, searchBody := env.request(alice, http.MethodGet,
		"/v0/library/documents/search?q=metadata-renamed.txt", nil, "")
	if status != http.StatusOK || !strings.Contains(string(searchBody), created.ID) ||
		!strings.Contains(string(searchBody), `"title":"metadata-renamed.txt"`) {
		t.Fatalf("renamed search status=%d body=%s", status, searchBody)
	}
	status, _, oldSearchBody := env.request(alice, http.MethodGet,
		"/v0/library/documents/search?q=metadata-original.txt", nil, "")
	if status != http.StatusOK || strings.Contains(string(oldSearchBody), created.ID) {
		t.Fatalf("old title search status=%d body=%s", status, oldSearchBody)
	}
}

func TestUnifiedDocumentHistoryContentPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	status, _, createBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{},
		"http-history-content-create-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", status, createBody)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, createBody, &created)
	status, _, checkpointBody := env.request(alice, http.MethodPost,
		"/v0/documents/"+created.ID+"/history/checkpoints", nil,
		"http-history-content-checkpoint-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("checkpoint status=%d body=%s", status, checkpointBody)
	}
	var checkpoint struct {
		HistoryEntry struct {
			ID           string `json:"id"`
			RevisionID   string `json:"revision_id"`
			PersistedSeq int64  `json:"persisted_seq"`
		} `json:"history_entry"`
	}
	decode(t, checkpointBody, &checkpoint)
	if checkpoint.HistoryEntry.ID == "" || checkpoint.HistoryEntry.RevisionID == "" {
		t.Fatalf("checkpoint=%+v body=%s", checkpoint, checkpointBody)
	}
	beforeEvents := countRows(t, env, `SELECT count(*) FROM document_events WHERE document_id=$1`, created.ID)

	path := "/v0/document-history/" + checkpoint.HistoryEntry.ID + "/content"
	status, _, body := env.request(alice, http.MethodGet, path, nil, "")
	var content struct {
		HistoryEntry struct {
			ID           string `json:"id"`
			DocumentID   string `json:"document_id"`
			RevisionID   string `json:"revision_id"`
			PersistedSeq int64  `json:"persisted_seq"`
		} `json:"history_entry"`
		StateBytes           string `json:"state_bytes"`
		StateBytesSHA256     string `json:"state_bytes_sha256"`
		StateVector          string `json:"state_vector"`
		FullStateFingerprint string `json:"full_state_fingerprint"`
		AssetManifest        []any  `json:"asset_manifest"`
	}
	decode(t, body, &content)
	stateBytes, err := base64.StdEncoding.DecodeString(content.StateBytes)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || content.HistoryEntry.ID != checkpoint.HistoryEntry.ID ||
		content.HistoryEntry.DocumentID != created.ID ||
		content.HistoryEntry.RevisionID != checkpoint.HistoryEntry.RevisionID ||
		content.HistoryEntry.PersistedSeq != checkpoint.HistoryEntry.PersistedSeq ||
		content.StateBytesSHA256 != unifiedDocumentDigest(stateBytes) || content.StateVector == "" ||
		content.FullStateFingerprint == "" || len(content.AssetManifest) != 0 {
		t.Fatalf("content status=%d value=%+v bytes=%d body=%s", status, content, len(stateBytes), body)
	}
	if afterEvents := countRows(t, env, `SELECT count(*) FROM document_events WHERE document_id=$1`, created.ID); afterEvents != beforeEvents {
		t.Fatalf("read side effects events=%d want=%d", afterEvents, beforeEvents)
	}
	status, _, missingBody := env.request(alice, http.MethodGet,
		"/v0/document-history/missing-history/content", nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("missing status=%d body=%s", status, missingBody)
	}
	corruptRevisionID := "document_revision_corrupt_" + suffix
	corruptPersistedSeq := checkpoint.HistoryEntry.PersistedSeq + 1000
	if _, err := env.pool.Exec(context.Background(), `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id,
		history_trigger,history_contributor_ids,history_recorded_at
	) SELECT $2,tenant_id,id,$3,'\x7f',repeat('f',64),'\x00',repeat('0',64),'[]'::jsonb,
		owner_actor_id,'manual',ARRAY[owner_actor_id],clock_timestamp() FROM documents WHERE id=$1`, created.ID, corruptRevisionID,
		corruptPersistedSeq); err != nil {
		t.Fatal(err)
	}
	status, _, corruptBody := env.request(alice, http.MethodGet,
		"/v0/document-history/"+corruptRevisionID+"/content", nil, "")
	if status != http.StatusServiceUnavailable ||
		!strings.Contains(string(corruptBody), "DOCUMENT_REVISION_UNAVAILABLE") {
		t.Fatalf("corrupt Revision status=%d body=%s", status, corruptBody)
	}
}

func requestUnifiedDocumentUpload(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	idempotencyKey string,
	fields map[string]string,
	contentFilename string,
	content []byte,
) (int, http.Header, []byte) {
	return requestUnifiedDocumentMultipart(
		t, env, client, "/v0/tenants/"+acmeTenant+"/documents/uploads", idempotencyKey, fields, contentFilename, content,
	)
}

func requestUnifiedDocumentVersionUpload(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	documentID string,
	idempotencyKey string,
	fields map[string]string,
	contentFilename string,
	content []byte,
) (int, http.Header, []byte) {
	return requestUnifiedDocumentMultipart(
		t, env, client, "/v0/documents/"+documentID+"/versions", idempotencyKey,
		fields, contentFilename, content,
	)
}

func requestUnifiedDocumentMultipart(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	path string,
	idempotencyKey string,
	fields map[string]string,
	contentFilename string,
	content []byte,
) (int, http.Header, []byte) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if contentFilename != "" {
		part, err := writer.CreateFormFile("content", contentFilename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, env.server.URL+path, &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", idempotencyKey)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, responseBody
}

func requestUnifiedDocumentVersionContent(
	t *testing.T,
	env *testEnv,
	client *http.Client,
	method, path string,
	headers map[string]string,
) (int, http.Header, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, env.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}

func unifiedDocumentDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

// documentDisconnects counts the disconnects that close an Actor's
// connections to a Document after commit once it can no longer write.
func documentDisconnects(t *testing.T, env *testEnv, documentID, actorID string) int {
	t.Helper()
	var disconnects int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job
		WHERE kind='document.runtime_disconnect' AND args->>'document_id'=$1
		 AND args->>'actor_id'=$2`, documentID, actorID).Scan(&disconnects); err != nil {
		t.Fatal(err)
	}
	return disconnects
}

// documentPermissionCount is the count a connection token must carry to open.
func documentPermissionCount(t *testing.T, env *testEnv, documentID string) int64 {
	t.Helper()
	var count int64
	if err := env.pool.QueryRow(t.Context(), `SELECT permission_count FROM document_permission_counts WHERE document_id=$1`,
		documentID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
