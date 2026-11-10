package document

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

// RequestMemoryWikiRefreshInput is Memory's request to refresh a Human's Wiki:
// the nightly refresh after closing Date, or, with CaptureID, the refresh of
// the meeting whose transcript became ready.
type RequestMemoryWikiRefreshInput struct {
	TenantID, OwnerActorID, Date string
	CaptureID                    string
}

// MemoryWikiRefreshResult names the Wiki and the refresh the request found or
// admitted.
type MemoryWikiRefreshResult struct {
	WikiID  string
	Refresh WikiRefreshResult
}

const memoryWikiTransactionAttempts = 8

func waitMemoryWikiTransactionRetry(ctx context.Context, attempt int) error {
	timer := time.NewTimer(time.Duration(attempt) * 5 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	return nil
}

// RequestMemoryWikiRefresh requests a refresh of the Human's Wiki, creating
// the Wiki when Memory asks for the Human's first refresh. The nightly refresh
// admits every changed source, its Sessions in the Memory index among them; a
// meeting refresh admits only that meeting's recording Sessions. The refresh
// intent is keyed by the Session set it saw, so the same Sessions do not admit
// a second refresh, while a later publication or a failed refresh lets them be
// evaluated again.
func (s *Service) RequestMemoryWikiRefresh(
	ctx context.Context,
	input RequestMemoryWikiRefreshInput,
) (result MemoryWikiRefreshResult, err error) {
	if s == nil || s.pool == nil || input.TenantID == "" || input.OwnerActorID == "" ||
		input.Date == "" || len(input.Date) > 32 || len(input.CaptureID) > 128 {
		return MemoryWikiRefreshResult{}, ErrInvalidInput
	}
	var accountID string
	if err := s.pool.QueryRow(ctx, `SELECT account_id FROM actors
		WHERE id=$1 AND tenant_id=$2 AND kind='human' AND account_id IS NOT NULL`,
		input.OwnerActorID, input.TenantID).Scan(&accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MemoryWikiRefreshResult{}, ErrNotFound
		}
		return MemoryWikiRefreshResult{}, err
	}
	refreshInput := RequestWikiRefreshInput{AccountID: accountID, TenantID: input.TenantID, CaptureID: input.CaptureID}
	// A meeting refresh freezes no Document, so it binds and waits for none.
	if input.CaptureID == "" {
		if err := s.prepareWikiSources(ctx, refreshInput); err != nil {
			return MemoryWikiRefreshResult{}, err
		}
	}
	for attempt := 1; attempt <= memoryWikiTransactionAttempts; attempt++ {
		result, err = s.requestMemoryWikiRefreshOnce(ctx, input, refreshInput)
		if err == nil || !isRetryableDocumentTransactionError(err) || attempt == memoryWikiTransactionAttempts {
			return result, err
		}
		if waitErr := waitMemoryWikiTransactionRetry(ctx, attempt); waitErr != nil {
			return result, waitErr
		}
	}
	return result, err
}

func (s *Service) requestMemoryWikiRefreshOnce(
	ctx context.Context,
	input RequestMemoryWikiRefreshInput,
	refreshInput RequestWikiRefreshInput,
) (MemoryWikiRefreshResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"memory-wiki-source-set|"+input.TenantID+"|"+input.OwnerActorID); err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	wikiID, err := ensureMemoryWikiRoot(ctx, tx, input.TenantID, input.OwnerActorID)
	if err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	// A source-set hash is not a refresh intent: after settlement or a
	// terminal generation failure the next request must re-evaluate
	// freshness, not replay an obsolete accepted response. A meeting refresh
	// hashes only that meeting's Sessions.
	var stateSHA256, currentRevisionID, failedRefreshID string
	if err := tx.QueryRow(ctx, `SELECT
		encode(sha256(convert_to(coalesce(string_agg(source.source_id||' '||source.version_id,chr(10)
			ORDER BY source.source_id),''),'UTF8')),'hex'),
		coalesce((SELECT current_revision_id FROM personal_wikis WHERE id=$1),''),
		coalesce((SELECT refresh.id FROM document_wiki_refreshes refresh
			WHERE refresh.wiki_id=$1 AND refresh.status='failed'
			  AND refresh.dispatch_last_error_code IS DISTINCT FROM 'candidate_invalid'
			ORDER BY refresh.created_at DESC,refresh.id DESC LIMIT 1),'')
		FROM wiki_session_sources source WHERE source.wiki_id=$1
		  AND ($2='' OR EXISTS(SELECT 1 FROM memory_index.sources session
		    WHERE session.id=source.source_id AND session.tenant_id=source.tenant_id
		      AND session.source_kind='recording_transcript' AND session.metadata->>'capture_id'=$2))`,
		wikiID, input.CaptureID).Scan(&stateSHA256, &currentRevisionID, &failedRefreshID); err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	intent := "memory-wiki-refresh-" + input.Date
	if input.CaptureID != "" {
		intent = stableCreateID("memory-wiki-meeting-", input.Date, input.CaptureID)
	}
	refreshInput.IdempotencyKey = wikiSourceRefreshIntentKey(intent, stateSHA256, currentRevisionID, failedRefreshID)
	requestHash := sha256.Sum256([]byte(input.TenantID))
	refresh, err := s.requestWikiRefreshInTransaction(ctx, tx, refreshInput, requestHash)
	if err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MemoryWikiRefreshResult{}, err
	}
	return MemoryWikiRefreshResult{WikiID: wikiID, Refresh: refresh}, nil
}

func ensureMemoryWikiRoot(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, ownerActorID string,
) (string, error) {
	var eligible bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM actors human
		WHERE human.id=$2 AND human.tenant_id=$1 AND human.kind='human'
		  AND EXISTS(
			SELECT 1 FROM agent_registrations registration
			WHERE registration.tenant_id=human.tenant_id
			  AND registration.represented_human_actor_id=human.id
			  AND registration.agent_type='anotherme' AND registration.status='active'
		  )
	)`, tenantID, ownerActorID).Scan(&eligible); err != nil {
		return "", err
	}
	if !eligible {
		return "", ErrNotFound
	}
	return EnsurePersonalWikiRoot(ctx, tx, tenantID, ownerActorID)
}

// EnsurePersonalWikiRoot creates the Human's Wiki root if it is missing and
// returns its ID. Only write paths call it: binding or uploading a source,
// Memory's refresh request and mail source writes. Reads of a Human with no
// root yet see an empty Wiki.
func EnsurePersonalWikiRoot(ctx context.Context, tx pgx.Tx, tenantID, ownerActorID string) (string, error) {
	if _, err := tx.Exec(ctx, `INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES($1,$2,$3)
		ON CONFLICT (tenant_id,owner_actor_id) WHERE deleted_at IS NULL DO NOTHING`,
		ids.New("wiki"), tenantID, ownerActorID); err != nil {
		return "", err
	}
	var wikiID string
	if err := tx.QueryRow(ctx, `SELECT id FROM personal_wikis
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND deleted_at IS NULL
		FOR SHARE`, tenantID, ownerActorID).Scan(&wikiID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return wikiID, nil
}

// requestWikiRefreshForOwner requests a refresh of the Human's Wiki over every
// changed source, or over the meeting captureID names.
func (s *Service) requestWikiRefreshForOwner(ctx context.Context, tenantID, actorID, idempotencyKey, captureID string) (WikiRefreshResult, error) {
	var accountID string
	if s == nil || s.pool == nil || tenantID == "" || actorID == "" {
		return WikiRefreshResult{}, ErrInvalidInput
	}
	if err := s.pool.QueryRow(ctx, `SELECT account_id FROM actors WHERE id=$1 AND tenant_id=$2 AND kind='human'`, actorID, tenantID).Scan(&accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WikiRefreshResult{}, ErrNotFound
		}
		return WikiRefreshResult{}, fmt.Errorf("lookup Memory Wiki owner: %w", err)
	}
	return s.RequestWikiRefresh(ctx, RequestWikiRefreshInput{AccountID: accountID, TenantID: tenantID, IdempotencyKey: idempotencyKey, CaptureID: captureID})
}

func wikiSourceRefreshIntentKey(prefix, stateHash, revisionID, failedRefreshID string) string {
	if revisionID == "" && failedRefreshID == "" {
		return prefix + "-" + stateHash
	}
	return stableCreateID("wiki-source-intent-", prefix, stateHash, revisionID, failedRefreshID)
}
