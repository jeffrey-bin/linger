package mcpcontext

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Errors returned by Resolve.
var (
	// ErrInvalid reports a malformed resolve request.
	ErrInvalid = errors.New("invalid MCP Context request")
	// ErrIdentityInvalid reports an Agent or Context the request may not use.
	ErrIdentityInvalid = errors.New("MCP Context identity is invalid")
	// ErrDependencyFailed reports a dependency that could not answer.
	ErrDependencyFailed = errors.New("MCP Context dependency is unavailable")
)

type ContextRef struct {
	// Transport changes tool exposure, never the canonical Context identity or lock.
	Kind       string
	TaskID     string
	RoomID     string
	DocumentID string
}

type ResolveResult struct {
	AgentID                string
	Context                ContextRef
	DocumentCommentRuntime *DocumentCommentRuntime
}

type DocumentCommentRuntime struct {
	CommentsMarkdown string
	CurrentDocument  document.LatestRuntimeProjection
}

type Identity struct {
	AgentID                  string
	AgentActorID             string
	UserArtifactOwnerActorID string
	TenantID                 string
	AgentType                string
	ContextKind              string
	TaskID                   string
	RoomID                   string
	DocumentID               string
	MembershipEpochID        string
	DocumentCommentsMarkdown string
}

type DocumentInputResolver interface {
	LatestDocumentRuntimeProjection(context.Context, string) (document.LatestRuntimeProjection, error)
}

type Service struct {
	pool           *pgxpool.Pool
	documentInputs DocumentInputResolver
}

func New(pool *pgxpool.Pool, documentInputs DocumentInputResolver) *Service {
	return &Service{pool: pool, documentInputs: documentInputs}
}

// Resolve checks the current authority of one Context before the Agent Service
// activates it. A Document Context also returns the comment and current
// Document projection of the Run it serves. Nothing is persisted. Skills are
// not part of it: Agent Service reads the Agent's effective Skill set
// separately.
func (s *Service) Resolve(ctx context.Context, agentID string, ref ContextRef) (ResolveResult, error) {
	if s == nil || s.pool == nil || !validAgentID(agentID) || !validContextRef(ref) {
		return ResolveResult{}, ErrInvalid
	}
	// Read Committed: a FOR SHARE read that waited on a configuration update
	// returns the committed row, so resolve reports the update instead of a
	// serialization failure. The shared locks keep the rows stable until commit.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return ResolveResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identity, err := resolveIdentity(ctx, store.New(tx), agentID, ref)
	if err != nil {
		return ResolveResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResolveResult{}, err
	}
	result := ResolveResult{AgentID: agentID, Context: ref}
	if ref.Kind != "document" {
		return result, nil
	}
	if s.documentInputs == nil {
		return ResolveResult{}, ErrDependencyFailed
	}
	current, err := s.documentInputs.LatestDocumentRuntimeProjection(ctx, ref.DocumentID)
	if err != nil {
		return ResolveResult{}, errors.Join(ErrDependencyFailed, err)
	}
	result.DocumentCommentRuntime = &DocumentCommentRuntime{
		CommentsMarkdown: identity.DocumentCommentsMarkdown, CurrentDocument: current,
	}
	return result, nil
}

// resolveIdentity reads the Agent and its Context authority FOR SHARE.
func resolveIdentity(ctx context.Context, queries *store.Queries, agentID string, ref ContextRef) (Identity, error) {
	registration, err := queries.GetActiveMcpContextAgentForShare(ctx, agentID)
	actorID, tenantID, agentType := registration.ActorID, registration.TenantID, registration.AgentType
	ownerActorID := registration.UserArtifactOwnerActorID
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, ErrIdentityInvalid
	}
	if err != nil {
		return Identity{}, err
	}
	if !validAgentType(agentType) {
		return Identity{}, ErrIdentityInvalid
	}
	identity := Identity{
		AgentID: agentID, AgentActorID: actorID, TenantID: tenantID,
		AgentType: agentType, ContextKind: ref.Kind, TaskID: ref.TaskID,
		RoomID: ref.RoomID, DocumentID: ref.DocumentID,
	}
	if ownerActorID.Valid {
		identity.UserArtifactOwnerActorID = ownerActorID.String
	}
	if ref.Kind == "document" {
		authority, err := queries.AuthorizeDocumentMcpContextForShare(ctx, store.AuthorizeDocumentMcpContextForShareParams{
			AgentManagementID: agentID, DocumentID: ref.DocumentID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return Identity{}, ErrIdentityInvalid
		}
		if err != nil {
			return Identity{}, err
		}
		if authority.ActorID != actorID || authority.TenantID != tenantID || authority.LocalRunID == "" {
			return Identity{}, ErrIdentityInvalid
		}
		if !authority.Ready {
			return Identity{}, ErrDependencyFailed
		}
		commentsMarkdown, projectionErr := documentCommentsMarkdown(authority.NotificationPayload)
		if projectionErr != nil {
			return Identity{}, ErrIdentityInvalid
		}
		identity.DocumentCommentsMarkdown = commentsMarkdown
	}
	if ref.Kind == "meta" {
		if ref.RoomID == "" {
			return Identity{}, ErrIdentityInvalid
		}
		authority, authorityErr := queries.AuthorizePerRoomMetaMcpContextForShare(ctx, store.AuthorizePerRoomMetaMcpContextForShareParams{
			AgentManagementID: agentID, RoomID: ref.RoomID,
		})
		authorityActorID, authorityTenantID := authority.AgentActorID, authority.TenantID
		membershipEpochID := authority.MembershipEpochID.String
		if errors.Is(authorityErr, pgx.ErrNoRows) {
			return Identity{}, ErrIdentityInvalid
		}
		if authorityErr != nil {
			return Identity{}, authorityErr
		}
		if authorityActorID != actorID || authorityTenantID != tenantID || membershipEpochID == "" {
			return Identity{}, ErrIdentityInvalid
		}
		identity.MembershipEpochID = membershipEpochID
	}
	if ref.Kind == "alter_ego" {
		authority, err := queries.AuthorizeAlterEgoMcpContextForShare(ctx, store.AuthorizeAlterEgoMcpContextForShareParams{TaskID: ref.TaskID, AgentManagementID: agentID})
		authorityActorID, authorityTenantID, generationValid := authority.ActorID, authority.TenantID, authority.Generation.Valid
		if errors.Is(err, pgx.ErrNoRows) {
			return Identity{}, ErrIdentityInvalid
		}
		if err != nil {
			return Identity{}, err
		}
		if authorityActorID != identity.AgentActorID || authorityTenantID != identity.TenantID || !generationValid {
			return Identity{}, ErrIdentityInvalid
		}
	}
	return identity, nil
}

func documentCommentsMarkdown(payload []byte) (string, error) {
	var message struct {
		RawMessage               string `json:"rawMessage"`
		DocumentCommentsMarkdown string `json:"documentCommentsMarkdown"`
	}
	if len(payload) == 0 || json.Unmarshal(payload, &message) != nil ||
		len(message.RawMessage) < 1 || len(message.RawMessage) > 262144 ||
		len(message.DocumentCommentsMarkdown) < 1 || len(message.DocumentCommentsMarkdown) > 4*1024*1024 {
		return "", ErrIdentityInvalid
	}
	return message.DocumentCommentsMarkdown, nil
}

func validAgentType(value string) bool {
	return value == "anotherme" || value == "general"
}

func validAgentID(value string) bool {
	return len(value) <= 64 && validIdentifier(value, false)
}

func validContextRef(ref ContextRef) bool {
	return ref.Kind == "meta" && ref.TaskID == "" && ref.DocumentID == "" && validAgentID(ref.RoomID) ||
		ref.Kind == "alter_ego" && ref.RoomID == "" && ref.DocumentID == "" && len(ref.TaskID) <= 128 && validTaskID(ref.TaskID) ||
		ref.Kind == "document" && ref.TaskID == "" && ref.RoomID == "" && validAgentID(ref.DocumentID)
}

func validIdentifier(value string, allowDot bool) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' || character == '-' || allowDot && character == '.' {
			continue
		}
		return false
	}
	return true
}

func validTaskID(value string) bool {
	if value == "" || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		character := value[index]
		if isASCIIAlphaNumeric(character) || character == '_' || character == '-' || character == '.' || character == ':' {
			continue
		}
		return false
	}
	return true
}

func isASCIIAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9'
}
