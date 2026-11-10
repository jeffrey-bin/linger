// Package collaboration owns the Human side of Rooms and Messages: Room
// creation, membership, participation, threads, history shares, and Human
// Message creation, attachments and reads. Each command runs in one
// transaction that commits its facts with their Room Events.
package collaboration

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// Service runs Room and Message commands and reads for Humans.
type Service struct {
	pool       *pgxpool.Pool
	queries    *store.Queries
	artifacts  artifactstore.ObjectStore
	documents  *document.Service
	typedCards *typedcard.Service
	signingKey []byte
	logger     *slog.Logger
}

// New builds the Service. signingKey signs Message attachment upload
// credentials.
func New(pool *pgxpool.Pool, artifacts artifactstore.ObjectStore, documents *document.Service, typedCards *typedcard.Service, signingKey []byte, logger *slog.Logger) *Service {
	return &Service{
		pool: pool, queries: store.New(pool), artifacts: artifacts,
		documents: documents, typedCards: typedCards, signingKey: signingKey, logger: logger,
	}
}

func textValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func optionalStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
