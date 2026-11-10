// Package personalinsight generates and stores Personal Insights, including
// the grounded Insight candidates drawn from email evidence.
package personalinsight

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type Service struct {
	pool      *pgxpool.Pool
	generator Generator
	options   Options
}

// New returns the Personal Insight service; a nil generator queues nothing.
func New(pool *pgxpool.Pool, generator Generator, configured ...Options) *Service {
	options := Options{}
	if len(configured) > 0 {
		options = configured[0]
	}
	if options.RetryDelay <= 0 {
		options.RetryDelay = defaultRetryDelay
	}
	return &Service{pool: pool, generator: generator, options: options}
}

// Enqueue queues the Insight step of a succeeded Profile generation with the
// mail evidence that generation collected.
func (s *Service) Enqueue(ctx context.Context, tx pgx.Tx, generationID string, documents []personalprofile.InsightDocument) error {
	if s == nil || s.generator == nil {
		return nil
	}
	if documents == nil {
		documents = []personalprofile.InsightDocument{}
	}
	stored, err := json.Marshal(documents)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE personal_profile_generations
		SET insight_status='queued',insight_error_code=NULL,insight_documents=$2,updated_at=now()
		WHERE id=$1 AND insight_status IS NULL`, generationID, stored)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// The step was queued already; its job was enqueued then.
		return nil
	}
	return jobs.InsertTx(ctx, tx, GenerationArgs{GenerationID: generationID}, nil)
}

func (s *Service) List(ctx context.Context, accountID, tenantID string) (ListResult, error) {
	ownerActorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return ListResult{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id,dimension,statement,created_at
		FROM personal_insights
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND dismissed_at IS NULL
		ORDER BY created_at,id
		LIMIT $3`, tenantID, ownerActorID, maxCurrentInsights)
	if err != nil {
		return ListResult{}, err
	}
	defer rows.Close()
	result := ListResult{Items: []Insight{}}
	for rows.Next() {
		var item Insight
		if err = rows.Scan(&item.ID, &item.Dimension, &item.Statement, &item.CreatedAt); err != nil {
			return ListResult{}, err
		}
		result.Items = append(result.Items, item)
	}
	if err = rows.Err(); err != nil {
		return ListResult{}, err
	}
	var generation Generation
	err = s.pool.QueryRow(ctx, `
		SELECT insight_status,updated_at
		FROM personal_profile_generations
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND insight_status IS NOT NULL
		ORDER BY created_at DESC,id DESC
		LIMIT 1`, tenantID, ownerActorID).Scan(&generation.Status, &generation.UpdatedAt)
	if err == nil {
		result.Generation = &generation
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ListResult{}, err
	}
	return result, nil
}

func (s *Service) Dismiss(ctx context.Context, accountID, tenantID, insightID string) error {
	ownerActorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return err
	}
	result, err := s.pool.Exec(ctx, `
		UPDATE personal_insights
		SET dismissed_at=coalesce(dismissed_at,now()),evidence='[]'::jsonb,updated_at=now()
		WHERE id=$1 AND tenant_id=$2 AND owner_actor_id=$3`, insightID, tenantID, ownerActorID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Service) humanActorID(ctx context.Context, accountID, tenantID string) (string, error) {
	actor, err := store.New(s.pool).GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return actor.ID, err
}
