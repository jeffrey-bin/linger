package document

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var documentInputFailedTerminal = json.RawMessage(`{"type":"failed","error":"document_input_failed"}`)

// commentInputSnoozeDelay retries an event job that lost a serialization race.
const commentInputSnoozeDelay = time.Second

// CommentRunWorker starts and fails queued Document comment Runs. A Run is
// identified with its triggering comment through its initial Runtime input. It
// waits while the comment thread's anchor is pending and starts once the anchor
// is attached; it fails when the thread is resolved or orphaned, the Agent can
// no longer read the Document, or the Run is 24 hours old. Claiming applies the
// same rules through agent_document_run_claimable.
type CommentRunWorker struct {
	documents *Service
}

// NewCommentRunWorker returns a worker that settles comment Runs of documents.
func NewCommentRunWorker(documents *Service) *CommentRunWorker {
	return &CommentRunWorker{documents: documents}
}

// RunOne settles the oldest queued comment Run that must fail, or whose
// attached thread still waits on a suspended Context because its event job was
// lost.
func (worker *CommentRunWorker) RunOne(ctx context.Context) (bool, error) {
	if worker == nil || worker.documents == nil || worker.documents.pool == nil {
		return false, ErrInvalidInput
	}
	var runID string
	err := worker.documents.pool.QueryRow(ctx, `SELECT local_run.run_id
		FROM agent_local_runs local_run
		JOIN agent_execution_contexts execution_context
		  ON execution_context.context_key=local_run.context_key
		 AND execution_context.context_kind='document'
		JOIN agent_local_run_inputs run_input
		  ON run_input.run_id=local_run.run_id AND run_input.relation='initial'
		JOIN agent_runtime_inputs input
		  ON input.context_key=run_input.context_key AND input.input_id=run_input.input_id
		 AND input.source_kind='inbox'
		JOIN room_document_comments comment
		  ON comment.id=input.source_message_id
		 AND comment.tenant_id=execution_context.tenant_id
		 AND comment.document_id=execution_context.document_id
		JOIN room_document_comment_threads thread
		  ON thread.id=comment.thread_id AND thread.tenant_id=comment.tenant_id
		WHERE local_run.status='queued'
		  AND (
		    NOT document_comment_agent_readable(execution_context.tenant_id,
		        execution_context.document_id,execution_context.agent_actor_id)
		    OR local_run.created_at<=clock_timestamp()-interval '24 hours'
		    OR thread.resolved_at IS NOT NULL
		    OR thread.anchor_status='orphaned'
		    OR (thread.anchor_status='attached' AND execution_context.target_residency='suspended')
		  )
		ORDER BY local_run.created_at,local_run.run_id
		LIMIT 1`).Scan(&runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = worker.documents.settleCommentRun(ctx, runID, false)
	if isRetryableDocumentTransactionError(err) {
		// Another reconciler or claimant won. The winner finishes the work, and
		// the next sweep re-reads authoritative state if it does not.
		return false, nil
	}
	return true, err
}

// workRun settles one Run for its event job. A lost serialization race
// snoozes the job instead of completing it: the winner may have read state
// from before the fact that enqueued this job, so the wake-up must not be lost.
func (worker *CommentRunWorker) workRun(ctx context.Context, runID string) error {
	if worker == nil || worker.documents == nil || runID == "" {
		return ErrInvalidInput
	}
	return commentInputJobError(worker.documents.settleCommentRun(ctx, runID, true))
}

func commentInputJobError(err error) error {
	if isRetryableDocumentTransactionError(err) {
		return river.JobSnooze(commentInputSnoozeDelay)
	}
	return err
}

// settleCommentRun fails or starts one queued comment Run. An event job runs
// right after its mention or thread change, so it also checks that the
// comment is unedited since the mention and that the Document and its optional Room
// binding still admit the Run before it
// wakes the Context. The sweep repeats that check only for a Context that is
// still suspended.
func (s *Service) settleCommentRun(ctx context.Context, runID string, event bool) error {
	if s == nil || s.pool == nil || runID == "" {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var contextKey, residency, runStatus, anchorStatus string
	var expired, readable, resolved, admissible bool
	err = tx.QueryRow(ctx, `SELECT execution_context.context_key,execution_context.target_residency,
		  local_run.status,local_run.created_at<=clock_timestamp()-interval '24 hours',
		  document_comment_agent_readable(execution_context.tenant_id,
		    execution_context.document_id,execution_context.agent_actor_id),
		  thread.anchor_status,thread.resolved_at IS NOT NULL,
		  (comment.deleted_at IS NULL
		    AND comment.version_number=(input.payload->>'documentCommentVersion')::bigint
		    AND document.status='active' AND document.format='blocknote'
		    AND (input.payload->>'documentCommentRoomId'='' OR EXISTS (
		      SELECT 1 FROM document_context_bindings binding
		      WHERE binding.document_id=document.id AND binding.tenant_id=document.tenant_id
		        AND binding.binding_kind='room' AND binding.room_id=input.payload->>'documentCommentRoomId'
		        AND binding.status='active'))
		    AND EXISTS (
		      SELECT 1 FROM agent_registrations registration
		      WHERE registration.actor_id=execution_context.agent_actor_id
		        AND registration.tenant_id=execution_context.tenant_id
		        AND registration.status='active'))
		FROM agent_local_runs local_run
		JOIN agent_execution_contexts execution_context
		  ON execution_context.context_key=local_run.context_key
		 AND execution_context.context_kind='document'
		JOIN agent_local_run_inputs run_input
		  ON run_input.run_id=local_run.run_id AND run_input.relation='initial'
		JOIN agent_runtime_inputs input
		  ON input.context_key=run_input.context_key AND input.input_id=run_input.input_id
		 AND input.source_kind='inbox'
		JOIN room_document_comments comment
		  ON comment.id=input.source_message_id
		 AND comment.tenant_id=execution_context.tenant_id
		 AND comment.document_id=execution_context.document_id
		JOIN room_document_comment_threads thread
		  ON thread.id=comment.thread_id AND thread.tenant_id=comment.tenant_id
		JOIN documents document
		  ON document.id=execution_context.document_id
		 AND document.tenant_id=execution_context.tenant_id
		WHERE local_run.run_id=$1
		FOR UPDATE OF execution_context,local_run`, runID).Scan(
		&contextKey, &residency, &runStatus, &expired, &readable,
		&anchorStatus, &resolved, &admissible,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if runStatus != "queued" {
		return tx.Commit(ctx)
	}
	admit := anchorStatus == "attached" && (event || residency == "suspended")
	switch {
	case !readable || expired || resolved || anchorStatus == "orphaned" || admit && !admissible:
		terminated, err := agentruntimestate.TerminateLocalRuns(ctx, store.New(tx),
			[]string{runID}, documentInputFailedTerminal)
		if err != nil {
			return err
		}
		if len(terminated) != 1 {
			return ErrConflict
		}
	case admit:
		// The revision change wakes the Agent Service even when the Context is
		// already active, because the Run became claimable without a Context
		// change of its own.
		if _, err := tx.Exec(ctx, `UPDATE agent_execution_contexts
			SET target_residency='active',state_revision=state_revision+1,updated_at=clock_timestamp()
			WHERE context_key=$1`, contextKey); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
