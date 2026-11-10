package personalprofile

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
)

const (
	PromptVersion             = "user-profile-v1"
	MaxSources                = 8
	MaxFiles                  = 5
	MaxFileBytes              = 5 << 20
	MaxTotalBytes             = 10 << 20
	MaxExtractedBytes         = 64 << 10
	MaxExternalAISummaryBytes = 64 << 10
	// MaxGenerationAttempts caps runs that ended without settling (a lost lease
	// or a crashed worker); deliberate requeues do not count.
	MaxGenerationAttempts = 3
	// ImportWaitDeadline bounds how long a generation waits for its source
	// imports, measured from its first claim.
	ImportWaitDeadline = 20 * time.Minute
)

var (
	ErrInvalid              = errors.New("invalid personal profile request")
	ErrNotFound             = errors.New("personal profile resource not found")
	ErrConflict             = errors.New("personal profile request conflicts with current state")
	ErrIdempotencyReused    = errors.New("personal profile idempotency key was reused")
	ErrUnsupportedSource    = errors.New("personal profile source is not supported")
	ErrGeneratorUnavailable = errors.New("personal profile generator is unavailable")
)

type SourceInput struct {
	Kind              string
	InputVersionID    string
	ConnectionID      string
	ExternalAISummary string
	Selections        []Selection
}

type Selection struct {
	RemoteID  string
	Name      string
	Kind      string
	IsPrivate bool
}

type GenerationSource struct {
	Kind, InputVersionID, Filename, MediaType string
	SizeBytes                                 int64
	FileDeleted                               bool
	ConnectionID, Provider, IdentityLabel     string
}

// Revision is one published version of a Human's private Profile.
type Revision struct {
	ID, TenantID, OwnerActorID, SourceProfileGenerationID string
	PromptVersion, Markdown                               string
	Profile                                               Document
	SourceApps                                            []string
	CreatedAt                                             time.Time
}

// Profile is a Human's current Revision and the newest Revisions.
type Profile struct {
	Current *Revision
	History []Revision
	HasMore bool
	// BuildingSince is set while the Profile is being written.
	BuildingSince *time.Time
}

type Generation struct {
	ID, TenantID, Status, DecisionStatus, PromptVersion       string
	BaseProfileRevisionID, CandidateRevisionID, LastErrorCode string
	Sources                                                   []GenerationSource
	CreatedAt, UpdatedAt                                      time.Time
	CompletedAt                                               *time.Time
}

type GenerationRequest struct {
	// TenantID and OwnerActorID name the Human whose Profile this is and whose
	// Another Me model is the fallback route.
	TenantID, OwnerActorID string
	SubjectDisplayName     string
	PromptVersion          string
	// BaselineProfile is the current Document as canonical JSON, empty for
	// initial extraction.
	BaselineProfile string
	Documents       []GenerationDocument
}

type GenerationDocument struct {
	Provider string
	Filename string
	Content  string
}

// InsightDocument is mail evidence a generation collected for its Personal
// Insight step: Content is the bounded JSON list of message inputs.
type InsightDocument struct {
	Provider string `json:"provider"`
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

type GenerationResult struct {
	Profile Document
	Account account.Fields
	Error   string
}

type Generator interface {
	Generate(context.Context, GenerationRequest) (GenerationResult, error)
}

func requestDigest(value any) []byte {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return sum[:]
}
