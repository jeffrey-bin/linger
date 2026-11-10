package personalprofile

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// BuildWindow bounds how long a started build shows as in progress when no
// revision follows it, such as after an Agent stops midway.
const BuildWindow = 30 * time.Minute

// StartBuild records that an Agent has started writing the Human's Profile, so
// the Profile page can say so. A build already in progress keeps its start and
// gets a fresh window; the next revision ends it.
func (s *Service) StartBuild(ctx context.Context, tenantID, ownerActorID string) (time.Time, error) {
	var startedAt time.Time
	err := s.pool.QueryRow(ctx, `
		INSERT INTO personal_profile_builds(tenant_id,owner_actor_id,expires_at)
		VALUES($1,$2,clock_timestamp()+make_interval(secs => $3))
		ON CONFLICT (tenant_id,owner_actor_id) DO UPDATE SET
			started_at=CASE WHEN personal_profile_builds.expires_at>clock_timestamp() THEN personal_profile_builds.started_at ELSE clock_timestamp() END,
			expires_at=clock_timestamp()+make_interval(secs => $3)
		RETURNING started_at`, tenantID, ownerActorID, BuildWindow.Seconds()).Scan(&startedAt)
	return startedAt, err
}

// buildingSince is when the Profile currently being written started: an
// Agent's build within its window, or a queued or running generation.
func buildingSince(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, tenantID, actorID string) (*time.Time, error) {
	var since *time.Time
	err := db.QueryRow(ctx, `
		SELECT min(started) FROM (
			SELECT started_at AS started FROM personal_profile_builds
			WHERE tenant_id=$1 AND owner_actor_id=$2 AND expires_at>clock_timestamp()
			UNION ALL
			SELECT created_at FROM personal_profile_generations
			WHERE tenant_id=$1 AND owner_actor_id=$2 AND status IN ('queued','running')
		) building`, tenantID, actorID).Scan(&since)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return since, err
}
