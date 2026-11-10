package integration_test

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// seedAgentTaskFile stands in for the retired Agent CLI single-file
// publication. Agent A owns a plain file whose first version is stored in
// objects, and Work Item A's creator gets manager access the way Task
// delivery shared a new file. It returns the version ID.
func seedAgentTaskFile(t *testing.T, pool *pgxpool.Pool, objects artifactstore.ObjectStore, documentID, filename, format, mediaType string, content []byte) string {
	t.Helper()
	versionID := seedAgentFileVersion(t, pool, objects, documentID, "", filename, format, mediaType, content)
	if _, err := pool.Exec(t.Context(), `INSERT INTO document_direct_collaborators(
		id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version
	) VALUES($1,'tenant_document_a',$2,'actor_human_a','manager','active','actor_agent_a',1)`,
		documentID+"_task_creator", documentID); err != nil {
		t.Fatal(err)
	}
	return versionID
}

// seedAgentFileVersion stores content and makes it the current version of
// Agent A's file, creating the file when baseVersionID is empty.
func seedAgentFileVersion(t *testing.T, pool *pgxpool.Pool, objects artifactstore.ObjectStore, documentID, baseVersionID, filename, format, mediaType string, content []byte) string {
	t.Helper()
	object, err := objects.Put(t.Context(), bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	versionNumber := 1
	if baseVersionID == "" {
		if _, err := tx.Exec(t.Context(), `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
		) VALUES($1,'tenant_document_a',$2,$3,'actor_agent_a','agent','actor_agent_a','agent','active')`,
			documentID, filename, format); err != nil {
			t.Fatal(err)
		}
	} else if err := tx.QueryRow(t.Context(), `SELECT version_number+1 FROM document_versions WHERE id=$1`,
		baseVersionID).Scan(&versionNumber); err != nil {
		t.Fatal(err)
	}
	versionID := documentID + "_version_" + hex.EncodeToString(object.SHA256[:8])
	if _, err := tx.Exec(t.Context(), `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id,base_version_id
	) VALUES($1,'tenant_document_a',$2,$3,$4,$5,$6,$7,$8,$9,'agent_publication','actor_agent_a',NULLIF($10,''))`,
		versionID, documentID, versionNumber, filename, format, mediaType, object.Size,
		hex.EncodeToString(object.SHA256[:]), object.Key, baseVersionID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE documents SET current_version_id=$2, updated_at=clock_timestamp()
		WHERE id=$1 AND current_version_id IS NOT DISTINCT FROM NULLIF($3,'')`,
		documentID, versionID, baseVersionID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return versionID
}
