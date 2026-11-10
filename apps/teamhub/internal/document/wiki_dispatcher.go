package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// WikiCandidateSource is one frozen source text: the Markdown TeamHub
// normalized for one Document version, or the indexed text of one Session.
// A Session source is named by its Memory index source ID and versioned by
// the SHA-256 of that text.
type WikiCandidateSource struct {
	DocumentID, DocumentVersionID, Filename string
	SizeBytes                               int64
	SHA256                                  string
	Content                                 []byte
	Session                                 *WikiCandidateSession
	loadContent                             func(context.Context) ([]byte, error)
}

// WikiCandidateSession routes a Session source to its dated Session page and
// names what its citations open: the Room's messages, or a recording's
// transcript Document.
type WikiCandidateSession struct {
	Kind, Date, SessionID, RoomID                        string
	TranscriptDocumentID, TranscriptDocumentVersionID    string
	RepresentedHumanActorID, RepresentedHumanDisplayName string
}

type WikiCandidateBasePage struct {
	PageKey, SHA256 string
	SizeBytes       int64
	Content         []byte
	loadContent     func(context.Context) ([]byte, error)
}

// ReadContent returns the source bytes. The dispatcher reads them only when a
// generator asks, so a refresh never holds every frozen source in memory.
func (s WikiCandidateSource) ReadContent(ctx context.Context) ([]byte, error) {
	if s.loadContent == nil {
		return s.Content, nil
	}
	return s.loadContent(ctx)
}

// ReadContent returns the published page bytes, read on demand like sources.
func (p WikiCandidateBasePage) ReadContent(ctx context.Context) ([]byte, error) {
	if p.loadContent == nil {
		return p.Content, nil
	}
	return p.loadContent(ctx)
}

type WikiCandidateSourceReference struct {
	DocumentID, DocumentVersionID, Filename string
}

type WikiCandidateSourceChanges struct {
	Added, Modified []WikiCandidateSource
	Removed         []WikiCandidateSourceReference
}

type WikiCandidateGenerationRequest struct {
	SavePreview                                func(map[string]string) error
	RefreshID, TenantID, GeneratorAgentActorID string
	Mode                                       string
	BasePages                                  []WikiCandidateBasePage
	Changes                                    WikiCandidateSourceChanges
}

type WikiCandidateGenerationResult struct {
	RefreshID string
	Pages     []WikiPageCandidate
	// Unsettled names the added or modified sources the candidate failed to
	// write, and Deferred those its budget left unwritten; settlement keeps
	// both pending and counts a try only for Unsettled.
	Unsettled, Deferred []WikiCandidateSourceReference
}

type WikiCandidateGenerator interface {
	GenerateWikiCandidates(context.Context, WikiCandidateGenerationRequest) (WikiCandidateGenerationResult, error)
}

type wikiSourceReadError struct {
	code string
	err  error
}

func (e *wikiSourceReadError) Error() string { return e.err.Error() }
func (e *wikiSourceReadError) Unwrap() error { return e.err }

// ErrWikiCandidateTerminal marks a rejected generation that must not invoke
// the LLM again. Transient transport/provider failures remain retryable.
var ErrWikiCandidateTerminal = errors.New("Wiki candidate generation rejected")

// ErrWikiCandidateComputerOffline means the Wiki owner's Computer cannot run
// the generation now. The dispatch waits for it without spending an attempt.
var ErrWikiCandidateComputerOffline = errors.New("Wiki owner's Computer is offline")

// ErrWikiCandidateServiceStopping means LLM Wiki stopped the generation
// because its process is restarting. The dispatch runs it again shortly
// without spending an attempt.
var ErrWikiCandidateServiceStopping = errors.New("LLM Wiki is stopping")

// ErrWikiCandidateInvalidRequest marks frozen input that cannot be normalized,
// a request or result that fails TeamHub's own candidate checks, or page heads
// that cannot be reconciled without a new source delta. The same source set
// must not be re-admitted until a source version changes.
var ErrWikiCandidateInvalidRequest = errors.New("Wiki candidate frozen input rejected")

// PublishedWikiGraphUpdater hands Memory a published Wiki revision to index.
type PublishedWikiGraphUpdater interface {
	UpdatePublishedWiki(ctx context.Context, tenantID, ownerID, revisionID string) error
}

// WikiRefreshDispatchOptions bounds one refresh's River attempts. MaxAttempts is
// the worker's own limit; the River job has spare attempts so a rescued job can
// still reach a worker that fails the refresh.
type WikiRefreshDispatchOptions struct {
	MaxAttempts       int
	GenerationTimeout time.Duration
}

type WikiRefreshDispatcher struct {
	pool      *pgxpool.Pool
	objects   artifactstore.ObjectStore
	generator WikiCandidateGenerator
	service   *Service
	options   WikiRefreshDispatchOptions
}

type claimedWikiRefresh struct {
	ID, TenantID, GeneratorAgentActorID string
	AttemptCount                        int
	CreatedAt                           time.Time
}

func NewWikiRefreshDispatcher(
	pool *pgxpool.Pool,
	objects artifactstore.ObjectStore,
	generator WikiCandidateGenerator,
	service *Service,
	options WikiRefreshDispatchOptions,
) (*WikiRefreshDispatcher, error) {
	if pool == nil || objects == nil || generator == nil || service == nil ||
		options.GenerationTimeout <= 0 ||
		options.MaxAttempts < 1 || options.MaxAttempts > 100 {
		return nil, ErrInvalidInput
	}
	return &WikiRefreshDispatcher{
		pool: pool, objects: objects, generator: generator, service: service, options: options,
	}, nil
}

// prepareCandidates returns the refresh's candidate set, validated and sorted
// once, with its set hash.
func (d *WikiRefreshDispatcher) prepareCandidates(
	ctx context.Context,
	claimed claimedWikiRefresh,
) ([]WikiPageCandidate, string, WikiCandidateGenerationResult, string, error) {
	baseRevisionID, basePages, baseSources, errorCode, err := d.loadRefreshBaseline(ctx, claimed)
	if err != nil {
		return nil, "", WikiCandidateGenerationResult{}, errorCode, err
	}
	sources, errorCode, err := d.loadFrozenSources(ctx, claimed, baseSources)
	if err != nil {
		return nil, "", WikiCandidateGenerationResult{}, errorCode, err
	}
	changes := diffWikiCandidateSources(sources, baseSources)
	if baseRevisionID != "" && len(changes.Added)+len(changes.Modified)+len(changes.Removed) == 0 {
		// Admission found the Wiki out of date while every source matches the
		// published sources, which only a reset can cause. Reuse the frozen-input rejection code: reconciliation
		// must not rotate its intent merely because this refresh failed.
		return nil, "", WikiCandidateGenerationResult{}, "candidate_invalid", fmt.Errorf(
			"%w: Wiki pages changed without a source change", ErrWikiCandidateInvalidRequest)
	}
	mode := "initialize"
	if baseRevisionID != "" {
		mode = "update"
	}
	result, err := d.generator.GenerateWikiCandidates(ctx, WikiCandidateGenerationRequest{
		SavePreview: func(pages map[string]string) error {
			if len(pages) > maxWikiPages {
				return ErrInvalidInput
			}
			for path, content := range pages {
				if !validWikiPageKey(path) || len(content) == 0 || len(content) > 16<<20 {
					return ErrInvalidInput
				}
			}
			data, err := json.Marshal(pages)
			if err != nil {
				return err
			}
			return store.New(d.pool).WriteWikiRefreshPreview(ctx, store.WriteWikiRefreshPreviewParams{RefreshID: claimed.ID, Pages: data})
		},
		RefreshID: claimed.ID, TenantID: claimed.TenantID,
		GeneratorAgentActorID: claimed.GeneratorAgentActorID,
		Mode:                  mode, BasePages: basePages, Changes: changes,
	})
	pages, candidateHash, errorCode, err := validateWikiCandidateGenerationResult(claimed.ID, result, err)
	return pages, candidateHash, result, errorCode, err
}

// validateWikiCandidateGenerationResult classifies a generation failure and
// runs the one check of a generated candidate set.
func validateWikiCandidateGenerationResult(
	refreshID string,
	result WikiCandidateGenerationResult,
	generationErr error,
) ([]WikiPageCandidate, string, string, error) {
	err := generationErr
	if err != nil {
		var sourceErr *wikiSourceReadError
		if errors.As(err, &sourceErr) {
			return nil, "", sourceErr.code, sourceErr.err
		}
		// Input LLM Wiki rejects or TeamHub's own request check refuses fails
		// the same way on every retry.
		if errors.Is(err, ErrWikiCandidateInvalidRequest) || errors.Is(err, ErrInvalidInput) {
			return nil, "", "candidate_invalid", err
		}
		if errors.Is(err, ErrWikiCandidateTerminal) || errors.Is(err, ErrWikiCandidateComputerOffline) ||
			errors.Is(err, ErrWikiCandidateServiceStopping) {
			return nil, "", "candidate_unavailable", err
		}
		return nil, "", "candidate_unavailable", errors.Join(ErrRuntimeUnavailable, err)
	}
	if result.RefreshID != refreshID {
		return nil, "", "candidate_unavailable", ErrRuntimeUnavailable
	}
	pages, candidateHash, err := normalizeWikiCandidates(result.Pages)
	if err != nil {
		return nil, "", "candidate_invalid", errors.Join(ErrWikiCandidateInvalidRequest, err)
	}
	return pages, candidateHash, "", nil
}

// loadRefreshBaseline reads the published sources and the current pages the
// refresh updates. Only settlement writes either, and a Wiki has one running
// refresh, so they are the refresh's base revision.
func (d *WikiRefreshDispatcher) loadRefreshBaseline(
	ctx context.Context,
	claimed claimedWikiRefresh,
) (string, []WikiCandidateBasePage, map[string]WikiCandidateSourceReference, string, error) {
	var baseRevisionID, wikiID, currentRevisionID string
	err := d.pool.QueryRow(ctx, `SELECT coalesce(refresh.base_wiki_revision_id,''),wiki.id,
		coalesce(wiki.current_revision_id,'')
		FROM document_wiki_refreshes refresh
		JOIN personal_wikis wiki ON wiki.id=refresh.wiki_id AND wiki.tenant_id=refresh.tenant_id
		WHERE refresh.id=$1 AND refresh.tenant_id=$2 AND refresh.status='staging'`,
		claimed.ID, claimed.TenantID).Scan(&baseRevisionID, &wikiID, &currentRevisionID)
	if err != nil {
		return "", nil, nil, "settlement_unavailable", err
	}
	if baseRevisionID != currentRevisionID {
		// Generating against another base is wasted work; WorkRefresh records
		// the conflict instead.
		return "", nil, nil, "", errWikiBaseChanged
	}
	baseSources := make(map[string]WikiCandidateSourceReference)
	if baseRevisionID == "" {
		return "", nil, baseSources, "", nil
	}
	// A published source keeps its name for removal after its Version or
	// Document is gone, so the name falls back to the Document title.
	sourceRows, err := d.pool.Query(ctx, `SELECT source.document_id,source.document_version_id,
		coalesce(version.filename,document.title,session.title,source.document_id)
		FROM document_wiki_published_sources source
		LEFT JOIN document_versions version ON version.id=source.document_version_id
		 AND version.tenant_id=source.tenant_id AND version.document_id=source.document_id
		LEFT JOIN documents document ON document.id=source.document_id AND document.tenant_id=source.tenant_id
		LEFT JOIN memory_index.sources session ON session.id=source.document_id AND session.tenant_id=source.tenant_id
		WHERE source.wiki_id=$1 ORDER BY source.document_id`, wikiID)
	if err != nil {
		return "", nil, nil, "settlement_unavailable", err
	}
	for sourceRows.Next() {
		var source WikiCandidateSourceReference
		if err := sourceRows.Scan(&source.DocumentID, &source.DocumentVersionID, &source.Filename); err != nil {
			sourceRows.Close()
			return "", nil, nil, "settlement_unavailable", err
		}
		baseSources[source.DocumentID] = source
	}
	if err := sourceRows.Err(); err != nil {
		sourceRows.Close()
		return "", nil, nil, "settlement_unavailable", err
	}
	sourceRows.Close()

	pageRows, err := d.pool.Query(ctx, `SELECT page.page_key,version.size_bytes,version.sha256,
		version.content_object_id
		FROM document_wiki_pages page
		JOIN documents document ON document.id=page.document_id
		 AND document.tenant_id=page.tenant_id AND document.status='active'
		JOIN document_context_bindings binding ON binding.document_id=page.document_id
		 AND binding.tenant_id=page.tenant_id AND binding.wiki_id=page.wiki_id
		 AND binding.binding_kind='wiki_page' AND binding.status='active'
		JOIN document_versions version ON version.id=document.current_version_id
		 AND version.tenant_id=document.tenant_id AND version.document_id=document.id
		WHERE page.wiki_id=$1 ORDER BY page.page_key`, wikiID)
	if err != nil {
		return "", nil, nil, "object_unavailable", err
	}
	pages := make([]WikiCandidateBasePage, 0)
	for pageRows.Next() {
		var page WikiCandidateBasePage
		var objectKey string
		if err := pageRows.Scan(&page.PageKey, &page.SizeBytes, &page.SHA256, &objectKey); err != nil {
			pageRows.Close()
			return "", nil, nil, "object_unavailable", err
		}
		size, sha := page.SizeBytes, page.SHA256
		page.loadContent = func(readCtx context.Context) ([]byte, error) {
			content, code, err := d.readExactObject(readCtx, objectKey, size, sha)
			if err != nil {
				return nil, &wikiSourceReadError{code: code, err: err}
			}
			return content, nil
		}
		pages = append(pages, page)
	}
	if err := pageRows.Err(); err != nil {
		pageRows.Close()
		return "", nil, nil, "object_unavailable", err
	}
	pageRows.Close()
	if len(pages) == 0 {
		return "", nil, nil, "object_mismatch", ErrVersionConflict
	}
	return baseRevisionID, pages, baseSources, "", nil
}

func diffWikiCandidateSources(
	current []WikiCandidateSource,
	base map[string]WikiCandidateSourceReference,
) WikiCandidateSourceChanges {
	changes := WikiCandidateSourceChanges{}
	currentByID := make(map[string]WikiCandidateSource, len(current))
	for _, source := range current {
		currentByID[source.DocumentID] = source
		previous, exists := base[source.DocumentID]
		if !exists {
			changes.Added = append(changes.Added, source)
		} else if previous.DocumentVersionID != source.DocumentVersionID {
			changes.Modified = append(changes.Modified, source)
		}
	}
	for documentID, source := range base {
		if _, exists := currentByID[documentID]; !exists {
			changes.Removed = append(changes.Removed, source)
		}
	}
	return changes
}

// errFrozenWikiSourceReplaced fails a refresh whose frozen source text was
// replaced. Every retry would read the same missing version, so it is terminal:
// the refresh fails at once and the newer version joins the follow-up refresh.
// errWikiBaseChanged reports that the Wiki was published from another base
// after the refresh was admitted.
var errWikiBaseChanged = errors.New("Wiki base changed after admission")

var errFrozenWikiSourceReplaced = fmt.Errorf("%w: frozen Wiki source text was replaced: %w",
	ErrWikiCandidateTerminal, ErrVersionConflict)

// loadFrozenSources lists the refresh's frozen text versions. Each source's
// Markdown is read from document_texts only when the generator asks. A source
// frozen at its published version is unchanged: the request does not carry
// it, so it needs neither its text, which a newer version may have replaced,
// nor its Document.
func (d *WikiRefreshDispatcher) loadFrozenSources(
	ctx context.Context,
	claimed claimedWikiRefresh,
	published map[string]WikiCandidateSourceReference,
) ([]WikiCandidateSource, string, error) {
	rows, err := d.pool.Query(ctx, `SELECT source.document_id,source.frozen_document_version_id,
		coalesce(version.filename,document.title,''),coalesce(octet_length(text.markdown),0)::bigint,
		coalesce(text.markdown_sha256,'')
		FROM document_wiki_refresh_sources source
		JOIN document_wiki_refreshes refresh
		  ON refresh.id=source.refresh_id AND refresh.tenant_id=source.tenant_id
		LEFT JOIN documents document ON document.id=source.document_id AND document.tenant_id=source.tenant_id
		LEFT JOIN document_texts text ON text.document_id=source.document_id AND text.status='ready'
		 AND document_text_version_id(text.document_id,text.source_kind,text.source_id)=source.frozen_document_version_id
		LEFT JOIN document_versions version ON text.source_kind='file_version' AND version.id=text.source_id
		 AND version.document_id=source.document_id
		WHERE source.refresh_id=$1 AND source.tenant_id=$2 AND source.source_kind='document'
		  AND refresh.status='staging'
		ORDER BY source.document_id`, claimed.ID, claimed.TenantID)
	if err != nil {
		return nil, "object_unavailable", err
	}
	defer rows.Close()
	sources := make([]WikiCandidateSource, 0)
	for rows.Next() {
		var source WikiCandidateSource
		if err := rows.Scan(&source.DocumentID, &source.DocumentVersionID, &source.Filename,
			&source.SizeBytes, &source.SHA256); err != nil {
			return nil, "object_unavailable", err
		}
		if publishedUnchanged(published, source) {
			sources = append(sources, unchangedWikiSource(source))
			continue
		}
		if source.SHA256 == "" {
			return nil, "object_mismatch", errFrozenWikiSourceReplaced
		}
		documentID, versionID, size, digest := source.DocumentID, source.DocumentVersionID, source.SizeBytes, source.SHA256
		source.loadContent = func(readCtx context.Context) ([]byte, error) {
			content, err := d.readFrozenText(readCtx, documentID, versionID)
			if err == nil && !exactContentMatches(content, size, digest) {
				err = errFrozenWikiSourceReplaced
			}
			if err != nil {
				return nil, &wikiSourceReadError{code: "object_mismatch", err: err}
			}
			return content, nil
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		return nil, "object_unavailable", err
	}
	rows.Close()
	sessions, errorCode, err := d.loadFrozenSessions(ctx, claimed, published)
	if err != nil {
		return nil, errorCode, err
	}
	sources = append(sources, sessions...)
	if len(sources) == 0 {
		return nil, "object_mismatch", ErrVersionConflict
	}
	sort.Slice(sources, func(left, right int) bool { return sources[left].DocumentID < sources[right].DocumentID })
	return sources, "", nil
}

// wikiTranscriptResource matches the index source URI of a recording: its
// transcript Document Version.
var wikiTranscriptResource = regexp.MustCompile(`^teamhub://documents/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/versions/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$`)

// loadFrozenSessions lists the refresh's frozen Sessions from the Memory
// index. A Session indexed again since admission no longer holds its frozen
// text, which fails the refresh like a replaced Document text. A Session
// frozen at its published version is unchanged and is not read.
func (d *WikiRefreshDispatcher) loadFrozenSessions(
	ctx context.Context,
	claimed claimedWikiRefresh,
	published map[string]WikiCandidateSourceReference,
) ([]WikiCandidateSource, string, error) {
	rows, err := d.pool.Query(ctx, `SELECT frozen.document_id,frozen.frozen_document_version_id,
		coalesce(session.title,''),coalesce(version.size_bytes,0),coalesce(version.sha256,''),
		coalesce(session.source_kind,''),coalesce(session.room_id,''),
		coalesce(session.metadata->>'capture_id',''),coalesce(version.manifest->>'date',''),
		coalesce(session.source_uri,''),owner.id,owner.display_name
		FROM document_wiki_refresh_sources frozen
		JOIN document_wiki_refreshes refresh
		  ON refresh.id=frozen.refresh_id AND refresh.tenant_id=frozen.tenant_id
		JOIN personal_wikis wiki ON wiki.id=refresh.wiki_id AND wiki.tenant_id=refresh.tenant_id
		JOIN actors owner ON owner.id=wiki.owner_actor_id AND owner.tenant_id=wiki.tenant_id
		LEFT JOIN memory_index.sources session
		  ON session.id=frozen.document_id AND session.tenant_id=frozen.tenant_id
		 AND session.owner_id=wiki.owner_actor_id
		LEFT JOIN memory_index.source_versions version
		  ON version.source_id=session.id AND version.sha256=frozen.frozen_document_version_id
		WHERE frozen.refresh_id=$1 AND frozen.tenant_id=$2 AND frozen.source_kind='session'
		  AND refresh.status='staging'
		ORDER BY frozen.document_id`, claimed.ID, claimed.TenantID)
	if err != nil {
		return nil, "object_unavailable", err
	}
	defer rows.Close()
	sources := make([]WikiCandidateSource, 0)
	for rows.Next() {
		var source WikiCandidateSource
		var session WikiCandidateSession
		var sourceKind, captureID, sourceURI string
		if err := rows.Scan(&source.DocumentID, &source.DocumentVersionID, &source.Filename,
			&source.SizeBytes, &source.SHA256, &sourceKind, &session.RoomID, &captureID, &session.Date,
			&sourceURI, &session.RepresentedHumanActorID, &session.RepresentedHumanDisplayName); err != nil {
			return nil, "object_unavailable", err
		}
		if publishedUnchanged(published, source) {
			sources = append(sources, unchangedWikiSource(source))
			continue
		}
		if source.SHA256 == "" {
			return nil, "object_mismatch", errFrozenWikiSourceReplaced
		}
		switch sourceKind {
		case "room_message":
			session.Kind, session.SessionID = "room", session.RoomID
		case "recording_transcript":
			transcript := wikiTranscriptResource.FindStringSubmatch(sourceURI)
			if transcript == nil {
				return nil, "candidate_invalid", fmt.Errorf("%w: recording Session names no transcript", ErrWikiCandidateInvalidRequest)
			}
			session.Kind, session.SessionID = "recording", captureID
			session.TranscriptDocumentID, session.TranscriptDocumentVersionID = transcript[1], transcript[2]
		}
		if session.Kind == "" || session.RoomID == "" || session.SessionID == "" || session.Date == "" {
			return nil, "candidate_invalid", fmt.Errorf("%w: Session source metadata is incomplete", ErrWikiCandidateInvalidRequest)
		}
		source.Filename += ".md"
		source.Session = &session
		sourceID, versionID, size, digest := source.DocumentID, source.DocumentVersionID, source.SizeBytes, source.SHA256
		source.loadContent = func(readCtx context.Context) ([]byte, error) {
			content, err := d.readFrozenSession(readCtx, sourceID, versionID)
			if err == nil && !exactContentMatches(content, size, digest) {
				err = errFrozenWikiSourceReplaced
			}
			if err != nil {
				return nil, &wikiSourceReadError{code: "object_mismatch", err: err}
			}
			return content, nil
		}
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		return nil, "object_unavailable", err
	}
	return sources, "", nil
}

// publishedUnchanged reports whether a frozen source is the version the
// published Wiki holds.
func publishedUnchanged(published map[string]WikiCandidateSourceReference, source WikiCandidateSource) bool {
	previous, exists := published[source.DocumentID]
	return exists && previous.DocumentVersionID == source.DocumentVersionID
}

// unchangedWikiSource keeps only the identity of an unchanged source, which
// the diff needs to tell it from a removed one.
func unchangedWikiSource(source WikiCandidateSource) WikiCandidateSource {
	return WikiCandidateSource{DocumentID: source.DocumentID, DocumentVersionID: source.DocumentVersionID}
}

func (d *WikiRefreshDispatcher) readFrozenSession(ctx context.Context, sourceID, versionID string) ([]byte, error) {
	var content string
	err := d.pool.QueryRow(ctx, `SELECT content FROM memory_index.source_versions
		WHERE source_id=$1 AND sha256=$2`, sourceID, versionID).Scan(&content)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errFrozenWikiSourceReplaced
	}
	return []byte(content), err
}

func (d *WikiRefreshDispatcher) readFrozenText(ctx context.Context, documentID, versionID string) ([]byte, error) {
	var markdown string
	err := d.pool.QueryRow(ctx, `SELECT markdown FROM document_texts
		WHERE document_id=$1 AND status='ready'
		  AND document_text_version_id(document_id,source_kind,source_id)=$2`, documentID, versionID).Scan(&markdown)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errFrozenWikiSourceReplaced
	}
	return []byte(markdown), err
}

func exactContentMatches(content []byte, expectedSize int64, expectedSHA256 string) bool {
	digest := sha256.Sum256(content)
	return int64(len(content)) == expectedSize && hex.EncodeToString(digest[:]) == expectedSHA256
}

func (d *WikiRefreshDispatcher) readExactObject(
	ctx context.Context,
	key string,
	expectedSize int64,
	expectedSHA256 string,
) ([]byte, string, error) {
	if expectedSize < 0 || expectedSize > d.objects.MaxBytes() {
		return nil, "object_mismatch", ErrObjectStoreUnavailable
	}
	reader, err := d.objects.Open(ctx, key)
	if err != nil {
		return nil, "object_unavailable", errors.Join(ErrObjectStoreUnavailable, err)
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, expectedSize+1))
	if err != nil {
		return nil, "object_unavailable", errors.Join(ErrObjectStoreUnavailable, err)
	}
	digest := sha256.Sum256(content)
	if int64(len(content)) != expectedSize || hex.EncodeToString(digest[:]) != expectedSHA256 {
		return nil, "object_mismatch", ErrObjectStoreUnavailable
	}
	return content, "", nil
}

// isWikiCandidateTerminal reports rejections that retrying cannot fix.
func isWikiCandidateTerminal(err error) bool {
	return errors.Is(err, ErrWikiCandidateTerminal) || errors.Is(err, ErrWikiCandidateInvalidRequest) || errors.Is(err, ErrInvalidInput)
}
