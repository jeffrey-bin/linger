package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// documentRuntimeStub is a Document Runtime with the operations a test sets;
// every other operation reports the Runtime unavailable.
type documentRuntimeStub struct {
	importer func(context.Context, document.ImportRequest) (document.ImportedState, error)
	export   func(context.Context, document.ExportRuntimeRequest) (document.ExportRuntimeResult, error)
	apply    func(context.Context, document.ApplyRequest) (document.ApplyResult, error)
}

func runStubOperation[I, O any](operation func(context.Context, I) (O, error), ctx context.Context, input I) (O, error) {
	if operation == nil {
		var unavailable O
		return unavailable, document.ErrRuntimeUnavailable
	}
	return operation(ctx, input)
}

func (stub documentRuntimeStub) Import(ctx context.Context, input document.ImportRequest) (document.ImportedState, error) {
	return runStubOperation(stub.importer, ctx, input)
}

func (stub documentRuntimeStub) Export(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
	return runStubOperation(stub.export, ctx, input)
}

func (stub documentRuntimeStub) Apply(ctx context.Context, input document.ApplyRequest) (document.ApplyResult, error) {
	return runStubOperation(stub.apply, ctx, input)
}

// bodyChange computes the state a change produces from the current body, as
// the Runtime does, and returns the new state with its references and title.
type bodyChange func(document.ApplyRequest, []byte) (state, stateVector []byte, assetIDs, threadIDs []string, title string, err error)

// applyToBody is an apply that saves the computed state over the stored body
// the way the Runtime does: one sequence-checked UPDATE of document_bodies.
func applyToBody(pool *pgxpool.Pool, change bodyChange) func(context.Context, document.ApplyRequest) (document.ApplyResult, error) {
	return func(ctx context.Context, input document.ApplyRequest) (document.ApplyResult, error) {
		var seq int64
		var current []byte
		err := pool.QueryRow(ctx, `SELECT seq,state FROM document_bodies WHERE document_id=$1`,
			input.DocumentID).Scan(&seq, &current)
		if errors.Is(err, pgx.ErrNoRows) {
			return document.ApplyResult{}, document.ErrNotFound
		}
		if err != nil {
			return document.ApplyResult{}, err
		}
		if input.ExpectedSeq != nil && *input.ExpectedSeq != seq {
			return document.ApplyResult{ConflictReason: "stale_head"}, nil
		}
		state, vector, assetIDs, threadIDs, title, err := change(input, current)
		if err != nil {
			return document.ApplyResult{}, err
		}
		if assetIDs == nil {
			assetIDs = []string{}
		}
		if threadIDs == nil {
			threadIDs = []string{}
		}
		if err := pool.QueryRow(ctx, `UPDATE document_bodies SET seq=seq+1,state=$3,state_vector=$4,
			asset_ids=$5,thread_ids=$6,last_editor_ids=array_append(array_remove(last_editor_ids,$7::text),$7::text),
			updated_at=clock_timestamp()
			WHERE document_id=$1 AND seq=$2 RETURNING seq`, input.DocumentID, seq, state, vector,
			assetIDs, threadIDs, input.ActorID).Scan(&seq); err != nil {
			return document.ApplyResult{}, err
		}
		digest := sha256.Sum256(state)
		return document.ApplyResult{
			Applied: true, Seq: seq, StateHash: hex.EncodeToString(digest[:]), Title: title,
			CompleteAssetIDs: assetIDs, CompleteThreadIDs: threadIDs,
		}, nil
	}
}
