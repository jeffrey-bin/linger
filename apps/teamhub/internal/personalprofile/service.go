package personalprofile

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// defaultRetryDelay spaces a retry when Options.RetryDelay is unset.
const defaultRetryDelay = time.Minute

type Options struct {
	RetryDelay                  time.Duration
	External                    *externalsource.Service
	AppImportProviderCallBudget int
	Wiki                        PersonalInputLookup
	MaxDocuments                int
	MaxDocument                 int64
	// MaxInput bounds the Profile's source text: about 170,000 tokens at most,
	// within the Another Me model's window with room for the Skill and reply.
	MaxInput int64
	// MaxInsightInput bounds the mail evidence Personal Insight receives.
	MaxInsightInput int64
	// EnqueuePersonalInsight queues the Personal Insight step of a succeeded
	// generation with the mail evidence it collected.
	EnqueuePersonalInsight func(ctx context.Context, tx pgx.Tx, generationID string, documents []InsightDocument) error
}

type PersonalInputLookup interface {
	GetPersonalOriginVersion(ctx context.Context, accountID, tenantID, versionID string) (document.Version, error)
}

type Service struct {
	pool      *pgxpool.Pool
	objects   artifactstore.ObjectStore
	generator Generator
	external  *externalsource.Service
	wiki      PersonalInputLookup
	options   Options
}

func New(pool *pgxpool.Pool, objects artifactstore.ObjectStore, generator Generator, configured ...Options) *Service {
	options := Options{RetryDelay: defaultRetryDelay, MaxDocuments: 256, MaxDocument: 64 << 10, MaxInput: 512 << 10, MaxInsightInput: 128 << 10}
	if len(configured) > 0 {
		value := configured[0]
		if value.RetryDelay > 0 {
			options.RetryDelay = value.RetryDelay
		}
		options.External = value.External
		if value.AppImportProviderCallBudget > 0 {
			options.AppImportProviderCallBudget = value.AppImportProviderCallBudget
		}
		options.Wiki = value.Wiki
		if value.MaxDocuments > 0 {
			options.MaxDocuments = value.MaxDocuments
		}
		if value.MaxDocument > 0 {
			options.MaxDocument = value.MaxDocument
		}
		if value.MaxInput > 0 {
			options.MaxInput = value.MaxInput
		}
		if value.MaxInsightInput > 0 {
			options.MaxInsightInput = value.MaxInsightInput
		}
		options.EnqueuePersonalInsight = value.EnqueuePersonalInsight
	}
	if options.AppImportProviderCallBudget == 0 {
		options.AppImportProviderCallBudget = 100
	}
	return &Service{pool: pool, objects: objects, generator: generator, external: options.External, wiki: options.Wiki, options: options}
}

// CreateGeneration queues a Profile generation from the given sources; each
// call queues its own.
func (s *Service) CreateGeneration(ctx context.Context, accountID, tenantID string, sources []SourceInput) (Generation, error) {
	if err := ValidateCreateSources(sources); err != nil {
		return Generation{}, err
	}
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Generation{}, err
	}
	prepared, err := s.prepareSources(ctx, accountID, sources)
	if err != nil {
		return Generation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Generation{}, err
	}
	defer tx.Rollback(ctx)
	if err = s.resolveInputVersions(ctx, accountID, tenantID, prepared); err != nil {
		return Generation{}, err
	}
	var baseRevisionID *string
	var current string
	err = tx.QueryRow(ctx, `SELECT revision_id FROM personal_profile_currents WHERE tenant_id=$1 AND owner_actor_id=$2`, tenantID, actorID).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Generation{}, err
	}
	if current != "" {
		baseRevisionID = &current
	}
	generationID := idgen.New("personal_profile_generation")
	stored, err := encodeGenerationSources(prepared)
	if err != nil {
		return Generation{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO personal_profile_generations(id,tenant_id,owner_actor_id,status,decision_status,prompt_version,base_profile_revision_id,sources) VALUES($1,$2,$3,'queued','pending',$4,$5,$6)`, generationID, tenantID, actorID, PromptVersion, baseRevisionID, stored); err != nil {
		return Generation{}, err
	}
	if err = jobs.InsertTx(ctx, tx, GenerationArgs{GenerationID: generationID}, nil); err != nil {
		return Generation{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Generation{}, err
	}
	return s.GetGeneration(ctx, accountID, tenantID, generationID)
}

// storedGenerationSource is one entry of personal_profile_generations.sources;
// the list order is the source ordinal.
type storedGenerationSource struct {
	Kind              string          `json:"kind"`
	InputVersionID    string          `json:"input_version_id,omitempty"`
	FileSHA256        string          `json:"file_sha256,omitempty"`
	ConnectionID      string          `json:"connection_id,omitempty"`
	Provider          string          `json:"provider,omitempty"`
	ExternalAISummary string          `json:"external_ai_summary,omitempty"`
	Selections        json.RawMessage `json:"selections"`
}

func encodeGenerationSources(prepared []preparedSource) ([]byte, error) {
	stored := make([]storedGenerationSource, 0, len(prepared))
	for _, source := range prepared {
		selections, err := encodeSelections(source.Selections)
		if err != nil {
			return nil, ErrInvalid
		}
		item := storedGenerationSource{Kind: source.Kind, Selections: selections}
		switch source.Kind {
		case "input_version":
			item.InputVersionID, item.FileSHA256 = source.InputVersionID, source.SHA256
		case "connection":
			item.ConnectionID, item.Provider = source.ConnectionID, source.Provider
		case "external_ai_summary":
			item.ExternalAISummary = source.ExternalAISummary
		}
		stored = append(stored, item)
	}
	return json.Marshal(stored)
}

type preparedSource struct {
	Kind, InputVersionID, SHA256, ConnectionID, Provider, ExternalAISummary string
	Selections                                                              []Selection
}

func (s *Service) prepareSources(ctx context.Context, accountID string, sources []SourceInput) ([]preparedSource, error) {
	prepared := make([]preparedSource, 0, len(sources))
	for _, source := range sources {
		item := preparedSource{Kind: strings.TrimSpace(source.Kind), InputVersionID: strings.TrimSpace(source.InputVersionID), ConnectionID: strings.TrimSpace(source.ConnectionID), ExternalAISummary: strings.TrimSpace(source.ExternalAISummary), Selections: source.Selections}
		switch item.Kind {
		case "input_version", "external_ai_summary":
		case "connection":
			if s.external == nil {
				return nil, ErrUnsupportedSource
			}
			connection, err := s.external.GetConnection(ctx, accountID, item.ConnectionID)
			if err != nil {
				return nil, mapExternalError(err)
			}
			if connection.Status != "active" || !supportedConnectionProvider(connection.Provider) {
				return nil, ErrConflict
			}
			if !validConnectionSelections(connection.Provider, item.Selections) {
				return nil, ErrInvalid
			}
			item.Provider = connection.Provider
		}
		prepared = append(prepared, item)
	}
	return prepared, nil
}

// resolveInputVersions checks each selected Personal Wiki document version and
// records its digest; together they must stay within the input size budget.
func (s *Service) resolveInputVersions(ctx context.Context, accountID, tenantID string, sources []preparedSource) error {
	var total int64
	for index := range sources {
		if sources[index].Kind != "input_version" {
			continue
		}
		if s.wiki == nil {
			return ErrUnsupportedSource
		}
		version, err := s.wiki.GetPersonalOriginVersion(ctx, accountID, tenantID, sources[index].InputVersionID)
		if err != nil {
			return mapWikiError(err)
		}
		if err = plannedFileAllowed(version.Filename, version.MediaType, version.SizeBytes, version.SHA256); err != nil {
			return ErrInvalid
		}
		total += version.SizeBytes
		sources[index].SHA256 = version.SHA256
	}
	if total > MaxTotalBytes {
		return ErrInvalid
	}
	return nil
}

func mapWikiError(err error) error {
	switch {
	case errors.Is(err, document.ErrInvalidInput):
		return ErrInvalid
	case errors.Is(err, document.ErrNotFound):
		return ErrNotFound
	default:
		return err
	}
}

func mapExternalError(err error) error {
	switch {
	case errors.Is(err, externalsource.ErrInvalid):
		return ErrInvalid
	case errors.Is(err, externalsource.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, externalsource.ErrNotActive), errors.Is(err, externalsource.ErrConflict):
		return ErrConflict
	case errors.Is(err, externalsource.ErrUnavailable):
		return ErrUnsupportedSource
	default:
		return err
	}
}

func (s *Service) ListGenerations(ctx context.Context, accountID, tenantID string) ([]Generation, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM personal_profile_generations WHERE tenant_id=$1 AND owner_actor_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`, tenantID, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	result := make([]Generation, 0, len(ids))
	for _, id := range ids {
		generation, loadErr := s.loadGeneration(ctx, tenantID, actorID, id)
		if loadErr != nil {
			return nil, loadErr
		}
		result = append(result, generation)
	}
	return result, nil
}

func (s *Service) GetGeneration(ctx context.Context, accountID, tenantID, generationID string) (Generation, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Generation{}, err
	}
	return s.loadGeneration(ctx, tenantID, actorID, generationID)
}

// GetProfile reads the Human's current Revision and the newest twenty.
func (s *Service) GetProfile(ctx context.Context, accountID, tenantID string) (Profile, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Profile{}, err
	}
	return s.ProfileForActor(ctx, tenantID, actorID)
}

// ProfileForActor reads one Human actor's current Revision and the newest twenty.
func (s *Service) ProfileForActor(ctx context.Context, tenantID, actorID string) (Profile, error) {
	rows, err := s.pool.Query(ctx, `SELECT revision.id,revision.tenant_id,revision.owner_actor_id,coalesce(revision.source_profile_generation_id,''),revision.prompt_version,revision.markdown,revision.profile,revision.source_apps,revision.created_at,coalesce(current.revision_id=revision.id,false) FROM personal_profile_revisions revision LEFT JOIN personal_profile_currents current ON current.tenant_id=revision.tenant_id AND current.owner_actor_id=revision.owner_actor_id WHERE revision.tenant_id=$1 AND revision.owner_actor_id=$2 ORDER BY (current.revision_id=revision.id) DESC NULLS LAST,revision.created_at DESC,revision.id DESC LIMIT 21`, tenantID, actorID)
	if err != nil {
		return Profile{}, err
	}
	defer rows.Close()
	var result Profile
	for rows.Next() {
		var revision Revision
		var current bool
		if err = rows.Scan(&revision.ID, &revision.TenantID, &revision.OwnerActorID, &revision.SourceProfileGenerationID, &revision.PromptVersion, &revision.Markdown, &revision.Profile, &revision.SourceApps, &revision.CreatedAt, &current); err != nil {
			return Profile{}, err
		}
		if len(result.History) < 20 {
			result.History = append(result.History, revision)
		} else {
			result.HasMore = true
		}
		if current {
			revisionCopy := revision
			result.Current = &revisionCopy
		}
	}
	if err = rows.Err(); err != nil {
		return Profile{}, err
	}
	result.BuildingSince, err = buildingSince(ctx, s.pool, tenantID, actorID)
	return result, err
}

func clearTerminalExternalAISummaries(ctx context.Context, tx pgx.Tx, generationID string) error {
	_, err := tx.Exec(ctx, `
		UPDATE personal_profile_generations generation
		SET sources=(SELECT jsonb_agg(source.value - 'external_ai_summary' ORDER BY source.ordinality)
		             FROM jsonb_array_elements(generation.sources) WITH ORDINALITY AS source(value,ordinality))
		WHERE generation.id=$1
		  AND generation.status NOT IN ('queued','running')
		  AND jsonb_path_exists(generation.sources,'$[*].external_ai_summary')`, generationID)
	return err
}

func (s *Service) loadGeneration(ctx context.Context, tenantID, actorID, generationID string) (Generation, error) {
	var value Generation
	var baseID, candidateRevision, lastError *string
	err := s.pool.QueryRow(ctx, `SELECT id,tenant_id,status,decision_status,prompt_version,base_profile_revision_id,candidate_revision_id,last_error_code,created_at,updated_at,completed_at FROM personal_profile_generations WHERE id=$1 AND tenant_id=$2 AND owner_actor_id=$3`, generationID, tenantID, actorID).Scan(&value.ID, &value.TenantID, &value.Status, &value.DecisionStatus, &value.PromptVersion, &baseID, &candidateRevision, &lastError, &value.CreatedAt, &value.UpdatedAt, &value.CompletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Generation{}, ErrNotFound
	}
	if err != nil {
		return Generation{}, err
	}
	if baseID != nil {
		value.BaseProfileRevisionID = *baseID
	}
	if candidateRevision != nil {
		value.CandidateRevisionID = *candidateRevision
	}
	if lastError != nil {
		value.LastErrorCode = *lastError
	}
	rows, err := s.pool.Query(ctx, `
		SELECT source.value->>'kind', coalesce(source.value->>'input_version_id',''), coalesce(document_version.filename, ''), coalesce(document_version.media_type, ''),
		       coalesce(document_version.size_bytes, 0), coalesce(document.status<>'active', false),
		       coalesce(source.value->>'connection_id',''), coalesce(source.value->>'provider',''), coalesce(connection.identity_label,'')
		FROM personal_profile_generations generation
		CROSS JOIN LATERAL jsonb_array_elements(generation.sources) WITH ORDINALITY AS source(value,ordinality)
		LEFT JOIN document_versions document_version ON document_version.id=source.value->>'input_version_id'
		LEFT JOIN documents document ON document.id=document_version.document_id AND document.tenant_id=document_version.tenant_id
		LEFT JOIN external_connections connection ON connection.id=source.value->>'connection_id'
		WHERE generation.id=$1
		ORDER BY source.ordinality`, generationID)
	if err != nil {
		return Generation{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var item GenerationSource
		if err = rows.Scan(&item.Kind, &item.InputVersionID, &item.Filename, &item.MediaType, &item.SizeBytes, &item.FileDeleted, &item.ConnectionID, &item.Provider, &item.IdentityLabel); err != nil {
			return Generation{}, err
		}
		value.Sources = append(value.Sources, item)
	}
	return value, rows.Err()
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

func commandReplay(ctx context.Context, tx pgx.Tx, actorID, operation, key string, hash []byte) (bool, string, error) {
	if strings.TrimSpace(key) == "" {
		return false, "", ErrInvalid
	}
	k := idempotency.ActorKey(actorID, operation, key)
	if err := idempotency.Lock(ctx, tx, k); err != nil {
		return false, "", err
	}
	record, found, err := idempotency.Lookup(ctx, tx, k, hash)
	if errors.Is(err, idempotency.ErrConflict) {
		return false, "", ErrIdempotencyReused
	}
	if err != nil || !found {
		return false, "", err
	}
	return true, record.ResourceID, nil
}

func saveCommandReceipt(ctx context.Context, tx pgx.Tx, actorID, operation, key string, hash []byte, resourceID string) error {
	return idempotency.Save(ctx, tx, idempotency.ActorKey(actorID, operation, key), hash, idempotency.Record{ResourceID: resourceID})
}

func plannedFileAllowed(filename, mediaType string, size int64, digest string) error {
	if size <= 0 || size > MaxFileBytes || len(digest) != 64 {
		return ErrInvalid
	}
	extension := strings.ToLower(filepath.Ext(filename))
	normalized := normalizeMediaType(mediaType)
	switch {
	case extension == ".pdf" && normalized == pdfMediaType:
	case extension == ".docx" && normalized == docxMediaType:
	case extension == ".md" && (normalized == "text/markdown" || normalized == "text/plain"):
	case extension == ".txt" && normalized == "text/plain":
	default:
		return ErrInvalid
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return ErrInvalid
	}
	return nil
}
