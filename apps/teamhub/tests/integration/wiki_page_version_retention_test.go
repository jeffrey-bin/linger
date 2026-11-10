package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"slices"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// An active Wiki page keeps its newest five Versions and any older one another
// record still reads; a removed page keeps only its current Version. Their
// stored content goes with them, and Versions stay immutable outside the sweep.
func TestWikiPageVersionRetentionKeepsTheNewestVersions(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	contentKeys := map[string]string{}
	addVersions := func(documentID string, from, to int) {
		t.Helper()
		for number := from; number <= to; number++ {
			markdown := fmt.Sprintf("# %s %d", documentID, number)
			digest := sha256.Sum256([]byte(markdown))
			object, _, err := objects.PutIfAbsent(ctx, "object_"+hex.EncodeToString(digest[:16]),
				bytes.NewReader([]byte(markdown)), int64(len(markdown)), digest)
			if err != nil {
				t.Fatal(err)
			}
			id := fmt.Sprintf("%s_v%d", documentID, number)
			contentKeys[id] = object.Key
			if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
				id,tenant_id,document_id,version_number,base_version_id,filename,representation_format,
				media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
			) VALUES($1,'tenant_document_a',$2,$3,$4,'page.md','markdown','text/markdown',$5,$6,$7,'wiki_page','actor_agent_a')`,
				id, documentID, number, fmt.Sprintf("%s_v%d", documentID, number-1),
				object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(ctx, `UPDATE documents SET current_version_id=$1 WHERE id=$2`, id, documentID); err != nil {
				t.Fatal(err)
			}
		}
	}
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_long", "guide/long.md", "# document_wiki_long 1")
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_removed", "guide/removed.md", "# document_wiki_removed 1")
	contentKeys["document_wiki_long_v1"] = "object_" + hexDigest16("# document_wiki_long 1")
	contentKeys["document_wiki_removed_v1"] = "object_" + hexDigest16("# document_wiki_removed 1")
	addVersions("document_wiki_long", 2, 8)
	addVersions("document_wiki_removed", 2, 3)
	if _, err := db.ExecContext(ctx, `
		UPDATE document_context_bindings SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE document_id='document_wiki_removed';
		INSERT INTO wiki_source_items(tenant_id,owner_actor_id,source_key,content_sha256,document_id,document_version_id)
		VALUES('tenant_document_a','actor_human_a','retention-source',repeat('a',64),'document_wiki_long','document_wiki_long_v2')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM document_versions WHERE id='document_wiki_long_v1'`); err == nil {
		t.Fatal("a Version was deleted outside the retention sweep")
	}

	pruner := document.NewWikiVersionPruner(document.NewWithObjectStore(pool, objects))
	for range 10 {
		more, err := pruner.RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !more {
			break
		}
	}

	versions := func(documentID string) []string {
		t.Helper()
		rows, err := db.QueryContext(ctx, `SELECT id FROM document_versions WHERE document_id=$1 ORDER BY version_number`, documentID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}
	if got, want := versions("document_wiki_long"), []string{"document_wiki_long_v2", "document_wiki_long_v4",
		"document_wiki_long_v5", "document_wiki_long_v6", "document_wiki_long_v7", "document_wiki_long_v8"}; !slices.Equal(got, want) {
		t.Fatalf("active page Versions=%v, want %v", got, want)
	}
	if got, want := versions("document_wiki_removed"), []string{"document_wiki_removed_v3"}; !slices.Equal(got, want) {
		t.Fatalf("removed page Versions=%v, want %v", got, want)
	}
	var base *string
	if err := db.QueryRowContext(ctx, `SELECT base_version_id FROM document_versions WHERE id='document_wiki_long_v4'`).Scan(&base); err != nil || base != nil {
		t.Fatalf("oldest kept Version base=%v error=%v", base, err)
	}
	for id, key := range contentKeys {
		_, err := objects.Open(ctx, key)
		kept := slices.Contains(versions("document_wiki_long"), id) || slices.Contains(versions("document_wiki_removed"), id)
		if kept && err != nil {
			t.Fatalf("kept Version %s lost its content: %v", id, err)
		}
		if !kept && !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("deleted Version %s kept its content: %v", id, err)
		}
	}

	addVersions("document_wiki_long", 9, 9)
	if _, err := db.ExecContext(ctx, `UPDATE document_versions SET base_version_id=NULL WHERE id='document_wiki_long_v9'`); err == nil {
		t.Fatal("a Version was changed outside the retention sweep")
	}
}

func hexDigest16(content string) string {
	digest := sha256.Sum256([]byte(content))
	return hex.EncodeToString(digest[:16])
}
