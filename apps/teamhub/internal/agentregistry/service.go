// Package agentregistry owns Agent registrations: creation, update, profile
// changes, avatars, deletion, Agent templates and Skill bindings.
//
// An Agent registration is a TeamHub row: creation, update, move and deletion
// each commit in one transaction, and Agent Service reads the row when it next
// runs the Agent. The Computer the Agent is placed on does not need to be
// online; the Agent waits for it.
package agentregistry

import (
	"log/slog"
	"regexp"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// localComputerIDPattern matches Local Computer and workspace grant IDs.
var localComputerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// Service runs Agent registration commands and reads.
type Service struct {
	pool            *pgxpool.Pool
	queries         *store.Queries
	artifacts       artifactstore.ObjectStore
	collaboration   *collaboration.Service
	agentManagement roomagent.AgentManagement
	logger          *slog.Logger
}

// New builds the Service. agentManagement may be nil when no Agent Service
// is configured; registration changes then wake nothing.
func New(pool *pgxpool.Pool, artifacts artifactstore.ObjectStore, rooms *collaboration.Service, agentManagement roomagent.AgentManagement, logger *slog.Logger) *Service {
	return &Service{
		pool: pool, queries: store.New(pool), artifacts: artifacts,
		collaboration: rooms, agentManagement: agentManagement, logger: logger,
	}
}

func textValue(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}
