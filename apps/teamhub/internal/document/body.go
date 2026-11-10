package document

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"
)

// The Document Runtime writes a native Document's online body on every save
// and on every server change TeamHub authorizes. TeamHub reads it,
// creates it with a new Document, and writes existing bodies only for Wiki
// refresh: Wiki pages are read-only to every editor.

// bodyRevisionTx returns the Revision holding the body's current state,
// copying the body into one when none holds it yet.
func bodyRevisionTx(ctx context.Context, tx pgx.Tx, documentID string) (string, error) {
	var revisionID *string
	if err := tx.QueryRow(ctx, `SELECT snapshot_document_body($1)`, documentID).Scan(&revisionID); err != nil {
		return "", err
	}
	if revisionID == nil {
		return "", ErrNotFound
	}
	return *revisionID, nil
}

// insertBodyTx creates the body of a new native Document at sequence 0. A
// replayed creation finds the body already there.
func insertBodyTx(ctx context.Context, tx pgx.Tx, documentID string, state, stateVector []byte,
	assetIDs, threadIDs []string, editorID string,
) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_bodies(
		document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids
	) VALUES($1,0,$2,$3,$4,$5,ARRAY[$6::text])
	ON CONFLICT (document_id) DO NOTHING`, documentID, state, stateVector,
		sortedIDs(assetIDs), sortedIDs(threadIDs), editorID)
	return err
}

// sortedIDs never returns nil: pgx sends a nil slice as NULL, and the body's
// ID columns are NOT NULL.
func sortedIDs(values []string) []string {
	sorted := append([]string{}, values...)
	slices.Sort(sorted)
	return sorted
}

// recordHistoryPointTx records a History point of the body's current state
// after a change the Runtime saved and returns the Revision that holds it. A
// History point is that Revision, so its ID also names the History Entry.
// Edits saved after the change belong to the same point.
func recordHistoryPointTx(ctx context.Context, tx pgx.Tx, documentID, trigger string) (string, error) {
	var revisionID *string
	if err := tx.QueryRow(ctx, `SELECT record_document_history_point($1,$2)`, documentID, trigger).Scan(&revisionID); err != nil {
		return "", err
	}
	if revisionID == nil {
		return "", ErrNotFound
	}
	return *revisionID, nil
}
