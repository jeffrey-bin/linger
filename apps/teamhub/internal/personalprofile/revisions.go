package personalprofile

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"sort"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

const agentWriteOperation = "agent_write_profile_revision"

var profileSourceAppPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,119}$`)

// WriteRevision replaces a Human's current Profile with doc when the current
// Revision is still baseRevisionID (empty for none). A revision is published
// when either the normalized document or source apps change. Omitting source
// apps records unknown provenance, replacing any previously recorded sources.
// A replayed key returns the Revision it first produced. An invalid document
// returns a *DocumentError and writes nothing.
func (s *Service) WriteRevision(ctx context.Context, tenantID, ownerActorID, key, baseRevisionID string, doc Document, sourceApps []string) (Revision, error) {
	doc, err := NormalizeDocument(doc)
	if err != nil {
		return Revision{}, err
	}
	canonical := CanonicalJSON(doc)
	if len(sourceApps) > 20 {
		return Revision{}, ErrInvalid
	}
	if sourceApps != nil {
		sourceApps = append([]string{}, sourceApps...)
		sort.Strings(sourceApps)
		for i, app := range sourceApps {
			if !profileSourceAppPattern.MatchString(app) || (i > 0 && app == sourceApps[i-1]) {
				return Revision{}, ErrInvalid
			}
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Revision{}, err
	}
	defer tx.Rollback(ctx)
	hash := requestDigest(struct {
		BaseRevisionID string
		Profile        json.RawMessage
		SourceApps     []string
	}{baseRevisionID, canonical, sourceApps})
	replayed, revisionID, err := commandReplay(ctx, tx, ownerActorID, agentWriteOperation, key, hash)
	if err != nil {
		return Revision{}, err
	}
	if !replayed {
		for _, app := range sourceApps {
			var owned bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections c JOIN actors a ON a.account_id=c.account_id WHERE a.tenant_id=$1 AND a.id=$2 AND c.provider=$3)`, tenantID, ownerActorID, app).Scan(&owned); err != nil {
				return Revision{}, err
			}
			if !owned {
				return Revision{}, ErrInvalid
			}
		}
		currentID, err := lockCurrentRevision(ctx, tx, tenantID, ownerActorID)
		if err != nil {
			return Revision{}, err
		}
		if currentID != baseRevisionID {
			return Revision{}, ErrConflict
		}
		revisionID = currentID
		current, err := loadRevision(ctx, tx, tenantID, ownerActorID, currentID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return Revision{}, err
		}
		if currentID == "" || !bytes.Equal(CanonicalJSON(current.Profile), canonical) || !reflect.DeepEqual(current.SourceApps, sourceApps) {
			var published bool
			revisionID, published, err = publishRevision(ctx, tx, tenantID, ownerActorID, baseRevisionID, doc, "", sourceApps)
			if err != nil {
				return Revision{}, err
			}
			if !published {
				return Revision{}, ErrConflict
			}
		}
		if err = saveCommandReceipt(ctx, tx, ownerActorID, agentWriteOperation, key, hash, revisionID); err != nil {
			return Revision{}, err
		}
	}
	revision, err := loadRevision(ctx, tx, tenantID, ownerActorID, revisionID)
	if err != nil {
		return Revision{}, err
	}
	// The written revision ends the build the Agent started.
	if _, err = tx.Exec(ctx, `DELETE FROM personal_profile_builds WHERE tenant_id=$1 AND owner_actor_id=$2`, tenantID, ownerActorID); err != nil {
		return Revision{}, err
	}
	return revision, tx.Commit(ctx)
}

// ReplaceRevision publishes the Human's own edit of their Profile Markdown
// over baseRevisionID. The edit keeps the current Revision's name and source
// apps, and an edit that changes nothing returns the current Revision. A
// different current Revision, such as one Another Me wrote meanwhile, is a
// conflict.
func (s *Service) ReplaceRevision(ctx context.Context, accountID, tenantID, baseRevisionID, markdown string) (Revision, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Revision{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Revision{}, err
	}
	defer tx.Rollback(ctx)
	currentID, err := lockCurrentRevision(ctx, tx, tenantID, actorID)
	if err != nil {
		return Revision{}, err
	}
	if currentID == "" || currentID != baseRevisionID {
		return Revision{}, ErrConflict
	}
	current, err := loadRevision(ctx, tx, tenantID, actorID, currentID)
	if err != nil {
		return Revision{}, err
	}
	doc, err := ParseProfileMarkdown(markdown, current.Profile.Name)
	if err != nil {
		return Revision{}, err
	}
	if doc, err = NormalizeDocument(doc); err != nil {
		return Revision{}, err
	}
	revisionID := currentID
	if !bytes.Equal(CanonicalJSON(current.Profile), CanonicalJSON(doc)) {
		var published bool
		revisionID, published, err = publishRevision(ctx, tx, tenantID, actorID, baseRevisionID, doc, "", current.SourceApps)
		if err != nil {
			return Revision{}, err
		}
		if !published {
			return Revision{}, ErrConflict
		}
	}
	revision, err := loadRevision(ctx, tx, tenantID, actorID, revisionID)
	if err != nil {
		return Revision{}, err
	}
	return revision, tx.Commit(ctx)
}

// lockCurrentRevision serializes Profile publication for one Human and returns
// the current Revision ID, empty when there is none.
func lockCurrentRevision(ctx context.Context, tx pgx.Tx, tenantID, actorID string) (string, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('user-profile|' || $1 || '|' || $2,0))`, tenantID, actorID); err != nil {
		return "", err
	}
	var currentID string
	err := tx.QueryRow(ctx, `SELECT revision_id FROM personal_profile_currents WHERE tenant_id=$1 AND owner_actor_id=$2 FOR UPDATE`, tenantID, actorID).Scan(&currentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return currentID, err
}

// publishRevision inserts a normalized Document with its rendered Markdown and
// makes it current only while the current Revision is still baseRevisionID;
// false means it was not published. A published Revision schedules memory.md
// to take it in.
func publishRevision(ctx context.Context, tx pgx.Tx, tenantID, actorID, baseRevisionID string, doc Document, sourceProfileGenerationID string, sourceApps []string) (string, bool, error) {
	revisionID := idgen.New("personal_profile_revision")
	if _, err := tx.Exec(ctx, `INSERT INTO personal_profile_revisions(id,tenant_id,owner_actor_id,prompt_version,markdown,profile,source_profile_generation_id,source_apps) VALUES($1,$2,$3,$4,$5,$6,nullif($7,''),$8)`, revisionID, tenantID, actorID, PromptVersion, renderProfileMarkdown(doc), CanonicalJSON(doc), sourceProfileGenerationID, sourceApps); err != nil {
		return "", false, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO personal_profile_currents(tenant_id,owner_actor_id,revision_id) VALUES($1,$2,$3) ON CONFLICT (tenant_id, owner_actor_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=now() WHERE personal_profile_currents.revision_id=$4`, tenantID, actorID, revisionID, baseRevisionID)
	if err != nil {
		return "", false, err
	}
	if tag.RowsAffected() == 0 {
		return revisionID, false, nil
	}
	if err := enqueueProfileMemorySyncTx(ctx, tx, tenantID, actorID); err != nil {
		return "", false, err
	}
	return revisionID, true, nil
}

func loadRevision(ctx context.Context, tx pgx.Tx, tenantID, actorID, revisionID string) (Revision, error) {
	var revision Revision
	err := tx.QueryRow(ctx, `SELECT id,tenant_id,owner_actor_id,coalesce(source_profile_generation_id,''),prompt_version,markdown,profile,source_apps,created_at FROM personal_profile_revisions WHERE id=$1 AND tenant_id=$2 AND owner_actor_id=$3`, revisionID, tenantID, actorID).Scan(&revision.ID, &revision.TenantID, &revision.OwnerActorID, &revision.SourceProfileGenerationID, &revision.PromptVersion, &revision.Markdown, &revision.Profile, &revision.SourceApps, &revision.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	return revision, err
}
