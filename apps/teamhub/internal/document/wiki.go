package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const wikiRefreshOperation = "document.wiki.refresh"

// A Wiki Revision holds at most maxWikiPages pages, so one candidate request
// carries at most that many base pages. It carries at most
// maxWikiCandidateSourceChanges added, modified, and removed sources.
const (
	maxWikiPages                  = 10000
	maxWikiCandidateSourceChanges = 1000
)

// wikiCandidateItemBytesSQL estimates one source or base page in the encoded
// candidate request: Base64 of item.size_bytes plus a metadata allowance.
// Admission uses it against maxWikiCandidateRequestBytes so an oversized batch
// is refused before a doomed refresh is queued; dispatch still counts exactly.
const wikiCandidateItemBytesSQL = `((item.size_bytes+2)/3)*4+1024`

var wikiPageKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]*\.md$`)

// WikiRefreshTooLargeError rejects a refresh whose changed sources and base
// pages cannot fit one LLM Wiki candidate request: too many changed sources,
// or too many bytes once encoded.
type WikiRefreshTooLargeError struct {
	ChangedSources int
	EstimatedBytes int64
}

func (e *WikiRefreshTooLargeError) Error() string {
	if e.ChangedSources > 0 {
		return fmt.Sprintf("Wiki refresh adds, changes, or removes %d sources at once, above the %d limit; change fewer Wiki sources before refreshing",
			e.ChangedSources, maxWikiCandidateSourceChanges)
	}
	return fmt.Sprintf("Wiki refresh input is about %d MiB after encoding, above the %d MiB limit; remove some Wiki sources before refreshing",
		(e.EstimatedBytes+(1<<20)-1)>>20, int64(maxWikiCandidateRequestBytes)>>20)
}
func (e *WikiRefreshTooLargeError) Unwrap() error { return ErrInvalidInput }

type WikiRefreshStatus string

const (
	WikiRefreshAccepted      WikiRefreshStatus = "accepted"
	WikiRefreshAlreadyLatest WikiRefreshStatus = "already_latest"
	WikiRefreshInProgress    WikiRefreshStatus = "in_progress"
	WikiRefreshNoSources     WikiRefreshStatus = "no_sources"
)

// RequestWikiRefreshInput asks for one Wiki refresh. IdempotencyKey replays an
// earlier request with the same key. Without CaptureID the refresh admits
// every changed source (the nightly refresh); with it, only the current
// recording Sessions of that meeting, every other source keeping its
// published version.
type RequestWikiRefreshInput struct {
	AccountID, TenantID, IdempotencyKey string
	CaptureID                           string
	// commandID derives the refresh's IDs: the key, or a fresh ID without one.
	commandID string
}

type WikiRefreshResult struct {
	ID, WikiID, WikiRevisionID string
	GeneratorAgentActorID      string
	Status                     WikiRefreshStatus
	Replayed                   bool
}

type WikiPageCandidate struct {
	PageKey  string
	Markdown []byte
}

// settleWikiRefreshInput carries a candidate set validated and sorted by
// normalizeWikiCandidates, with its set hash.
type settleWikiRefreshInput struct {
	RefreshID, GeneratorAgentActorID string
	Candidates                       []WikiPageCandidate
	CandidateHash                    string
	// Unsettled are frozen sources the candidate failed to write; they stay
	// pending for a later refresh and spend one of their tries.
	Unsettled []WikiCandidateSourceReference
	// Deferred are frozen sources left unwritten only because the
	// generation's budget ran out; they stay pending without spending a try.
	Deferred []WikiCandidateSourceReference
}

// maxWikiUnsettledTries is how many refreshes may leave one source version
// unwritten before it settles anyway.
const maxWikiUnsettledTries = 3

type WikiRefreshSettlementStatus string

const (
	WikiRefreshSettled    WikiRefreshSettlementStatus = "settled"
	WikiRefreshConflicted WikiRefreshSettlementStatus = "conflicted"
)

type WikiRefreshSettlementResult struct {
	RefreshID, WikiRevisionID, OwnerActorID string
	Status                                  WikiRefreshSettlementStatus
	Replayed                                bool
}

// WikiDocumentPage is one page of the published Wiki: its page Document and
// that Document's current Markdown Version.
type WikiDocumentPage struct {
	PageKey, DocumentID, DocumentVersionID string
	MediaType, SHA256                      string
	SizeBytes                              int64
	objectKey                              string
}

type WikiDocumentRevision struct {
	IsCurrent   bool
	State       string
	ID          string
	PublishedAt time.Time
	Pages       []WikiDocumentPage
}

// wikiPageObject is the stored Markdown of one candidate page whose content
// differs from its page Document's current Version.
type wikiPageObject struct {
	Key, SHA256 string
	SizeBytes   int64
}

// settleWikiRefresh stores the Markdown of every changed page and publishes
// the candidate set in one transaction. A page whose Markdown equals its
// current Version keeps that Version.
func (s *Service) settleWikiRefresh(
	ctx context.Context,
	input settleWikiRefreshInput,
) (WikiRefreshSettlementResult, error) {
	if s == nil || s.pool == nil || s.objects == nil || input.RefreshID == "" ||
		input.GeneratorAgentActorID == "" || len(input.Candidates) == 0 || input.CandidateHash == "" {
		return WikiRefreshSettlementResult{}, ErrInvalidInput
	}
	objects, err := s.storeWikiPageObjects(ctx, input)
	if err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	var result WikiRefreshSettlementResult
	err = retryWikiTransaction(ctx, func() error {
		var failure error
		result, failure = s.commitWikiRefreshSettlementOnce(ctx, input, objects)
		return failure
	})
	return result, err
}

// storeWikiPageObjects writes, before the settlement transaction, the
// Markdown of each candidate whose page has no Version with that content. The
// object key is derived from the content, so a retry writes nothing new.
func (s *Service) storeWikiPageObjects(
	ctx context.Context,
	input settleWikiRefreshInput,
) (map[string]wikiPageObject, error) {
	rows, err := s.pool.Query(ctx, `SELECT page.page_key,coalesce(version.sha256,'')
		FROM document_wiki_refreshes refresh
		JOIN document_wiki_pages page ON page.wiki_id=refresh.wiki_id AND page.tenant_id=refresh.tenant_id
		JOIN documents document ON document.id=page.document_id AND document.tenant_id=page.tenant_id
		LEFT JOIN document_versions version ON version.id=document.current_version_id
		 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
		WHERE refresh.id=$1`, input.RefreshID)
	if err != nil {
		return nil, err
	}
	current := make(map[string]string)
	for rows.Next() {
		var pageKey, sha string
		if err := rows.Scan(&pageKey, &sha); err != nil {
			rows.Close()
			return nil, err
		}
		current[pageKey] = sha
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var tenantID string
	if err := s.pool.QueryRow(ctx, `SELECT tenant_id FROM document_wiki_refreshes WHERE id=$1`,
		input.RefreshID).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	objects := make(map[string]wikiPageObject)
	for _, candidate := range input.Candidates {
		digest := sha256.Sum256(candidate.Markdown)
		sha := hex.EncodeToString(digest[:])
		if current[candidate.PageKey] == sha {
			continue
		}
		// Object keys have one fixed shape, object_ and 32 hex digits.
		key := stableCreateID("object_", "wiki_page", tenantID, sha)
		object, _, err := s.objects.PutIfAbsent(ctx, key, bytes.NewReader(candidate.Markdown),
			int64(len(candidate.Markdown)), digest)
		if err != nil || object.Key != key || object.Size != int64(len(candidate.Markdown)) {
			if err == nil {
				err = ErrObjectStoreUnavailable
			}
			return nil, errors.Join(ErrObjectStoreUnavailable, err)
		}
		objects[candidate.PageKey] = wikiPageObject{Key: key, SHA256: sha, SizeBytes: object.Size}
	}
	return objects, nil
}

// finishFailedWikiRefresh runs in the transaction that fails a refresh. The
// refresh keeps its frozen sources until the next admission for its Wiki: a
// follow-up compares them with the current sources. The follow-up is
// enqueued only when a nightly request arrived while the refresh ran.
func finishFailedWikiRefresh(ctx context.Context, tx pgx.Tx, refreshID string, followupRequested bool) error {
	if !followupRequested {
		return nil
	}
	return jobs.InsertTx(ctx, tx, WikiRefreshFollowupArgs{RefreshID: refreshID}, nil)
}

// normalizeWikiCandidates is the one check of a generated candidate set: page
// count, keys and sizes. It sorts the pages and returns the set hash that
// settlement stores and a replay compares.
func normalizeWikiCandidates(input []WikiPageCandidate) ([]WikiPageCandidate, string, error) {
	if len(input) < 1 || len(input) > maxWikiPages {
		return nil, "", ErrInvalidInput
	}
	result := append([]WikiPageCandidate(nil), input...)
	sort.Slice(result, func(i, j int) bool { return result[i].PageKey < result[j].PageKey })
	hash := sha256.New()
	previous := ""
	for _, candidate := range result {
		if !validWikiPageKey(candidate.PageKey) || candidate.PageKey == previous ||
			len(candidate.Markdown) < 1 || len(candidate.Markdown) > 16<<20 {
			return nil, "", ErrInvalidInput
		}
		previous = candidate.PageKey
		markdownHash := sha256.Sum256(candidate.Markdown)
		_, _ = hash.Write([]byte(candidate.PageKey + "\x00"))
		_, _ = hash.Write(markdownHash[:])
	}
	return result, fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func validWikiPageKey(value string) bool {
	return len(value) <= 512 && value == strings.ToLower(value) &&
		wikiPageKeyPattern.MatchString(value) && !strings.Contains(value, "//") &&
		!strings.Contains("/"+value+"/", "/../") && !strings.Contains("/"+value+"/", "/./")
}

// conflictWikiRefresh ends a staging refresh whose Wiki was published from
// another base after admission, without generating against that base.
func (s *Service) conflictWikiRefresh(ctx context.Context, refreshID string) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := conflictWikiRefreshTx(ctx, tx, refreshID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// conflictWikiRefreshTx marks a staging refresh conflicted and queues its
// follow-up, which admits the same meeting, or every changed source after a
// nightly request, against the current base.
func conflictWikiRefreshTx(ctx context.Context, tx pgx.Tx, refreshID string) error {
	tag, err := tx.Exec(ctx, `UPDATE document_wiki_refreshes
		SET status='conflicted',preview_pages=NULL,preview_revision=0,outcome='conflicted',updated_at=clock_timestamp()
		WHERE id=$1 AND status='staging'`, refreshID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	if err := jobs.InsertTx(ctx, tx, WikiRefreshFollowupArgs{RefreshID: refreshID}, nil); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM document_wiki_refresh_sources WHERE refresh_id=$1`, refreshID)
	return err
}

type wikiPageHead struct {
	DocumentID, VersionID, SHA256, BindingStatus string
	VersionNumber                                int
}

// wikiRefreshSettlementState is the locked refresh row a settlement
// attempt reads.
type wikiRefreshSettlementState struct {
	tenantID, wikiID, baseRevisionID, status, storedHash, resultRevisionID string
	followupRequested, sourcesDeferred                                     bool
}

// settlementWikiHead is the locked Wiki a settlement publishes into.
type settlementWikiHead struct {
	currentRevisionID, ownerActorID string
	publishedGeneration             int64
}

func (s *Service) commitWikiRefreshSettlementOnce(
	ctx context.Context,
	input settleWikiRefreshInput,
	objects map[string]wikiPageObject,
) (WikiRefreshSettlementResult, error) {
	refreshID, generatorActorID := input.RefreshID, input.GeneratorAgentActorID
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	refresh, err := lockWikiRefreshForSettlement(ctx, tx, refreshID, generatorActorID)
	if err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	if refresh.status == "settled" {
		if refresh.storedHash != input.CandidateHash {
			return WikiRefreshSettlementResult{}, ErrIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return WikiRefreshSettlementResult{}, err
		}
		return WikiRefreshSettlementResult{
			RefreshID: refreshID, WikiRevisionID: refresh.resultRevisionID,
			Status: WikiRefreshSettled, Replayed: true,
		}, nil
	}
	if refresh.status != "staging" {
		return WikiRefreshSettlementResult{}, ErrVersionConflict
	}
	wiki, err := lockSettlementWiki(ctx, tx, generatorActorID, refresh)
	if err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	if wiki.currentRevisionID != refresh.baseRevisionID {
		if err := conflictWikiRefreshTx(ctx, tx, refreshID); err != nil {
			return WikiRefreshSettlementResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return WikiRefreshSettlementResult{}, err
		}
		return WikiRefreshSettlementResult{RefreshID: refreshID, Status: WikiRefreshConflicted}, nil
	}
	// Canonical order: every Document this settlement writes (the Wiki's bound
	// sources and pages, plus the frozen source Documents) is locked before the
	// first delivery Account lock below.
	if err := lockWikiRefreshDocuments(ctx, tx, refresh.tenantID, refresh.wikiID, refreshID); err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	changedDocumentIDs, err := applyWikiPageCandidates(ctx, tx, input, objects, refresh)
	if err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	wikiRevisionID := stableCreateID("document_wiki_revision_", refreshID)
	if err := publishWikiRevision(ctx, tx, input, refresh, wiki, wikiRevisionID); err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	if len(changedDocumentIDs) > 0 {
		if err := RecomputeWikiAllActorAccess(ctx, tx, refresh.tenantID, refresh.wikiID, generatorActorID); err != nil {
			return WikiRefreshSettlementResult{}, err
		}
		if err := AppendBindingUpdatedEvents(ctx, tx, refresh.tenantID, generatorActorID,
			stableCreateID("document_wiki_binding_set_", refreshID), changedDocumentIDs); err != nil {
			return WikiRefreshSettlementResult{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_refresh_sources WHERE refresh_id=$1`, refreshID); err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WikiRefreshSettlementResult{}, err
	}
	return WikiRefreshSettlementResult{
		RefreshID: refreshID, WikiRevisionID: wikiRevisionID, OwnerActorID: wiki.ownerActorID,
		Status: WikiRefreshSettled,
	}, nil
}

// lockWikiRefreshForSettlement locks the generator's refresh row.
func lockWikiRefreshForSettlement(
	ctx context.Context,
	tx pgx.Tx,
	refreshID, generatorActorID string,
) (wikiRefreshSettlementState, error) {
	var refresh wikiRefreshSettlementState
	err := tx.QueryRow(ctx, `SELECT tenant_id,wiki_id,
		coalesce(base_wiki_revision_id,''),status,coalesce(candidate_set_hash,''),
		coalesce(result_wiki_revision_id,''),followup_requested,sources_deferred
		FROM document_wiki_refreshes
		WHERE id=$1 AND generator_agent_actor_id=$2
		FOR UPDATE`, refreshID, generatorActorID).Scan(
		&refresh.tenantID, &refresh.wikiID, &refresh.baseRevisionID, &refresh.status,
		&refresh.storedHash, &refresh.resultRevisionID, &refresh.followupRequested, &refresh.sourcesDeferred,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return wikiRefreshSettlementState{}, ErrNotFound
	}
	if err != nil {
		return wikiRefreshSettlementState{}, err
	}
	return refresh, nil
}

// lockSettlementWiki requires the generator to be still active and locks the
// Wiki the refresh publishes into.
func lockSettlementWiki(
	ctx context.Context,
	tx pgx.Tx,
	generatorActorID string,
	refresh wikiRefreshSettlementState,
) (settlementWikiHead, error) {
	var generatorActive bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_registrations
		WHERE actor_id=$1 AND tenant_id=$2 AND status='active')`,
		generatorActorID, refresh.tenantID).Scan(&generatorActive); err != nil {
		return settlementWikiHead{}, err
	}
	if !generatorActive {
		return settlementWikiHead{}, ErrVersionConflict
	}
	var wiki settlementWikiHead
	if err := tx.QueryRow(ctx, `SELECT coalesce(current_revision_id,''),owner_actor_id,published_generation
		FROM personal_wikis WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`,
		refresh.wikiID, refresh.tenantID).Scan(&wiki.currentRevisionID, &wiki.ownerActorID, &wiki.publishedGeneration); err != nil {
		return settlementWikiHead{}, err
	}
	return wiki, nil
}

// applyWikiPageCandidates writes the candidate pages and retires the pages
// the candidate set dropped. It returns the Documents whose Binding changed.
func applyWikiPageCandidates(
	ctx context.Context,
	tx pgx.Tx,
	input settleWikiRefreshInput,
	objects map[string]wikiPageObject,
	refresh wikiRefreshSettlementState,
) ([]string, error) {
	refreshID, generatorActorID := input.RefreshID, input.GeneratorAgentActorID
	tenantID, wikiID := refresh.tenantID, refresh.wikiID
	heads, err := loadWikiPageHeads(ctx, tx, tenantID, wikiID)
	if err != nil {
		return nil, err
	}
	changedDocumentIDs := make([]string, 0)
	pageKeys := make([]string, 0, len(input.Candidates))
	for _, candidate := range input.Candidates {
		pageKeys = append(pageKeys, candidate.PageKey)
		head, mapped := heads[candidate.PageKey]
		digest := sha256.Sum256(candidate.Markdown)
		sha := hex.EncodeToString(digest[:])
		object, stored := objects[candidate.PageKey]
		if (!mapped || head.SHA256 != sha) && (!stored || object.SHA256 != sha) {
			// The page changed after its object was prepared; the next attempt
			// prepares it again.
			return nil, ErrVersionConflict
		}
		if !mapped {
			documentID, err := createWikiPageDocument(ctx, tx, tenantID, wikiID, refreshID,
				generatorActorID, candidate.PageKey, object)
			if err != nil {
				return nil, err
			}
			changedDocumentIDs = append(changedDocumentIDs, documentID)
			continue
		}
		if head.SHA256 != sha {
			if err := writeWikiPageVersion(ctx, tx, tenantID, refreshID, generatorActorID,
				candidate.PageKey, head, object); err != nil {
				return nil, err
			}
		}
		if head.BindingStatus != "active" {
			// A candidate that reuses a retired page key revives that page.
			if _, err := tx.Exec(ctx, `UPDATE document_context_bindings
				SET status='active',access_epoch=access_epoch+1,updated_at=clock_timestamp()
				WHERE wiki_id=$1 AND tenant_id=$2 AND document_id=$3
				  AND binding_kind='wiki_page' AND status='suspended'`,
				wikiID, tenantID, head.DocumentID); err != nil {
				return nil, err
			}
			changedDocumentIDs = append(changedDocumentIDs, head.DocumentID)
		}
	}
	// A complete candidate may remove a content page. Retire only its Binding,
	// not the Document and its Versions.
	rows, err := tx.Query(ctx, `UPDATE document_context_bindings binding
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		FROM document_wiki_pages page
		WHERE binding.wiki_id=$1 AND binding.tenant_id=$2 AND binding.binding_kind='wiki_page'
		  AND binding.status='active' AND page.wiki_id=binding.wiki_id
		  AND page.document_id=binding.document_id AND page.tenant_id=binding.tenant_id
		  AND NOT (page.page_key=ANY($3::text[]))
		RETURNING binding.document_id`, wikiID, tenantID, pageKeys)
	if err != nil {
		return nil, err
	}
	retired, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	return append(changedDocumentIDs, retired...), nil
}

// publishWikiRevision makes the refresh's revision current, replaces the
// published sources with its frozen ones, and enqueues the work the new
// revision needs. A source the candidate left unwritten keeps its earlier
// published version, or none, so the follow-up refresh writes it again; a
// version that failed maxWikiUnsettledTries times settles with an error log.
// A deferred source spends no try, so the follow-up is queued for it only
// when this refresh published some other change: a refresh that wrote
// nothing leaves its deferred sources to the next nightly refresh.
func publishWikiRevision(
	ctx context.Context,
	tx pgx.Tx,
	input settleWikiRefreshInput,
	refresh wikiRefreshSettlementState,
	wiki settlementWikiHead,
	wikiRevisionID string,
) error {
	refreshID, tenantID, wikiID := input.RefreshID, refresh.tenantID, refresh.wikiID
	generation := wiki.publishedGeneration + 1
	deferred, err := frozenWikiSourceDocuments(ctx, tx, refreshID, input.Deferred)
	if err != nil {
		return err
	}
	counted, err := recordWikiUnsettledSources(ctx, tx, wikiID, refreshID, input.Unsettled, deferred)
	if err != nil {
		return err
	}
	pending := append(slices.Clone(counted), deferred...)
	// Whether this refresh publishes any changed source besides the pending ones.
	var progressed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_wiki_refresh_sources source
		WHERE source.refresh_id=$2 AND NOT (source.document_id=ANY($3::text[]))
		  AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources published
		    WHERE published.wiki_id=$1 AND published.document_id=source.document_id
		      AND published.document_version_id=source.frozen_document_version_id))`,
		wikiID, refreshID, pending).Scan(&progressed); err != nil {
		return err
	}
	// A pending source keeps the version an earlier refresh published.
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_published_sources
		WHERE wiki_id=$1 AND NOT (document_id=ANY($2::text[]))`, wikiID, pending); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_wiki_published_sources(
		wiki_id,tenant_id,document_id,document_version_id
	)
	SELECT $1,source.tenant_id,source.document_id,source.frozen_document_version_id
	FROM document_wiki_refresh_sources source
	WHERE source.refresh_id=$2 AND NOT (source.document_id=ANY($3::text[]))`,
		wikiID, refreshID, pending); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE document_wiki_refreshes
		SET status='settled',preview_pages=NULL,preview_revision=0,result_wiki_revision_id=$2,outcome='applied',
			candidate_set_hash=$3,updated_at=clock_timestamp()
		WHERE id=$1 AND status='staging'`, refreshID, wikiRevisionID, input.CandidateHash); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE personal_wikis SET current_revision_id=$2,
		published_generation=$3,published_at=clock_timestamp(),updated_at=clock_timestamp()
		WHERE id=$1`, wikiID, wikiRevisionID, generation); err != nil {
		return err
	}
	// Readers see only the current Wiki and no other refresh runs, so the
	// earlier finished refreshes go.
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_refreshes
		WHERE wiki_id=$1 AND id<>$2`, wikiID, refreshID); err != nil {
		return err
	}
	if err := jobs.InsertTx(ctx, tx, PersonalWikiGraphUpdateArgs{
		TenantID: tenantID, WikiID: wikiID,
		OwnerActorID: wiki.ownerActorID, WikiRevisionID: wikiRevisionID,
	}, nil); err != nil {
		return err
	}
	if refresh.followupRequested || refresh.sourcesDeferred || len(counted) > 0 ||
		(len(deferred) > 0 && progressed) {
		if err := jobs.InsertTx(ctx, tx, WikiRefreshFollowupArgs{RefreshID: refreshID}, nil); err != nil {
			return err
		}
	}
	return nil
}

// frozenWikiSourceDocuments returns the Documents of the refresh's frozen
// sources among these references.
func frozenWikiSourceDocuments(
	ctx context.Context,
	tx pgx.Tx,
	refreshID string,
	sources []WikiCandidateSourceReference,
) ([]string, error) {
	versions := make([]string, len(sources))
	for i, source := range sources {
		versions[i] = source.DocumentVersionID
	}
	rows, err := tx.Query(ctx, `SELECT document_id FROM document_wiki_refresh_sources
		WHERE refresh_id=$1 AND frozen_document_version_id=ANY($2::text[])`, refreshID, versions)
	if err != nil {
		return nil, err
	}
	documents, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if documents == nil {
		documents = []string{}
	}
	return documents, err
}

// recordWikiUnsettledSources counts one more try for each frozen source the
// candidate failed to write and returns the Documents that stay pending. A
// version at its last try settles instead. A deferred source keeps its count
// unchanged, and a source this refresh wrote is no longer counted.
func recordWikiUnsettledSources(
	ctx context.Context,
	tx pgx.Tx,
	wikiID, refreshID string,
	unsettled []WikiCandidateSourceReference,
	deferred []string,
) ([]string, error) {
	versions := make([]string, len(unsettled))
	for i, source := range unsettled {
		versions[i] = source.DocumentVersionID
	}
	rows, err := tx.Query(ctx, `INSERT INTO document_wiki_unsettled_sources AS counted(
		wiki_id,tenant_id,document_id,document_version_id,tries
	)
	SELECT $1,source.tenant_id,source.document_id,source.frozen_document_version_id,1
	FROM document_wiki_refresh_sources source
	WHERE source.refresh_id=$2 AND source.frozen_document_version_id=ANY($3::text[])
	ON CONFLICT (wiki_id,document_id) DO UPDATE SET
		tries=CASE WHEN counted.document_version_id=EXCLUDED.document_version_id
			THEN counted.tries+1 ELSE 1 END,
		document_version_id=EXCLUDED.document_version_id
	RETURNING document_id,document_version_id,tries`, wikiID, refreshID, versions)
	if err != nil {
		return nil, err
	}
	type counted struct {
		documentID, versionID string
		tries                 int
	}
	all, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (counted, error) {
		var c counted
		return c, row.Scan(&c.documentID, &c.versionID, &c.tries)
	})
	if err != nil {
		return nil, err
	}
	pending := []string{}
	for _, source := range all {
		if source.tries < maxWikiUnsettledTries {
			pending = append(pending, source.documentID)
			continue
		}
		slog.Default().Error("document.wiki_source_settled_unwritten",
			"wiki_id", wikiID, "refresh_id", refreshID,
			"document_id", source.documentID, "document_version_id", source.versionID,
			"tries", source.tries)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_unsettled_sources
		WHERE wiki_id=$1 AND NOT (document_id=ANY($2::text[]))`,
		wikiID, append(slices.Clone(pending), deferred...)); err != nil {
		return nil, err
	}
	return pending, nil
}

func loadWikiPageHeads(ctx context.Context, tx pgx.Tx, tenantID, wikiID string) (map[string]wikiPageHead, error) {
	rows, err := tx.Query(ctx, `SELECT page.page_key,page.document_id,
		coalesce(version.id,''),coalesce(version.sha256,''),coalesce(version.version_number,0),
		binding.status
		FROM document_wiki_pages page
		JOIN documents document ON document.id=page.document_id AND document.tenant_id=page.tenant_id
		JOIN document_context_bindings binding ON binding.document_id=page.document_id
		 AND binding.tenant_id=page.tenant_id AND binding.wiki_id=page.wiki_id
		 AND binding.binding_kind='wiki_page'
		LEFT JOIN document_versions version ON version.id=document.current_version_id
		 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
		WHERE page.wiki_id=$1 AND page.tenant_id=$2
		ORDER BY page.document_id FOR UPDATE OF document`, wikiID, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	heads := make(map[string]wikiPageHead)
	for rows.Next() {
		var pageKey string
		var head wikiPageHead
		if err := rows.Scan(&pageKey, &head.DocumentID, &head.VersionID, &head.SHA256,
			&head.VersionNumber, &head.BindingStatus); err != nil {
			return nil, err
		}
		heads[pageKey] = head
	}
	return heads, rows.Err()
}

// createWikiPageDocument creates the read-only Markdown file Document of a new
// page, its first Version, its page Binding and its page mapping.
func createWikiPageDocument(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, wikiID, refreshID, generatorActorID, pageKey string,
	object wikiPageObject,
) (string, error) {
	documentID := stableCreateID("document_", refreshID, pageKey)
	versionID := stableCreateID("document_version_wiki_page_", documentID, "1", object.SHA256)
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,'markdown',$4,'agent',$4,'agent','active')`,
		documentID, tenantID, wikiPageTitle(pageKey), generatorActorID); err != nil {
		return "", err
	}
	if err := insertWikiPageVersion(ctx, tx, tenantID, documentID, versionID, 1,
		pageKey, generatorActorID, object); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2
		WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`,
		documentID, versionID, tenantID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,wiki_id,status,role
	) VALUES($1,$2,$3,'wiki_page',$4,'active','viewer')`,
		stableCreateID("document_binding_wiki_", refreshID, pageKey), tenantID, documentID, wikiID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_wiki_pages(
		wiki_id,tenant_id,page_key,document_id
	) VALUES($1,$2,$3,$4)`, wikiID, tenantID, pageKey, documentID); err != nil {
		return "", err
	}
	return documentID, appendLifecycleEvent(ctx, tx, tenantID, documentID, generatorActorID,
		versionID, "document_version", "document.created")
}

// writeWikiPageVersion makes changed Markdown the page Document's current
// Version.
func writeWikiPageVersion(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, refreshID, generatorActorID, pageKey string,
	head wikiPageHead,
	object wikiPageObject,
) error {
	versionNumber := head.VersionNumber + 1
	versionID := stableCreateID("document_version_wiki_page_", head.DocumentID,
		strconv.Itoa(versionNumber), object.SHA256, refreshID)
	if err := insertWikiPageVersion(ctx, tx, tenantID, head.DocumentID, versionID, versionNumber,
		pageKey, generatorActorID, object); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE documents
		SET current_version_id=$3,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$2 AND current_version_id IS NOT DISTINCT FROM nullif($4,'')
		  AND status='active'`, head.DocumentID, tenantID, versionID, head.VersionID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrVersionConflict
	}
	return appendLifecycleEvent(ctx, tx, tenantID, head.DocumentID, generatorActorID,
		versionID, "document_version", "document.version_created")
}

func insertWikiPageVersion(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, documentID, versionID string,
	versionNumber int,
	pageKey, generatorActorID string,
	object wikiPageObject,
) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,
		media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES($1,$2,$3,$4,$5,'markdown','text/markdown',$6,$7,$8,'wiki_page',$9)`,
		versionID, tenantID, documentID, versionNumber, path.Base(pageKey),
		object.SizeBytes, object.SHA256, object.Key, generatorActorID)
	return err
}

func (s *Service) GetCurrentWikiDocumentRevision(
	ctx context.Context,
	actorID string,
) (WikiDocumentRevision, error) {
	if s == nil || s.pool == nil || actorID == "" {
		return WikiDocumentRevision{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return WikiDocumentRevision{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, wikiID, tenantID, err := loadCurrentWikiPages(ctx, tx, actorID)
	if errors.Is(err, ErrNotFound) {
		// A first failed generation has no published pages, but waiters still
		// need its terminal state. Missing/non-Human actors remain not found.
		ownerTenant, ownerErr := store.New(tx).GetHumanActorTenantID(ctx, actorID)
		if errors.Is(ownerErr, pgx.ErrNoRows) {
			return WikiDocumentRevision{}, ErrNotFound
		}
		if ownerErr != nil {
			return WikiDocumentRevision{}, ownerErr
		}
		state, stateErr := LoadWikiRefreshState(ctx, tx, ownerTenant, actorID)
		if stateErr != nil {
			return WikiDocumentRevision{}, stateErr
		}
		if state.State == "failed" {
			return WikiDocumentRevision{}, ErrWikiGenerationFailed
		}
	}
	if err != nil {
		return WikiDocumentRevision{}, err
	}
	// Waiters must see a terminal failure instead of polling until timeout.
	state, err := LoadWikiRefreshState(ctx, tx, tenantID, actorID)
	if err != nil {
		return WikiDocumentRevision{}, err
	}
	result.State = state.State
	result.IsCurrent, err = wikiSourcesMatchPublished(ctx, tx, wikiID)
	return result, err
}

// loadCurrentWikiPages reads a Human's published Wiki: its current revision
// and every active page with the page Document's current Version.
func loadCurrentWikiPages(ctx context.Context, tx pgx.Tx, actorID string) (WikiDocumentRevision, string, string, error) {
	rows, err := tx.Query(ctx, `SELECT wiki.id,wiki.tenant_id,wiki.current_revision_id,wiki.published_at,
		page.page_key,page.document_id,version.id,version.media_type,version.size_bytes,
		version.sha256,version.content_object_id
		FROM actors actor
		JOIN personal_wikis wiki ON wiki.owner_actor_id=actor.id AND wiki.tenant_id=actor.tenant_id
		 AND wiki.deleted_at IS NULL AND wiki.current_revision_id IS NOT NULL
		JOIN document_wiki_pages page ON page.wiki_id=wiki.id AND page.tenant_id=wiki.tenant_id
		JOIN documents document ON document.id=page.document_id
		 AND document.tenant_id=page.tenant_id AND document.status='active'
		JOIN document_context_bindings binding ON binding.document_id=page.document_id
		 AND binding.tenant_id=page.tenant_id AND binding.wiki_id=wiki.id
		 AND binding.binding_kind='wiki_page' AND binding.status='active'
		JOIN document_versions version ON version.id=document.current_version_id
		 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
		WHERE actor.id=$1 AND actor.kind='human'
		ORDER BY page.page_key COLLATE "C"`, actorID)
	if err != nil {
		return WikiDocumentRevision{}, "", "", err
	}
	defer rows.Close()
	var result WikiDocumentRevision
	var wikiID, tenantID string
	for rows.Next() {
		var page WikiDocumentPage
		if err := rows.Scan(&wikiID, &tenantID, &result.ID, &result.PublishedAt, &page.PageKey,
			&page.DocumentID, &page.DocumentVersionID, &page.MediaType, &page.SizeBytes,
			&page.SHA256, &page.objectKey); err != nil {
			return WikiDocumentRevision{}, "", "", err
		}
		result.Pages = append(result.Pages, page)
	}
	if err := rows.Err(); err != nil {
		return WikiDocumentRevision{}, "", "", err
	}
	if result.ID == "" || len(result.Pages) == 0 {
		return WikiDocumentRevision{}, "", "", ErrNotFound
	}
	return result, wikiID, tenantID, nil
}

// OpenWikiDocumentVersion opens the Markdown of one page of the Human's
// current Wiki. Memory reads it to index the published Wiki.
func (s *Service) OpenWikiDocumentVersion(
	ctx context.Context,
	actorID, wikiRevisionID, documentID, documentVersionID string,
) (io.ReadCloser, error) {
	if s == nil || s.pool == nil || s.objects == nil || actorID == "" || wikiRevisionID == "" ||
		documentID == "" || documentVersionID == "" {
		return nil, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	revision, _, _, err := loadCurrentWikiPages(ctx, tx, actorID)
	if err != nil {
		return nil, err
	}
	if revision.ID != wikiRevisionID {
		return nil, ErrNotFound
	}
	for _, page := range revision.Pages {
		if page.DocumentID == documentID && page.DocumentVersionID == documentVersionID {
			reader, err := s.objects.Open(ctx, page.objectKey)
			if err != nil {
				return nil, errors.Join(ErrObjectStoreUnavailable, err)
			}
			return reader, nil
		}
	}
	return nil, ErrNotFound
}

// lockWikiRefreshDocuments takes the advisory Document locks for the Wiki's
// bound sources and pages and the refresh's frozen source Documents in one
// sorted call.
func lockWikiRefreshDocuments(ctx context.Context, tx pgx.Tx, tenantID, wikiID, refreshID string) error {
	rows, err := tx.Query(ctx, `SELECT binding.document_id FROM document_context_bindings binding
		WHERE binding.tenant_id=$1 AND binding.wiki_id=$2
		 AND binding.binding_kind IN ('wiki_source','wiki_page')
		UNION
		SELECT source.document_id FROM document_wiki_refresh_sources source
		WHERE source.refresh_id=$3 AND source.source_kind='document'`, tenantID, wikiID, refreshID)
	if err != nil {
		return err
	}
	documentIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	return Lock(ctx, tx, documentIDs)
}

func wikiPageTitle(pageKey string) string {
	base := strings.TrimSuffix(path.Base(pageKey), path.Ext(pageKey))
	base = strings.ReplaceAll(strings.ReplaceAll(base, "-", " "), "_", " ")
	if base == "" {
		return "Untitled"
	}
	return strings.ToUpper(base[:1]) + base[1:]
}

func (s *Service) RequestWikiRefresh(
	ctx context.Context,
	input RequestWikiRefreshInput,
) (WikiRefreshResult, error) {
	if s == nil || s.pool == nil || input.AccountID == "" || input.TenantID == "" ||
		len(input.IdempotencyKey) > 255 || len(input.CaptureID) > 128 {
		return WikiRefreshResult{}, ErrInvalidInput
	}
	input.commandID = input.IdempotencyKey
	if input.commandID == "" {
		input.commandID = idgen.New("wiki_refresh_command")
	}
	requestHash := sha256.Sum256([]byte(input.TenantID))
	// A stored command replays in the transaction below, so it needs no source preparation.
	_, replayed, lookupErr := idempotency.Lookup(ctx, s.pool, idempotency.AccountKey(input.AccountID, wikiRefreshOperation, input.IdempotencyKey), requestHash[:])
	if errors.Is(lookupErr, idempotency.ErrConflict) {
		replayed = true
	} else if lookupErr != nil {
		return WikiRefreshResult{}, lookupErr
	}
	var result WikiRefreshResult
	var err error
	for attempt := 1; attempt <= memoryWikiTransactionAttempts; attempt++ {
		if !replayed && attempt == 1 && input.CaptureID == "" {
			if prepareErr := s.prepareWikiSources(ctx, input); prepareErr != nil {
				return WikiRefreshResult{}, prepareErr
			}
		}
		tx, beginErr := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
		if beginErr != nil {
			return WikiRefreshResult{}, beginErr
		}
		result, err = s.requestWikiRefreshInTransaction(ctx, tx, input, requestHash)
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if err == nil || !isRetryableDocumentTransactionError(err) || attempt == memoryWikiTransactionAttempts {
			return result, err
		}
		if waitErr := waitMemoryWikiTransactionRetry(ctx, attempt); waitErr != nil {
			return result, waitErr
		}
	}
	return result, err
}

// wikiRefreshTarget is the locked Wiki a refresh request acts on and the
// Another Me Agent that generates its pages.
type wikiRefreshTarget struct {
	wikiID, currentRevisionID, generatorID string
}

func (s *Service) requestWikiRefreshInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	input RequestWikiRefreshInput,
	requestHash [sha256.Size]byte,
) (WikiRefreshResult, error) {
	// Memory's refresh request carries only a derived key; the refresh IDs must
	// still follow it, or every refresh of a Wiki collides.
	if input.commandID == "" {
		input.commandID = input.IdempotencyKey
	}
	if input.commandID == "" {
		input.commandID = idgen.New("wiki_refresh_command")
	}
	if replay, found, replayErr := lookupWikiRefreshReplay(ctx, tx, input, requestHash); replayErr != nil {
		return WikiRefreshResult{}, replayErr
	} else if found {
		replay.Replayed = true
		return replay, nil
	}

	target, err := lockWikiRefreshTarget(ctx, tx, input)
	if err != nil {
		return WikiRefreshResult{}, err
	}
	if result, joined, err := joinActiveWikiRefresh(ctx, tx, input, requestHash, target); err != nil || joined {
		return result, err
	}
	if err := lockWikiSourceHeads(ctx, tx, target.wikiID); err != nil {
		return WikiRefreshResult{}, err
	}
	admission := wikiRefreshAdmission{
		RefreshID: stableCreateID("document_wiki_refresh_", target.wikiID, input.commandID),
		TenantID:  input.TenantID, WikiID: target.wikiID, GeneratorID: target.generatorID,
		BaseRevisionID: target.currentRevisionID, CaptureID: input.CaptureID,
	}
	admit := admitNightlyWikiRefresh
	if input.CaptureID != "" {
		admit = admitMeetingWikiRefresh
	}
	status, err := admit(ctx, tx, admission)
	if err != nil {
		return WikiRefreshResult{}, err
	}
	if status != WikiRefreshAccepted {
		result := WikiRefreshResult{
			WikiID: target.wikiID, WikiRevisionID: target.currentRevisionID, Status: status,
			GeneratorAgentActorID: target.generatorID,
		}
		if err := recordWikiRefreshReplay(ctx, tx, input, requestHash, result, http.StatusOK); err != nil {
			return WikiRefreshResult{}, err
		}
		return result, nil
	}
	if err := enqueueWikiRefreshDispatch(ctx, tx, admission.RefreshID); err != nil {
		return WikiRefreshResult{}, err
	}
	result := WikiRefreshResult{
		ID: admission.RefreshID, WikiID: target.wikiID, Status: WikiRefreshAccepted,
		GeneratorAgentActorID: target.generatorID,
	}
	if err := recordWikiRefreshReplay(ctx, tx, input, requestHash, result, http.StatusAccepted); err != nil {
		return WikiRefreshResult{}, err
	}
	return result, nil
}

// lockWikiRefreshTarget serializes source-set changes of the requesting Human
// and locks their Wiki and its active generator Agent.
func lockWikiRefreshTarget(ctx context.Context, tx pgx.Tx, input RequestWikiRefreshInput) (wikiRefreshTarget, error) {
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, input.TenantID)
	if err != nil {
		return wikiRefreshTarget{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"memory-wiki-source-set|"+input.TenantID+"|"+actorID); err != nil {
		return wikiRefreshTarget{}, err
	}
	var target wikiRefreshTarget
	err = tx.QueryRow(ctx, `SELECT id,coalesce(current_revision_id,'')
		FROM personal_wikis
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND deleted_at IS NULL
		FOR UPDATE`, input.TenantID, actorID).Scan(&target.wikiID, &target.currentRevisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return wikiRefreshTarget{}, ErrNotFound
	}
	if err != nil {
		return wikiRefreshTarget{}, err
	}
	err = tx.QueryRow(ctx, `SELECT actor_id
		FROM agent_registrations
		WHERE tenant_id=$1 AND represented_human_actor_id=$2
		  AND agent_type='anotherme' AND status='active'
		FOR SHARE`, input.TenantID, actorID).Scan(&target.generatorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return wikiRefreshTarget{}, ErrNotFound
	}
	if err != nil {
		return wikiRefreshTarget{}, err
	}
	return target, nil
}

// joinActiveWikiRefresh answers the request with the refresh already staging,
// if there is one; joined reports whether it did.
func joinActiveWikiRefresh(
	ctx context.Context,
	tx pgx.Tx,
	input RequestWikiRefreshInput,
	requestHash [sha256.Size]byte,
	target wikiRefreshTarget,
) (WikiRefreshResult, bool, error) {
	var activeRefreshID string
	err := tx.QueryRow(ctx, `SELECT id FROM document_wiki_refreshes
		WHERE wiki_id=$1 AND status='staging'
		FOR SHARE`, target.wikiID).Scan(&activeRefreshID)
	if errors.Is(err, pgx.ErrNoRows) {
		return WikiRefreshResult{}, false, nil
	}
	if err != nil {
		return WikiRefreshResult{}, false, err
	}
	if input.CaptureID == "" {
		if _, err := tx.Exec(ctx, `UPDATE document_wiki_refreshes SET followup_requested=true WHERE id=$1`, activeRefreshID); err != nil {
			return WikiRefreshResult{}, false, err
		}
	}
	result := WikiRefreshResult{
		ID: activeRefreshID, WikiID: target.wikiID, Status: WikiRefreshInProgress,
		GeneratorAgentActorID: target.generatorID,
	}
	if err := recordWikiRefreshReplay(ctx, tx, input, requestHash, result, http.StatusAccepted); err != nil {
		return WikiRefreshResult{}, false, err
	}
	return result, true, nil
}

// wikiRefreshAdmission names the refresh an admission may stage and the Wiki
// it refreshes. An empty CaptureID admits every changed source.
type wikiRefreshAdmission struct {
	RefreshID, TenantID, WikiID, GeneratorID string
	BaseRevisionID, CaptureID                string
}

// admitNightlyWikiRefresh stages a refresh over every changed source, or
// reports why none is needed. The dispatcher sends LLM Wiki the sources absent
// from the published sources (added or modified), the published sources no
// longer bound (removed), and the current pages; one request carries at most
// maxWikiCandidateSourceChanges changes and maxWikiCandidateRequestBytes.
// Removals and base pages always travel, so only they can make a refresh
// impossible; added and modified sources are admitted in batches.
func admitNightlyWikiRefresh(ctx context.Context, tx pgx.Tx, admission wikiRefreshAdmission) (WikiRefreshStatus, error) {
	wikiID, tenantID := admission.WikiID, admission.TenantID
	// A source the whitelist leaves out, too large ones included, has a
	// verdict with a reason and is not among the current sources.
	if admission.BaseRevisionID == "" {
		var sourceBindings, pageBindings int
		if err := tx.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM wiki_current_sources source
			 WHERE source.wiki_id=$1 AND source.tenant_id=$2),
			(SELECT count(*) FROM document_context_bindings binding
			 JOIN documents document ON document.id=binding.document_id
			  AND document.tenant_id=binding.tenant_id
			 WHERE binding.wiki_id=$1 AND binding.tenant_id=$2
			   AND binding.binding_kind='wiki_page' AND binding.status='active'
			   AND document.status='active')`, wikiID, tenantID).Scan(
			&sourceBindings, &pageBindings,
		); err != nil {
			return "", err
		}
		if sourceBindings == 0 && pageBindings == 0 {
			return WikiRefreshNoSources, nil
		}
	}
	latest, err := wikiSourcesMatchPublished(ctx, tx, wikiID)
	if err != nil {
		return "", err
	}
	if latest {
		return WikiRefreshAlreadyLatest, nil
	}
	var sourceCount, removedSources int
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM wiki_current_sources source
		 WHERE source.wiki_id=$1 AND source.tenant_id=$2),
		(SELECT count(*) FROM document_wiki_published_sources source
		 WHERE source.wiki_id=$1 AND source.document_id NOT IN (
		   SELECT source_id FROM wiki_current_sources WHERE wiki_id=$1 AND tenant_id=$2))`,
		wikiID, tenantID).Scan(&sourceCount, &removedSources); err != nil {
		return "", err
	}
	if sourceCount == 0 {
		return WikiRefreshNoSources, nil
	}
	if removedSources > maxWikiCandidateSourceChanges {
		return "", &WikiRefreshTooLargeError{ChangedSources: removedSources}
	}
	basePageBytes, err := wikiBasePageBytes(ctx, tx, wikiID, tenantID)
	if err != nil {
		return "", err
	}
	if err := startWikiRefresh(ctx, tx, admission); err != nil {
		return "", err
	}
	// Freeze the unchanged sources and, in source order, the added and
	// modified ones that fit the change and byte budgets. A modified source
	// outside the batch keeps its published version and an added one waits.
	if _, err := tx.Exec(ctx, `WITH current_source AS (
        SELECT item.tenant_id,item.source_kind,item.source_id,item.version_id,item.size_bytes,
          (SELECT source.document_version_id FROM document_wiki_published_sources source
           WHERE source.wiki_id=$2 AND source.document_id=item.source_id) AS published_version_id
        FROM wiki_current_sources item
        WHERE item.wiki_id=$2 AND item.tenant_id=$3
      ), changed AS (
        SELECT item.source_id,
          row_number() OVER (ORDER BY item.source_id) AS position,
          sum(`+wikiCandidateItemBytesSQL+`) OVER (ORDER BY item.source_id) AS request_bytes
        FROM current_source item
        WHERE item.published_version_id IS DISTINCT FROM item.version_id
      )
      INSERT INTO document_wiki_refresh_sources(
		refresh_id,tenant_id,source_kind,document_id,frozen_document_version_id
	)
	SELECT $1,source.tenant_id,source.source_kind,source.source_id,
	  CASE WHEN changed.source_id IS NULL OR (changed.position<=$4 AND changed.request_bytes<=$5)
	    THEN source.version_id ELSE source.published_version_id END
	FROM current_source source
	LEFT JOIN changed ON changed.source_id=source.source_id
	WHERE changed.source_id IS NULL OR (changed.position<=$4 AND changed.request_bytes<=$5)
	   OR source.published_version_id IS NOT NULL
	ORDER BY source.source_id`, admission.RefreshID, wikiID, tenantID,
		maxWikiCandidateSourceChanges-removedSources, maxWikiCandidateRequestBytes-basePageBytes); err != nil {
		return "", err
	}
	// LLM Wiki refuses a request without changes. When only added or modified
	// sources changed, the batch must take at least one of them beside the
	// base pages; the error reports the smallest request one could make.
	var changedSources, admittedSources int
	var smallestChangeBytes int64
	if err := tx.QueryRow(ctx, `WITH changed AS (
        SELECT item.size_bytes
        FROM wiki_current_sources item
        WHERE item.wiki_id=$1 AND item.tenant_id=$2
          AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources source
            WHERE source.wiki_id=$1 AND source.document_id=item.source_id
              AND source.document_version_id=item.version_id)
      )
      SELECT (SELECT count(*) FROM changed),
        (SELECT count(*) FROM document_wiki_refresh_sources frozen
         WHERE frozen.refresh_id=$3 AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources source
           WHERE source.wiki_id=$1 AND source.document_id=frozen.document_id
             AND source.document_version_id=frozen.frozen_document_version_id)),
        (SELECT coalesce(min(`+wikiCandidateItemBytesSQL+`),0)::bigint FROM changed item)`,
		wikiID, tenantID, admission.RefreshID).Scan(&changedSources, &admittedSources, &smallestChangeBytes); err != nil {
		return "", err
	}
	if removedSources == 0 && changedSources > 0 && admittedSources == 0 {
		return "", &WikiRefreshTooLargeError{EstimatedBytes: basePageBytes + smallestChangeBytes}
	}
	// The batch left changed sources out; settlement queues the next batch.
	if admittedSources < changedSources {
		if _, err := tx.Exec(ctx, `UPDATE document_wiki_refreshes SET sources_deferred=true
			WHERE id=$1`, admission.RefreshID); err != nil {
			return "", err
		}
	}
	return WikiRefreshAccepted, nil
}

// admitMeetingWikiRefresh stages a refresh of one meeting, or reports why none
// is needed. It freezes the meeting's current recording Sessions that the
// published Wiki lacks at their current version, in source order within the
// change and byte budgets, and every other published source at its published
// version, so no other source is added, changed or removed. Sessions outside
// the budgets wait for the nightly refresh.
func admitMeetingWikiRefresh(ctx context.Context, tx pgx.Tx, admission wikiRefreshAdmission) (WikiRefreshStatus, error) {
	wikiID, tenantID := admission.WikiID, admission.TenantID
	var meetingSources, changedSources int
	var smallestChangeBytes int64
	if err := tx.QueryRow(ctx, `WITH meeting AS (
        SELECT item.size_bytes,
          NOT EXISTS(SELECT 1 FROM document_wiki_published_sources published
            WHERE published.wiki_id=item.wiki_id AND published.document_id=item.source_id
              AND published.document_version_id=item.version_id) AS changed
        FROM wiki_session_sources item
        JOIN memory_index.sources session ON session.id=item.source_id AND session.tenant_id=item.tenant_id
        WHERE item.wiki_id=$1 AND item.tenant_id=$2
          AND session.source_kind='recording_transcript' AND session.metadata->>'capture_id'=$3
      )
      SELECT count(*),count(*) FILTER (WHERE item.changed),
        coalesce(min(`+wikiCandidateItemBytesSQL+`) FILTER (WHERE item.changed),0)::bigint
      FROM meeting item`, wikiID, tenantID, admission.CaptureID).Scan(
		&meetingSources, &changedSources, &smallestChangeBytes); err != nil {
		return "", err
	}
	if meetingSources == 0 {
		return WikiRefreshNoSources, nil
	}
	if changedSources == 0 && admission.BaseRevisionID != "" {
		return WikiRefreshAlreadyLatest, nil
	}
	basePageBytes, err := wikiBasePageBytes(ctx, tx, wikiID, tenantID)
	if err != nil {
		return "", err
	}
	if err := startWikiRefresh(ctx, tx, admission); err != nil {
		return "", err
	}
	// The source kind of a published source is not stored; one that left the
	// Memory index is frozen as a Document, which the dispatcher treats alike
	// because an unchanged source travels without its text.
	if _, err := tx.Exec(ctx, `WITH meeting AS (
        SELECT item.tenant_id,item.source_id,item.version_id,
          row_number() OVER (ORDER BY item.source_id) AS position,
          sum(`+wikiCandidateItemBytesSQL+`) OVER (ORDER BY item.source_id) AS request_bytes
        FROM wiki_session_sources item
        JOIN memory_index.sources session ON session.id=item.source_id AND session.tenant_id=item.tenant_id
        WHERE item.wiki_id=$2 AND item.tenant_id=$3
          AND session.source_kind='recording_transcript' AND session.metadata->>'capture_id'=$4
          AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources published
            WHERE published.wiki_id=item.wiki_id AND published.document_id=item.source_id
              AND published.document_version_id=item.version_id)
      ), admitted AS (
        SELECT tenant_id,source_id,version_id FROM meeting WHERE position<=$5 AND request_bytes<=$6
      )
      INSERT INTO document_wiki_refresh_sources(
		refresh_id,tenant_id,source_kind,document_id,frozen_document_version_id
	)
	SELECT $1,admitted.tenant_id,'session',admitted.source_id,admitted.version_id FROM admitted
	UNION ALL
	SELECT $1,published.tenant_id,
	  CASE WHEN EXISTS(SELECT 1 FROM memory_index.sources session
	    WHERE session.id=published.document_id AND session.tenant_id=published.tenant_id)
	    THEN 'session' ELSE 'document' END,
	  published.document_id,published.document_version_id
	FROM document_wiki_published_sources published
	WHERE published.wiki_id=$2
	  AND NOT EXISTS(SELECT 1 FROM admitted WHERE admitted.source_id=published.document_id)`,
		admission.RefreshID, wikiID, tenantID, admission.CaptureID,
		maxWikiCandidateSourceChanges, maxWikiCandidateRequestBytes-basePageBytes); err != nil {
		return "", err
	}
	var admittedSources int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM document_wiki_refresh_sources frozen
		WHERE frozen.refresh_id=$2 AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources source
		  WHERE source.wiki_id=$1 AND source.document_id=frozen.document_id
		    AND source.document_version_id=frozen.frozen_document_version_id)`,
		wikiID, admission.RefreshID).Scan(&admittedSources); err != nil {
		return "", err
	}
	if admittedSources == 0 {
		return "", &WikiRefreshTooLargeError{EstimatedBytes: basePageBytes + smallestChangeBytes}
	}
	return WikiRefreshAccepted, nil
}

// wikiBasePageBytes estimates the encoded size of the Wiki's current pages,
// which every refresh request carries, and refuses a Wiki whose pages alone
// exceed one request.
func wikiBasePageBytes(ctx context.Context, tx pgx.Tx, wikiID, tenantID string) (int64, error) {
	var basePageBytes int64
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(`+wikiCandidateItemBytesSQL+`),0)::bigint
         FROM (SELECT version.size_bytes FROM document_context_bindings binding
           JOIN documents document ON document.id=binding.document_id
            AND document.tenant_id=binding.tenant_id AND document.status='active'
           JOIN document_versions version ON version.id=document.current_version_id
            AND version.tenant_id=document.tenant_id AND version.document_id=document.id
           WHERE binding.wiki_id=$1 AND binding.tenant_id=$2
             AND binding.binding_kind='wiki_page' AND binding.status='active') item`,
		wikiID, tenantID).Scan(&basePageBytes); err != nil {
		return 0, err
	}
	if basePageBytes > maxWikiCandidateRequestBytes {
		return 0, &WikiRefreshTooLargeError{EstimatedBytes: basePageBytes}
	}
	return basePageBytes, nil
}

// startWikiRefresh inserts the staging refresh after removing the Wiki's
// earlier refreshes but the latest. Every earlier refresh is finished. The
// latest stays: Memory's refresh intent key names the latest failed one, so
// dropping it would revive an already answered key. A failed one
// kept its frozen sources only for its follow-up, which this admission
// supersedes.
func startWikiRefresh(ctx context.Context, tx pgx.Tx, admission wikiRefreshAdmission) error {
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_refreshes
		WHERE wiki_id=$1 AND id<>(SELECT id FROM document_wiki_refreshes
			WHERE wiki_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1)`, admission.WikiID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_wiki_refresh_sources
		WHERE refresh_id IN (SELECT id FROM document_wiki_refreshes WHERE wiki_id=$1)`, admission.WikiID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO document_wiki_refreshes(
		id,tenant_id,wiki_id,generator_agent_actor_id,base_wiki_revision_id,status,capture_id
	) VALUES($1,$2,$3,$4,nullif($5,''),'staging',nullif($6,''))`, admission.RefreshID, admission.TenantID,
		admission.WikiID, admission.GeneratorID, admission.BaseRevisionID, admission.CaptureID)
	return err
}

// wikiSourcesMatchPublished reports whether the Wiki's usable source Versions
// are exactly its published sources. Only settlement writes Wiki pages, so the
// sources alone decide whether the published Wiki is current.
func wikiSourcesMatchPublished(ctx context.Context, tx pgx.Tx, wikiID string) (bool, error) {
	var matches bool
	err := tx.QueryRow(ctx, `WITH current_source AS (
			SELECT source_id,version_id FROM wiki_current_sources WHERE wiki_id=$1
		), published AS (
			SELECT document_id,document_version_id AS version_id
			FROM document_wiki_published_sources WHERE wiki_id=$1
		)
		SELECT EXISTS(SELECT 1 FROM personal_wikis WHERE id=$1 AND current_revision_id IS NOT NULL)
		  AND NOT EXISTS(SELECT * FROM current_source EXCEPT SELECT * FROM published)
		  AND NOT EXISTS(SELECT * FROM published EXCEPT SELECT * FROM current_source)`,
		wikiID).Scan(&matches)
	return matches, err
}

func lookupWikiRefreshReplay(
	ctx context.Context,
	tx pgx.Tx,
	input RequestWikiRefreshInput,
	requestHash [sha256.Size]byte,
) (WikiRefreshResult, bool, error) {
	record, found, err := lookupCommandRecord(ctx, tx, input.AccountID, wikiRefreshOperation, input.IdempotencyKey, requestHash[:])
	if err != nil || !found {
		return WikiRefreshResult{}, false, err
	}
	var result WikiRefreshResult
	if err := json.Unmarshal(record.Body, &result); err != nil {
		return WikiRefreshResult{}, false, err
	}
	return result, true, nil
}

func recordWikiRefreshReplay(
	ctx context.Context,
	tx pgx.Tx,
	input RequestWikiRefreshInput,
	requestHash [sha256.Size]byte,
	result WikiRefreshResult,
	status int,
) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	resourceID := result.ID
	if resourceID == "" {
		resourceID = result.WikiRevisionID
	}
	return idempotency.Save(ctx, tx, idempotency.AccountKey(input.AccountID, wikiRefreshOperation, input.IdempotencyKey), requestHash[:], idempotency.Record{ResourceID: resourceID, Status: status, Body: body})
}

// Retry only PostgreSQL serialization/deadlock failures, never generation or
// Runtime calls. Each attempt reopens a transaction and rechecks all CAS fences.
func retryWikiTransaction(ctx context.Context, operation func() error) error {
	for attempt := 1; ; attempt++ {
		err := operation()
		if err == nil || !isRetryableDocumentTransactionError(err) || attempt >= memoryWikiTransactionAttempts {
			return err
		}
		if err := waitMemoryWikiTransactionRetry(ctx, attempt); err != nil {
			return err
		}
	}
}
