package fixture

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// RuntimeBodySaveSQL is the one statement the Document Runtime runs for every
// save (apps/node-services/src/document/bodies.ts); tests run it to stand in
// for the Runtime.
const RuntimeBodySaveSQL = `UPDATE document_bodies SET seq=seq+1,state=$3,state_vector=$4,
	asset_ids=$5::text[],thread_ids=$6::text[],
	last_editor_ids=(SELECT coalesce(array_agg(editor ORDER BY position),'{}'::text[])
	  FROM unnest(last_editor_ids) WITH ORDINALITY kept(editor,position)
	  WHERE NOT (editor=ANY($7::text[])))||$7::text[],
	updated_at=clock_timestamp()
	WHERE document_id=$1 AND seq=$2
	  AND EXISTS (SELECT 1 FROM documents WHERE id=$1 AND status='active' AND format='blocknote')
	RETURNING seq`

// BodySave is one Runtime save of a Document body.
type BodySave struct {
	DocumentID                     string
	BaseSeq                        int64
	State, StateVector             []byte
	AssetIDs, ThreadIDs, EditorIDs []string
}

// Querier runs one statement; pgx pools, connections and transactions do.
type Querier interface {
	QueryRow(ctx context.Context, sql string, arguments ...any) pgx.Row
}

// SaveBody saves as the Runtime does and returns the new sequence; saved is
// false when the base sequence is stale or the Document is not active.
func SaveBody(ctx context.Context, querier Querier, save BodySave) (seq int64, saved bool, err error) {
	nonNil := func(values []string) []string {
		if values == nil {
			return []string{}
		}
		return values
	}
	err = querier.QueryRow(ctx, RuntimeBodySaveSQL, save.DocumentID, save.BaseSeq, save.State,
		save.StateVector, nonNil(save.AssetIDs), nonNil(save.ThreadIDs), nonNil(save.EditorIDs)).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return seq, err == nil, err
}

// ConnectionTokenClaims decodes the claims of a Document connection token
// without verifying it; the Document Runtime owns verification.
func ConnectionTokenClaims(t *testing.T, token string) document.ConnectionTokenClaims {
	t.Helper()
	encoded, _, ok := strings.Cut(token, ".")
	if !ok {
		t.Fatalf("connection token %q has no signature", token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var claims document.ConnectionTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}
