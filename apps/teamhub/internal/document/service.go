package document

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/keywordsearch"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrInvalidInput           = errors.New("invalid Document input")
	ErrNotFound               = errors.New("Document not found")
	ErrIdempotencyConflict    = errors.New("Document idempotency key reused")
	ErrVersionConflict        = errors.New("Document current Version changed")
	ErrCollaboratorConflict   = errors.New("Document collaborator source changed")
	ErrRuntimeUnavailable     = errors.New("Document Runtime unavailable")
	ErrRuntimeResultInvalid   = errors.New("Document Runtime result is invalid")
	ErrRecoveryBudgetExceeded = errors.New("Document recovery bundle exceeds its configured limit")
	ErrObjectStoreUnavailable = errors.New("Document ObjectStore unavailable")
	ErrRevisionUnavailable    = errors.New("Document Revision unavailable")
	ErrWikiGenerationFailed   = errors.New("Personal Wiki generation failed")
	ErrAssetUnavailable       = errors.New("Document Asset unavailable")
	ErrAssetContentMismatch   = errors.New("Document Asset content mismatch")
	ErrAssetQuarantined       = errors.New("Document Asset quarantined")
	ErrAssetQuotaExceeded     = errors.New("Document Asset quota exceeded")
	ErrAssetStorageCapacity   = errors.New("Document Asset storage capacity exhausted")
)

type View string

const (
	ViewRecent    View = "recent"
	ViewOwned     View = "owned"
	ViewShareable View = "shareable"
	ViewShared    View = "shared"
	ViewUnfiled   View = "unfiled"
)

type Actor struct {
	ID, TenantID, Kind, DisplayName string
}

type VersionRef struct {
	ID            string
	VersionNumber int
	SHA256        string
}

type Capabilities struct {
	Read, Write, Manage, Delete, Duplicate, Export, Comment, UseAsContext bool
}

type Source struct {
	BindingKind, ContextID, Label, PageKey string
}

type AccessSourceProvenanceV2 struct {
	SchemaVersion     int     `json:"schema_version"`
	Kind              string  `json:"kind"`
	BindingKind       *string `json:"binding_kind,omitempty"`
	ContextID         *string `json:"context_id,omitempty"`
	MessageID         *string `json:"message_id,omitempty"`
	MembershipEpochID *string `json:"membership_epoch_id,omitempty"`
	MembershipMode    *string `json:"membership_mode,omitempty"`
}

type AccessTargetV2 struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type AccessSourceV2 struct {
	SchemaVersion  int                      `json:"schema_version"`
	SourceID       string                   `json:"source_id"`
	SourceKind     string                   `json:"source_kind"`
	Status         string                   `json:"status"`
	Role           string                   `json:"role"`
	SourceVersion  int64                    `json:"source_version"`
	GrantorActorID *string                  `json:"grantor_actor_id"`
	Target         *AccessTargetV2          `json:"target"`
	Provenance     AccessSourceProvenanceV2 `json:"provenance"`
	CreatedAt      time.Time                `json:"created_at"`
	UpdatedAt      time.Time                `json:"updated_at"`
}

type AccessEnvelopeV2 struct {
	SchemaVersion     int
	ContentRole       string
	LinkScope         string
	AuthorizationMode string
	Sources           []AccessSourceV2
}

type Document struct {
	currentActorID                                                             string
	readAt                                                                     time.Time
	ID, TenantID, Title, Format, RepresentationFormat, Status, DraftCapability string
	Owner, Creator                                                             Actor
	CurrentVersion                                                             *VersionRef
	From                                                                       []Source
	Capabilities                                                               Capabilities
	AccessV2                                                                   *AccessEnvelopeV2
	SearchMatch                                                                *SearchMatch
	CanEditNativeContent                                                       bool
	CreatedAt, UpdatedAt                                                       time.Time
}

// SearchMatch says how a Document's indexed body text took part in a search
// hit. BodySnippet is empty when only metadata matched.
type SearchMatch struct {
	BodyIndexStatus, BodySnippet string
}

type Version struct {
	ID, DocumentID, Filename, RepresentationFormat, MediaType, SHA256, Source string
	VersionNumber, ExporterSchemaVersion                                      int
	SizeBytes                                                                 int64
	CreatedBy                                                                 Actor
	SourceRevisionID, BaseVersionID, SourceInvocationID                       *string
	CreatedAt                                                                 time.Time
}

type Page[T any] struct {
	Items      []T
	NextCursor string
	HasMore    bool
}

type ListInput struct {
	AccountID string
	View      View
	Cursor    string
	Limit     int
}

type ListRoomInput struct {
	AccountID, RoomID, Cursor string
	Limit                     int
}

type ListPersonalWikiInput struct {
	AccountID, TenantID, Cursor string
	Limit                       int
}

type ListVersionsInput struct {
	AccountID, DocumentID, Cursor string
	Limit                         int
}

type SearchInput struct {
	AccountID, TenantID, Query, Cursor string
	Limit                              int
}

type Service struct {
	pool                    *pgxpool.Pool
	runtime                 Runtime
	objects                 artifactstore.ObjectStore
	assetOptions            AssetOptions
	connectionTokenKey      []byte
	latestProjectionMu      sync.Mutex
	latestProjectionFlights map[string]*latestProjectionFlight
}

type cursorState struct {
	Kind, PrincipalHash, Filter, ID string
	Updated                         time.Time
	Version                         int
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func NewWithObjectStore(pool *pgxpool.Pool, objects artifactstore.ObjectStore) *Service {
	return &Service{pool: pool, objects: objects}
}

func NewWithRuntime(pool *pgxpool.Pool, runtime Runtime, objects artifactstore.ObjectStore) *Service {
	return &Service{pool: pool, runtime: runtime, objects: objects, assetOptions: defaultAssetOptions()}
}

func (s *Service) Get(ctx context.Context, accountID, documentID string) (Document, error) {
	if accountID == "" || documentID == "" {
		return Document{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Document{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, accountID, documentID)
	if err != nil {
		return Document{}, err
	}
	if value.Status == "active" {
		if err := recordRecentOpen(ctx, tx, value.ID); err != nil {
			return Document{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Document{}, err
	}
	return value, nil
}

func (s *Service) List(ctx context.Context, input ListInput) (Page[Document], error) {
	if input.AccountID == "" || !validView(input.View) || input.Limit < 1 || input.Limit > 100 {
		return Page[Document]{}, ErrInvalidInput
	}
	cursor, err := decodeCursor(input.Cursor, "library", input.AccountID, string(input.View))
	if err != nil {
		return Page[Document]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[Document]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	listed, err := listIDs(ctx, tx, input, cursor)
	if err != nil {
		return Page[Document]{}, err
	}
	page := Page[Document]{Items: make([]Document, 0, min(len(listed), input.Limit))}
	if len(listed) > input.Limit {
		page.HasMore = true
		listed = listed[:input.Limit]
	}
	for _, item := range listed {
		value, getErr := get(ctx, tx, input.AccountID, item.ID)
		if getErr != nil {
			return Page[Document]{}, getErr
		}
		if input.View != ViewShareable || canManageCollaboratorsForAccess(value.AccessV2) {
			page.Items = append(page.Items, value)
		}
	}
	if page.HasMore {
		last := listed[len(listed)-1]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "library", PrincipalHash: principalHash(input.AccountID), Filter: string(input.View),
			Updated: last.SortTime, ID: last.ID,
		})
		if err != nil {
			return Page[Document]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[Document]{}, err
	}
	return page, nil
}

func (s *Service) ListRoom(ctx context.Context, input ListRoomInput) (Page[Document], error) {
	if input.AccountID == "" || input.RoomID == "" || input.Limit < 1 || input.Limit > 100 {
		return Page[Document]{}, ErrInvalidInput
	}
	cursor, err := decodeCursor(input.Cursor, "room", input.AccountID, input.RoomID)
	if err != nil {
		return Page[Document]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[Document]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var authorizedRoomID string
	err = tx.QueryRow(ctx, `
		SELECT room.id
		FROM rooms room
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                           AND principal.tenant_id=room.tenant_id
		JOIN active_room_members member ON member.room_id=room.id
		                               AND member.tenant_id=room.tenant_id
		                               AND member.actor_id=principal.id
		WHERE room.id=$2 AND room.deletion_started_at IS NULL
	`, input.AccountID, input.RoomID).Scan(&authorizedRoomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Page[Document]{}, ErrNotFound
	}
	if err != nil {
		return Page[Document]{}, err
	}
	listed, err := listRoomIDs(ctx, tx, input, cursor)
	if err != nil {
		return Page[Document]{}, err
	}
	page := Page[Document]{Items: make([]Document, 0, min(len(listed), input.Limit))}
	if len(listed) > input.Limit {
		page.HasMore = true
		listed = listed[:input.Limit]
	}
	for _, item := range listed {
		value, getErr := get(ctx, tx, input.AccountID, item.ID)
		if getErr != nil {
			return Page[Document]{}, getErr
		}
		page.Items = append(page.Items, value)
	}
	if page.HasMore {
		last := listed[len(listed)-1]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "room", PrincipalHash: principalHash(input.AccountID), Filter: input.RoomID,
			Updated: last.SortTime, ID: last.ID,
		})
		if err != nil {
			return Page[Document]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[Document]{}, err
	}
	return page, nil
}

func (s *Service) ListPersonalWiki(ctx context.Context, input ListPersonalWikiInput) (Page[Document], error) {
	if input.AccountID == "" || input.TenantID == "" || input.Limit < 1 || input.Limit > 100 {
		return Page[Document]{}, ErrInvalidInput
	}
	cursor, err := decodeCursor(input.Cursor, "wiki", input.AccountID, input.TenantID)
	if err != nil {
		return Page[Document]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[Document]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var wikiID string
	err = tx.QueryRow(ctx, `
		SELECT wiki.id
		FROM personal_wikis wiki
		JOIN actors principal ON principal.id=wiki.owner_actor_id
		                     AND principal.tenant_id=wiki.tenant_id
		                     AND principal.kind='human'
		WHERE principal.account_id=$1 AND wiki.tenant_id=$2 AND wiki.deleted_at IS NULL
	`, input.AccountID, input.TenantID).Scan(&wikiID)
	if errors.Is(err, pgx.ErrNoRows) {
		// No source has been added yet, so the Wiki root does not exist.
		return Page[Document]{Items: []Document{}}, nil
	}
	if err != nil {
		return Page[Document]{}, err
	}
	listed, err := listPersonalWikiIDs(ctx, tx, wikiID, input.Limit, cursor)
	if err != nil {
		return Page[Document]{}, err
	}
	page := Page[Document]{Items: make([]Document, 0, min(len(listed), input.Limit))}
	if len(listed) > input.Limit {
		page.HasMore = true
		listed = listed[:input.Limit]
	}
	for _, item := range listed {
		value, getErr := get(ctx, tx, input.AccountID, item.ID)
		if getErr != nil {
			return Page[Document]{}, getErr
		}
		page.Items = append(page.Items, value)
	}
	if page.HasMore {
		last := listed[len(listed)-1]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "wiki", PrincipalHash: principalHash(input.AccountID), Filter: input.TenantID,
			Updated: last.SortTime, ID: last.ID,
		})
		if err != nil {
			return Page[Document]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[Document]{}, err
	}
	return page, nil
}

func (s *Service) ListVersions(ctx context.Context, input ListVersionsInput) (Page[Version], error) {
	if input.AccountID == "" || input.DocumentID == "" || input.Limit < 1 || input.Limit > 100 {
		return Page[Version]{}, ErrInvalidInput
	}
	cursor, err := decodeCursor(input.Cursor, "versions", input.AccountID, input.DocumentID)
	if err != nil {
		return Page[Version]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[Version]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := get(ctx, tx, input.AccountID, input.DocumentID); err != nil {
		return Page[Version]{}, err
	}
	items, err := listVersions(ctx, tx, input.DocumentID, cursor, input.Limit+1)
	if err != nil {
		return Page[Version]{}, err
	}
	page := Page[Version]{Items: items}
	if len(items) > input.Limit {
		page.HasMore = true
		page.Items = items[:input.Limit]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "versions", PrincipalHash: principalHash(input.AccountID), Filter: input.DocumentID,
			Version: page.Items[len(page.Items)-1].VersionNumber,
		})
		if err != nil {
			return Page[Version]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[Version]{}, err
	}
	return page, nil
}

func (s *Service) Search(ctx context.Context, input SearchInput) (Page[Document], error) {
	query, ok := keywordsearch.Normalize(input.Query, keywordsearch.HumanQueryChars)
	if input.AccountID == "" || !ok || input.Limit < 1 || input.Limit > 100 {
		return Page[Document]{}, ErrInvalidInput
	}
	input.Query = query
	filter, err := searchFilterKey(input)
	if err != nil {
		return Page[Document]{}, err
	}
	cursor, err := decodeCursor(input.Cursor, "search", input.AccountID, filter)
	if err != nil {
		return Page[Document]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[Document]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := store.New(tx).LimitSearchStatementTime(ctx); err != nil {
		return Page[Document]{}, err
	}
	hits, err := searchHits(ctx, tx, input, cursor)
	if err != nil {
		return Page[Document]{}, err
	}
	page := Page[Document]{Items: make([]Document, 0, min(len(hits), input.Limit))}
	if len(hits) > input.Limit {
		page.HasMore = true
		hits = hits[:input.Limit]
	}
	for _, hit := range hits {
		// The Human reads every active Document and the page query and get share
		// one snapshot, so every hit is readable.
		value, getErr := get(ctx, tx, input.AccountID, hit.ID)
		if getErr != nil {
			return Page[Document]{}, getErr
		}
		value.SearchMatch = &hit.Match
		page.Items = append(page.Items, value)
	}
	if page.HasMore {
		last := hits[len(hits)-1]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "search", PrincipalHash: principalHash(input.AccountID), Filter: filter,
			Updated: last.UpdatedAt, ID: last.ID,
		})
		if err != nil {
			return Page[Document]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[Document]{}, err
	}
	return page, nil
}

func searchFilterKey(input SearchInput) (string, error) {
	value := struct{ TenantID, Query string }{input.TenantID, input.Query}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode Document search filter: %w", err)
	}
	return string(encoded), nil
}

func encodeCursor(cursor cursorState) (string, error) {
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode Document cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

func decodeCursor(encoded, kind, accountID, filter string) (*cursorState, error) {
	if encoded == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, ErrInvalidInput
	}
	var cursor cursorState
	if json.Unmarshal(data, &cursor) != nil || cursor.Kind != kind ||
		cursor.PrincipalHash != principalHash(accountID) || cursor.Filter != filter {
		return nil, ErrInvalidInput
	}
	if ((kind == "library" || kind == "search" || kind == "history") && (cursor.ID == "" || cursor.Updated.IsZero())) ||
		(kind == "versions" && cursor.Version < 1) {
		return nil, ErrInvalidInput
	}
	return &cursor, nil
}

func principalHash(accountID string) string {
	hash := sha256.Sum256([]byte(accountID))
	return hex.EncodeToString(hash[:])
}

func validView(view View) bool {
	switch view {
	case ViewRecent, ViewOwned, ViewShared, ViewUnfiled, ViewShareable:
		return true
	default:
		return false
	}
}
