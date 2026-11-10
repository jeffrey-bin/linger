package personalinsight

import (
	"context"
	"errors"
	"time"
)

const (
	maxCurrentInsights = 5
	maxAttempts        = 3
)

var ErrNotFound = errors.New("personal insight not found")

// Generator generates Insights about the owner from tenant and owner actor IDs
// and grounded evidence.
type Generator interface {
	GenerateEvidence(ctx context.Context, tenantID, ownerActorID string, evidence []GroundingEvidence) (GenerationResult, error)
}

type Options struct {
	RetryDelay time.Duration
}

type Insight struct {
	ID        string
	Dimension string
	Statement string
	CreatedAt time.Time
}

type Generation struct {
	Status    string
	UpdatedAt time.Time
}

type ListResult struct {
	Items      []Insight
	Generation *Generation
}
