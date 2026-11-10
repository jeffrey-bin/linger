package document

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"

	"github.com/jackc/pgx/v5"
)

// PersonalWiki is a Human's Wiki root and its refresh state. ID and the
// timestamps are empty until a write creates the root.
type PersonalWiki struct {
	ID                  string
	TenantID            string
	OwnerActorID        string
	PublishedGeneration int64
	// State is idle, refreshing or failed (WikiRefreshState).
	State             string
	LatestRefreshID   string
	PreviewRevision   int64
	CurrentRevisionID string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// GetPersonalWiki reads the Human's Wiki without writing. A Human whose Wiki
// root does not exist yet gets an idle Wiki with no ID.
func (s *Service) GetPersonalWiki(ctx context.Context, accountID, tenantID string) (PersonalWiki, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return PersonalWiki{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	wiki := PersonalWiki{TenantID: tenantID}
	if wiki.OwnerActorID, err = resolveActiveHumanActorTx(ctx, tx, accountID, tenantID); err != nil {
		return PersonalWiki{}, err
	}
	err = tx.QueryRow(ctx, `SELECT id,published_generation,coalesce(current_revision_id,''),created_at,updated_at
		FROM personal_wikis WHERE tenant_id=$1 AND owner_actor_id=$2 AND deleted_at IS NULL`,
		tenantID, wiki.OwnerActorID).Scan(&wiki.ID, &wiki.PublishedGeneration, &wiki.CurrentRevisionID,
		&wiki.CreatedAt, &wiki.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PersonalWiki{}, err
	}
	state, err := LoadWikiRefreshState(ctx, tx, tenantID, wiki.OwnerActorID)
	if err != nil {
		return PersonalWiki{}, err
	}
	wiki.PreviewRevision = state.PreviewRevision
	wiki.State, wiki.LatestRefreshID = state.State, state.LatestRefreshID
	return wiki, nil
}

// GetPersonalOriginVersion reads a Version the Human can read in the Tenant:
// a file the Personal Profile was given as input.
func (s *Service) GetPersonalOriginVersion(ctx context.Context, accountID, tenantID, versionID string) (Version, error) {
	version, err := s.GetVersion(ctx, accountID, versionID)
	if err != nil {
		return Version{}, err
	}
	if version.CreatedBy.TenantID != tenantID {
		return Version{}, ErrNotFound
	}
	return version, nil
}

// OpenPersonalOriginVersion opens the bytes of such a Version.
func (s *Service) OpenPersonalOriginVersion(ctx context.Context, accountID, tenantID, versionID string) (Version, io.ReadCloser, error) {
	content, err := s.GetVersionContent(ctx, accountID, versionID)
	if err != nil {
		return Version{}, nil, err
	}
	if content.Version.CreatedBy.TenantID != tenantID {
		return Version{}, nil, ErrNotFound
	}
	reader, err := s.objects.Open(ctx, content.ObjectKey)
	if err != nil {
		return Version{}, nil, err
	}
	return content.Version, reader, nil
}

// PersonalWikiPreview reads only the requested active refresh of the authorized Wiki.
func (s *Service) PersonalWikiPreview(ctx context.Context, wiki PersonalWiki, refreshID string) (map[string]string, error) {
	pages := map[string]string{}
	if wiki.ID == "" || refreshID != wiki.LatestRefreshID || wiki.State != "refreshing" {
		return pages, nil
	}
	raw, err := store.New(s.pool).ReadWikiRefreshPreview(ctx, store.ReadWikiRefreshPreviewParams{WikiID: wiki.ID, RefreshID: refreshID})
	if errors.Is(err, pgx.ErrNoRows) {
		return pages, nil
	}
	if err != nil {
		return nil, err
	}
	err = json.Unmarshal(raw, &pages)
	return pages, err
}
