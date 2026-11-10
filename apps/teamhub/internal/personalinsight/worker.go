package personalinsight

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const (
	defaultRetryDelay  = time.Minute
	storedExcerptRunes = 500
	generationKind     = "personal_insight.generation"
	// generationTimeout bounds one attempt. Its model call can wait over five
	// minutes for the Agent Service before the pending answer arrives, which
	// the shorter default job timeout would cut off.
	generationTimeout = 10 * time.Minute
)

// GenerationArgs asks for the Insight step of one Profile generation to run.
// A step has at most one unfinished job, enforced by uniqueness on its ID.
type GenerationArgs struct {
	GenerationID string `json:"generation_id"`
}

func (GenerationArgs) Kind() string { return generationKind }

func (GenerationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		Queue:       jobs.QueueGeneration,
		MaxAttempts: maxAttempts,
		UniqueOpts:  jobs.UniqueUnfinished,
	}
}

// AddJobWorkers registers the Personal Insight generation worker.
func AddJobWorkers(workers *river.Workers, service *Service) {
	river.AddWorker(workers, &generationWorker{service: service})
}

type generationWorker struct {
	river.WorkerDefaults[GenerationArgs]
	service *Service
}

func (w *generationWorker) Timeout(*river.Job[GenerationArgs]) time.Duration {
	return generationTimeout
}

func (w *generationWorker) NextRetry(*river.Job[GenerationArgs]) time.Time {
	return time.Now().Add(w.service.options.RetryDelay)
}

func (w *generationWorker) Work(ctx context.Context, job *river.Job[GenerationArgs]) error {
	return w.service.runGeneration(ctx, job.Args.GenerationID, job.Attempt, job.CreatedAt)
}

// runGeneration runs one attempt of a Profile generation's Insight step,
// queued at queuedAt. The last attempt writes the terminal failure; earlier
// failures are returned so River retries them.
func (s *Service) runGeneration(ctx context.Context, generationID string, attempt int, queuedAt time.Time) error {
	generation, ok, err := s.claim(ctx, generationID)
	if err != nil || !ok {
		return err
	}
	evidence, err := buildEvidence(generation.ID, generation.OwnerActorID, generation.documents)
	if err != nil {
		return s.finishFailure(ctx, generation, "INVALID_EVIDENCE", attempt)
	}
	if len(evidence) == 0 {
		return s.finishSuccess(ctx, generation, GenerationResult{})
	}
	if s.generator == nil {
		return s.finishFailure(ctx, generation, "GENERATOR_UNAVAILABLE", attempt)
	}
	result, err := s.generator.GenerateEvidence(ctx, generation.TenantID, generation.OwnerActorID, evidence)
	if errors.Is(err, roomagent.ErrModelCallComputerOffline) {
		return s.waitForModel(ctx, generation, queuedAt, "COMPUTER_OFFLINE")
	}
	// The call runs on in the Agent Service; the next attempt joins it or
	// receives its result.
	if errors.Is(err, roomagent.ErrModelCallPending) {
		return s.waitForModel(ctx, generation, queuedAt, "MODEL_CALL_PENDING")
	}
	if err != nil {
		return s.finishFailure(ctx, generation, "GENERATOR_UNAVAILABLE", attempt)
	}
	return s.finishSuccess(ctx, generation, result)
}

// claimedGeneration is the Profile generation whose Insight step one attempt
// works on, with the mail evidence the step reads.
type claimedGeneration struct {
	ID, TenantID, OwnerActorID string
	documents                  []personalprofile.InsightDocument
}

// claim moves a queued or running Insight step to running. Any other status
// means the step is finished, so the job has nothing to do.
func (s *Service) claim(ctx context.Context, generationID string) (claimedGeneration, bool, error) {
	var claimed claimedGeneration
	var raw []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE personal_profile_generations
		SET insight_status='running',updated_at=now()
		WHERE id=$1 AND insight_status IN ('queued','running')
		RETURNING id,tenant_id,owner_actor_id,insight_documents`,
		generationID).Scan(&claimed.ID, &claimed.TenantID, &claimed.OwnerActorID, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimedGeneration{}, false, nil
	}
	if err != nil {
		return claimedGeneration{}, false, err
	}
	if err = json.Unmarshal(raw, &claimed.documents); err != nil {
		return claimedGeneration{}, false, err
	}
	return claimed, true, nil
}

func (s *Service) finishSuccess(ctx context.Context, claimed claimedGeneration, result GenerationResult) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('personal-insight|' || $1 || '|' || $2,0))`, claimed.TenantID, claimed.OwnerActorID); err != nil {
		return err
	}
	var current int
	if err = tx.QueryRow(ctx, `
		SELECT count(*) FROM personal_insights
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND dismissed_at IS NULL`, claimed.TenantID, claimed.OwnerActorID).Scan(&current); err != nil {
		return err
	}
	for _, item := range result.Insights {
		if current >= maxCurrentInsights {
			break
		}
		evidence, encodeErr := json.Marshal(evidenceForStorage(item.Evidence))
		if encodeErr != nil || len(item.Evidence) == 0 {
			continue
		}
		fingerprint := contentFingerprint(item.Dimension, item.Statement)
		result, insertErr := tx.Exec(ctx, `
			INSERT INTO personal_insights(
				id,tenant_id,owner_actor_id,source_generation_id,prompt_version,model,
				dimension,basis,statement,content_fingerprint,evidence
			) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (tenant_id,owner_actor_id,content_fingerprint) DO NOTHING`,
			ids.New("personal_insight"), claimed.TenantID, claimed.OwnerActorID, claimed.ID,
			PromptVersion, result.Model, strings.TrimSpace(item.Dimension), item.Basis,
			strings.TrimSpace(item.Statement), fingerprint, evidence)
		if insertErr != nil {
			return insertErr
		}
		if result.RowsAffected() == 1 {
			current++
		}
	}
	// The generation row is locked and re-checked so a duplicate run cannot
	// finish a step that another run already settled.
	var status string
	if err = tx.QueryRow(ctx, `SELECT insight_status FROM personal_profile_generations WHERE id=$1 FOR UPDATE`, claimed.ID).Scan(&status); err != nil {
		return err
	}
	if status != "running" {
		return nil
	}
	if _, err = tx.Exec(ctx, `
		UPDATE personal_profile_generations
		SET insight_status='succeeded',insight_error_code=NULL,insight_documents=NULL,updated_at=now()
		WHERE id=$1`, claimed.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func evidenceForStorage(items []InsightEvidence) []InsightEvidence {
	stored := append([]InsightEvidence(nil), items...)
	for index := range stored {
		excerpt := []rune(stored[index].Source.Excerpt)
		if len(excerpt) > storedExcerptRunes {
			stored[index].Source.Excerpt = string(excerpt[:storedExcerptRunes])
		}
	}
	return stored
}

// waitForModel queues the step again and snoozes its job until the owner's
// Computer may be back or its pending call has finished. The snooze does not
// spend an attempt; a step that has waited past the limit since it was queued
// fails terminally.
func (s *Service) waitForModel(ctx context.Context, claimed claimedGeneration, queuedAt time.Time, reason string) error {
	if jobs.ComputerOfflineWaitExpired(queuedAt, time.Now()) {
		return s.finishFailure(ctx, claimed, reason+"_TIMEOUT", maxAttempts)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE personal_profile_generations
		SET insight_status='queued',insight_error_code=$2,updated_at=now()
		WHERE id=$1 AND insight_status='running'`, claimed.ID, reason+"_WAIT"); err != nil {
		return err
	}
	return river.JobSnooze(jobs.ComputerOfflineRetryDelay)
}

// finishFailure records a failed attempt. A non-final attempt returns the
// error so River retries it; the last attempt writes the terminal failure,
// drops the evidence and returns nil so the job is not retried past its cap.
func (s *Service) finishFailure(ctx context.Context, claimed claimedGeneration, code string, attempt int) error {
	terminal := attempt >= maxAttempts
	if _, err := s.pool.Exec(ctx, `
		UPDATE personal_profile_generations
		SET insight_status=CASE WHEN $3 THEN 'failed' ELSE 'queued' END,insight_error_code=$2,
		    insight_documents=CASE WHEN $3 THEN NULL ELSE insight_documents END,updated_at=now()
		WHERE id=$1 AND insight_status='running'`,
		claimed.ID, code, terminal); err != nil {
		return err
	}
	if terminal {
		return nil
	}
	return fmt.Errorf("Personal Insight generation attempt failed: %s", code)
}
