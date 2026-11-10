package document

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

const commentInputKind = "document.comment_input"

// CommentInputArgs asks for one queued Document comment Run to be started or
// failed from its current state. The worker reads the state, so a duplicate or
// late job does nothing.
type CommentInputArgs struct {
	RunID string `json:"run_id"`
}

func (CommentInputArgs) Kind() string { return commentInputKind }

// InsertOpts sets no uniqueness. River requires a unique key to cover running
// jobs, and a running job may have read state before a new fact committed, so
// it must not absorb that fact's wake-up. A duplicate job finds nothing to do.
// MaxAttempts 1 leaves a failed job to the once-a-minute safety-net sweep.
func (CommentInputArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDocumentInput, MaxAttempts: 1}
}

// EnqueueCommentInputTx enqueues the Run in the transaction that committed the
// fact that may start or fail it.
func EnqueueCommentInputTx(ctx context.Context, tx pgx.Tx, runID string) error {
	return jobs.InsertTx(ctx, tx, CommentInputArgs{RunID: runID}, nil)
}

// enqueueNewCommentRunInputTx enqueues a new comment Run now and again at its
// 24-hour limit, both in the transaction that queues it, so a Run still
// queued then fails on time. The limit is read on the database clock that the
// worker compares against.
func enqueueNewCommentRunInputTx(ctx context.Context, tx pgx.Tx, runID string) error {
	if err := EnqueueCommentInputTx(ctx, tx, runID); err != nil {
		return err
	}
	var expiresAt time.Time
	if err := tx.QueryRow(ctx, `SELECT created_at+interval '24 hours' FROM agent_local_runs WHERE run_id=$1`,
		runID).Scan(&expiresAt); err != nil {
		return err
	}
	return jobs.InsertTx(ctx, tx, CommentInputArgs{RunID: runID}, &river.InsertOpts{ScheduledAt: expiresAt})
}

// EnqueueCommentInputsForThreadsTx enqueues every queued comment Run whose
// triggering comment belongs to one of the threads.
func EnqueueCommentInputsForThreadsTx(ctx context.Context, tx pgx.Tx, threadIDs []string) error {
	if len(threadIDs) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT local_run.run_id
		FROM room_document_comments comment
		JOIN agent_runtime_inputs input
		  ON input.source_message_id=comment.id AND input.source_kind='inbox'
		JOIN agent_local_runs local_run
		  ON local_run.run_id=input.local_run_id AND local_run.context_key=input.context_key
		 AND local_run.status='queued'
		JOIN agent_execution_contexts execution_context
		  ON execution_context.context_key=local_run.context_key
		 AND execution_context.context_kind='document'
		 AND execution_context.document_id=comment.document_id
		WHERE comment.thread_id=ANY($1)
		ORDER BY local_run.run_id`, threadIDs)
	if err != nil {
		return err
	}
	runIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, runID := range runIDs {
		if err := EnqueueCommentInputTx(ctx, tx, runID); err != nil {
			return err
		}
	}
	return nil
}
