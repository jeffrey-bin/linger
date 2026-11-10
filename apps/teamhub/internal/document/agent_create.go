package document

import (
	"context"
	"crypto/sha256"
	"errors"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

type CreateAgentDocumentInput struct {
	Principal                                *agentcredential.Principal
	TargetKind, TargetID, SourceInvocationID string
	Title, Markdown                          string
}

type CreateAgentDocumentResult struct {
	DocumentID, RevisionID string
	Replayed               bool
}

type agentDocumentCreationAuthority struct {
	TenantID, AgentActorID, ManagementID string
	ContextKind, ContextID               string
}

const agentCreateDocumentOperation = "document.agent_create"

// CreateAgentDocument creates a native Document from an Agent's Markdown. It
// imports the Markdown through the Runtime, stores the embedded images, and
// creates the Document, its Assets and body in one transaction. A retry with
// the same source invocation reuses the stored images and replays the
// committed result.
func (s *Service) CreateAgentDocument(
	ctx context.Context,
	input CreateAgentDocumentInput,
) (CreateAgentDocumentResult, error) {
	requestHash, err := validateAgentDocumentCreateInput(input)
	if err != nil {
		return CreateAgentDocumentResult{}, ErrInvalidInput
	}
	if s == nil || s.pool == nil || s.runtime == nil {
		return CreateAgentDocumentResult{}, ErrRuntimeUnavailable
	}
	prepared, err := PrepareImport([]byte(input.Markdown))
	if err != nil {
		return CreateAgentDocumentResult{}, markdownError(err)
	}
	authority, replay, err := s.agentCreationPreflight(ctx, input, requestHash)
	if err != nil || replay != nil {
		if replay != nil {
			return *replay, nil
		}
		return CreateAgentDocumentResult{}, err
	}
	commandID := stableCreateID("document_agent_creation_", authority.AgentActorID, input.SourceInvocationID)
	documentID := stableCreateID("document_", authority.AgentActorID, input.SourceInvocationID)
	request, assets, err := s.planAgentDocumentAssets(commandID, documentID, input.Markdown, prepared)
	if err != nil {
		return CreateAgentDocumentResult{}, err
	}
	computed, err := s.runtime.Import(ctx, request)
	if err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if !validNativeMaterialization(computed, request.AllowedAssetIDs) {
		return CreateAgentDocumentResult{}, ErrRuntimeResultInvalid
	}
	if err := requireStateBundleBudget(
		computed.StateBytes,
		computed.StateVector,
		computed.CompleteAssetIDs,
		computed.CompleteThreadIDs,
	); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if err := s.storeAgentDocumentAssets(ctx, assets); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		result, err := s.commitAgentDocumentCreation(ctx, input, requestHash, authority,
			commandID, documentID, assets, computed)
		if !isDocumentSerializationFailure(err) || attempt == 2 {
			return result, err
		}
	}
	return CreateAgentDocumentResult{}, ErrConflict
}

func validateAgentDocumentCreateInput(input CreateAgentDocumentInput) ([]byte, error) {
	if input.Principal == nil || input.SourceInvocationID == "" || len(input.SourceInvocationID) > 255 ||
		!utf8.ValidString(input.Title) || len(input.Title) < 1 || len(input.Title) > 255 ||
		!utf8.ValidString(input.Markdown) || len(input.Markdown) > 1048576 {
		return nil, ErrInvalidInput
	}
	contentDigest := sha256.Sum256([]byte(input.Markdown))
	hash := sha256.New()
	authority := "agent:" + input.Principal.AgentActorID + ":" + input.TargetKind + ":" + input.TargetID
	_, _ = hash.Write([]byte(authority + "\x00" + input.Title + "\x00"))
	_, _ = hash.Write(contentDigest[:])
	return hash.Sum(nil), nil
}

// agentCreationPreflight checks the Agent's authority before any image or
// Runtime work and returns a committed result of the same invocation. The
// transaction stays read-write because the credential check takes row locks,
// which PostgreSQL refuses in a read-only transaction.
func (s *Service) agentCreationPreflight(ctx context.Context, input CreateAgentDocumentInput,
	requestHash []byte,
) (agentDocumentCreationAuthority, *CreateAgentDocumentResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return agentDocumentCreationAuthority{}, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authority, err := principalCreationAuthority(ctx, tx, input)
	if err != nil {
		return authority, nil, err
	}
	replay, err := agentCreationReplay(ctx, tx, authority.AgentActorID, input.SourceInvocationID, requestHash)
	return authority, replay, err
}

func agentCreationReplay(ctx context.Context, tx pgx.Tx, agentActorID, sourceInvocationID string,
	requestHash []byte,
) (*CreateAgentDocumentResult, error) {
	record, found, err := idempotency.Lookup(ctx, tx,
		idempotency.AgentKey(agentActorID, agentCreateDocumentOperation, sourceInvocationID), requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return nil, ErrIdempotencyConflict
	}
	if err != nil || !found {
		return nil, err
	}
	return &CreateAgentDocumentResult{
		DocumentID: record.ResourceID, RevisionID: string(record.Body), Replayed: true,
	}, nil
}

func (s *Service) commitAgentDocumentCreation(
	ctx context.Context,
	input CreateAgentDocumentInput,
	requestHash []byte,
	preflight agentDocumentCreationAuthority,
	commandID, documentID string,
	assets []agentDocumentAsset,
	computed ImportedState,
) (CreateAgentDocumentResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return CreateAgentDocumentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	key := idempotency.AgentKey(preflight.AgentActorID, agentCreateDocumentOperation, input.SourceInvocationID)
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if replay, err := agentCreationReplay(ctx, tx, preflight.AgentActorID, input.SourceInvocationID,
		requestHash); err != nil || replay != nil {
		if replay != nil {
			return *replay, tx.Commit(ctx)
		}
		return CreateAgentDocumentResult{}, err
	}
	var registrationStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM agent_registrations
		WHERE actor_id=$1 AND tenant_id=$2 FOR UPDATE`, preflight.AgentActorID, preflight.TenantID).Scan(
		&registrationStatus,
	); errors.Is(err, pgx.ErrNoRows) {
		return CreateAgentDocumentResult{}, ErrNotFound
	} else if err != nil {
		return CreateAgentDocumentResult{}, err
	} else if registrationStatus != "active" {
		return CreateAgentDocumentResult{}, ErrNotFound
	}
	current, err := principalCreationAuthority(ctx, tx, input)
	if err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if current != preflight {
		return CreateAgentDocumentResult{}, ErrNotFound
	}
	tenantID, agentActorID := current.TenantID, current.AgentActorID
	revisionID := stableCreateID("document_revision_", documentID, commandID)
	bindingID := stableCreateID("document_binding_", documentID, current.ContextKind, current.ContextID)
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,'blocknote',$4,'agent',$4,'agent','active')`,
		documentID, tenantID, input.Title, agentActorID); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	assetManifest, err := s.insertAgentDocumentAssets(ctx, tx, tenantID, agentActorID, documentID,
		assets, computed.CompleteAssetIDs)
	if err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES($1,$2,$3,0,$4,$5,'available',$6,$7,$8,$9,$10)`, revisionID, tenantID,
		documentID, computed.StateVector, computed.FullStateFingerprint, computed.StateBytes,
		computed.StateBytesSHA256, assetManifest, computed.CompleteThreadIDs, agentActorID); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if err := insertBodyTx(ctx, tx, documentID, computed.StateBytes, computed.StateVector,
		computed.CompleteAssetIDs, computed.CompleteThreadIDs, agentActorID); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,work_item_id,room_id,status,role
	) VALUES($1,$2,$3,'room',NULL,$4,'active','manager')`, bindingID, tenantID, documentID, current.ContextID); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if err := appendLifecycleEvent(ctx, tx, tenantID, documentID, agentActorID,
		commandID, "agent_create_command", "document.created"); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if err := idempotency.Save(ctx, tx, key, requestHash, idempotency.Record{
		ResourceID: documentID, Status: 201, Body: []byte(revisionID),
		CredentialID: input.Principal.CredentialID,
	}); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateAgentDocumentResult{}, err
	}
	return CreateAgentDocumentResult{DocumentID: documentID, RevisionID: revisionID}, nil
}

// agentImportID seeds the imported state of one creation command.
func agentImportID(commandID string) string {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(commandID)).String()
}
