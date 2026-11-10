package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

type CreateMessageAttachmentInput struct {
	TenantID, RoomID, ActorID, UploadID                  string
	Filename, RepresentationFormat, MediaType, ObjectKey string
	SizeBytes                                            int64
	SHA256                                               string
}

type MessageAttachmentDocument struct {
	DocumentID, DocumentVersionID string
}

type CreateAgentMessageAttachmentInput struct {
	WorkItemID string
	// NativeDocument turns a Markdown attachment into an editable Document;
	// otherwise it stays an immutable file.
	NativeDocument                                       bool
	TenantID, RoomID, AgentActorID                       string
	AttachmentKey, SourceInvocationID                    string
	Filename, RepresentationFormat, MediaType, ObjectKey string
	SizeBytes                                            int64
	SHA256                                               string
}

func AgentMessageAttachmentIdentity(
	agentActorID, attachmentKey, contentSHA256 string,
) (MessageAttachmentDocument, error) {
	if agentActorID == "" || attachmentKey == "" || len(attachmentKey) > 255 ||
		!validMessageAttachmentSHA256(contentSHA256) {
		return MessageAttachmentDocument{}, ErrInvalidInput
	}
	documentID := stableCreateID(
		"document_", agentActorID, "agent_message_attachment", attachmentKey,
	)
	return MessageAttachmentDocument{
		DocumentID: documentID,
		DocumentVersionID: stableCreateID(
			"document_version_", documentID, contentSHA256,
		),
	}, nil
}

// CreateAgentMessageAttachmentTx persists an Agent-owned immutable file with
// Room collaboration authority. Agent-owned Documents have no personal placement.
func (s *Service) CreateAgentMessageAttachmentTx(
	ctx context.Context,
	tx pgx.Tx,
	input CreateAgentMessageAttachmentInput,
) (MessageAttachmentDocument, error) {
	input.Filename = strings.TrimSpace(input.Filename)
	input.RepresentationFormat = strings.TrimSpace(input.RepresentationFormat)
	input.MediaType = strings.TrimSpace(input.MediaType)
	if s == nil || tx == nil || input.TenantID == "" || input.RoomID == "" ||
		input.AgentActorID == "" ||
		input.AttachmentKey == "" || len(input.AttachmentKey) > 255 ||
		input.SourceInvocationID == "" || len(input.SourceInvocationID) > 255 ||
		input.Filename == "" || len(input.Filename) > 255 ||
		input.RepresentationFormat == "" || len(input.RepresentationFormat) > 120 ||
		input.MediaType == "" || len(input.MediaType) > 255 || input.ObjectKey == "" ||
		input.SizeBytes < 0 || !validMessageAttachmentSHA256(input.SHA256) {
		return MessageAttachmentDocument{}, ErrInvalidInput
	}
	identity, err := AgentMessageAttachmentIdentity(
		input.AgentActorID, input.AttachmentKey, input.SHA256,
	)
	if err != nil {
		return MessageAttachmentDocument{}, err
	}
	return s.createAgentMessageAttachmentWithIdentityTx(ctx, tx, input, identity)
}

// Capture keeps its pre-reserved stable IDs while sharing Agent ownership,
// registration fencing, Room authority and attachment persistence.
func (s *Service) createAgentMessageAttachmentWithIdentityTx(ctx context.Context, tx pgx.Tx, input CreateAgentMessageAttachmentInput, identity MessageAttachmentDocument) (MessageAttachmentDocument, error) {
	var registrationStatus string
	err := tx.QueryRow(ctx, `SELECT status FROM agent_registrations WHERE actor_id=$1 AND tenant_id=$2 FOR UPDATE`, input.AgentActorID, input.TenantID).Scan(&registrationStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return MessageAttachmentDocument{}, ErrNotFound
	}
	if err != nil {
		return MessageAttachmentDocument{}, err
	}
	if registrationStatus != "active" {
		return MessageAttachmentDocument{}, ErrNotFound
	}
	var authorized bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1
		FROM actors agent
		JOIN agent_registrations registration
		  ON registration.actor_id=agent.id AND registration.tenant_id=agent.tenant_id
		 AND registration.status='active'
		JOIN rooms room
		  ON room.id=$3 AND room.tenant_id=agent.tenant_id
		 AND room.deletion_started_at IS NULL
		JOIN active_room_members agent_member
		  ON agent_member.room_id=room.id AND agent_member.tenant_id=room.tenant_id AND agent_member.actor_id=agent.id
		WHERE agent.id=$1 AND agent.tenant_id=$2 AND agent.kind='agent'
	)`, input.AgentActorID, input.TenantID, input.RoomID).Scan(&authorized); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if !authorized {
		return MessageAttachmentDocument{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,$4,$5,'agent',$5,'agent','active')`, identity.DocumentID,
		input.TenantID, input.Filename, input.RepresentationFormat, input.AgentActorID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id,source_invocation_id
	) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'agent_publication',$10,$11)`,
		identity.DocumentVersionID, input.TenantID, identity.DocumentID, input.Filename,
		input.RepresentationFormat, input.MediaType, input.SizeBytes, input.SHA256,
		input.ObjectKey, input.AgentActorID, input.SourceInvocationID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	command, err := tx.Exec(ctx, `UPDATE documents
		SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`, identity.DocumentID,
		identity.DocumentVersionID, input.TenantID)
	if err != nil {
		return MessageAttachmentDocument{}, err
	}
	if command.RowsAffected() != 1 {
		return MessageAttachmentDocument{}, ErrConflict
	}
	if input.NativeDocument && input.RepresentationFormat == "markdown" {
		if err := startNativeImportTx(ctx, tx, input.TenantID, identity.DocumentID, identity.DocumentVersionID, true); err != nil {
			return MessageAttachmentDocument{}, err
		}
		if err := enqueueNativeImportMigrationTx(ctx, tx, identity.DocumentID); err != nil {
			return MessageAttachmentDocument{}, err
		}
	}
	bindingID := stableCreateID("document_binding_", identity.DocumentID, "room", input.RoomID)
	if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,room_id,status,role)
	 VALUES($1,$2,$3,'room',$4,'active','manager')`, bindingID, input.TenantID, identity.DocumentID, input.RoomID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if input.WorkItemID != "" {
		var taskRoomMatches bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM work_items item JOIN work_item_room_links link ON link.work_item_id=item.id AND link.tenant_id=item.tenant_id AND link.link_type='work' WHERE item.id=$1 AND item.tenant_id=$2 AND item.kind='task' AND item.archived_at IS NULL AND link.room_id=$3)`, input.WorkItemID, input.TenantID, input.RoomID).Scan(&taskRoomMatches); err != nil {
			return MessageAttachmentDocument{}, err
		}
		if !taskRoomMatches {
			return MessageAttachmentDocument{}, ErrNotFound
		}
		taskBindingID := stableCreateID("document_binding_", identity.DocumentID, "task", input.WorkItemID)
		if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,work_item_id,status,role) VALUES($1,$2,$3,'task',$4,'active','manager')`, taskBindingID, input.TenantID, identity.DocumentID, input.WorkItemID); err != nil {
			return MessageAttachmentDocument{}, err
		}
	}
	if err := appendLifecycleEvent(
		ctx, tx, input.TenantID, identity.DocumentID, input.AgentActorID,
		identity.DocumentVersionID, "document_version", "document.created",
	); err != nil {
		return MessageAttachmentDocument{}, err
	}
	return identity, nil
}

func validMessageAttachmentSHA256(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

// MessageAttachmentDocumentID derives the ID of the Document a Message
// attachment upload creates, so an upload attaches at most once.
func MessageAttachmentDocumentID(tenantID, uploadID string) string {
	return stableCreateID("document_", tenantID, uploadID)
}

func (s *Service) CreateMessageAttachmentTx(
	ctx context.Context,
	tx pgx.Tx,
	input CreateMessageAttachmentInput,
) (MessageAttachmentDocument, error) {
	input.Filename = strings.TrimSpace(input.Filename)
	input.RepresentationFormat = strings.TrimSpace(input.RepresentationFormat)
	input.MediaType = strings.TrimSpace(input.MediaType)
	if tx == nil || input.TenantID == "" || input.RoomID == "" || input.ActorID == "" ||
		input.UploadID == "" || input.Filename == "" || len(input.Filename) > 255 ||
		input.RepresentationFormat == "" || len(input.RepresentationFormat) > 120 ||
		input.MediaType == "" || len(input.MediaType) > 255 || input.ObjectKey == "" ||
		input.SizeBytes < 0 || len(input.SHA256) != 64 {
		return MessageAttachmentDocument{}, ErrInvalidInput
	}
	var authorizedActorID string
	if err := tx.QueryRow(ctx, `SELECT actor.id
		FROM actors actor
		JOIN active_room_members member
		  ON member.actor_id=actor.id AND member.tenant_id=actor.tenant_id
		JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
		WHERE actor.id=$1 AND actor.tenant_id=$2 AND actor.kind='human'
		  AND member.room_id=$3`, input.ActorID, input.TenantID, input.RoomID).Scan(&authorizedActorID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MessageAttachmentDocument{}, ErrNotFound
		}
		return MessageAttachmentDocument{}, err
	}
	documentID := MessageAttachmentDocumentID(input.TenantID, input.UploadID)
	versionID := stableCreateID("document_version_", documentID, input.SHA256)
	bindingID := stableCreateID("document_binding_", documentID, "room", input.RoomID)
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,$4,$5,'human',$5,'human','active')`, documentID,
		input.TenantID, input.Filename, input.RepresentationFormat, authorizedActorID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'ordinary_upload',$10)`, versionID,
		input.TenantID, documentID, input.Filename, input.RepresentationFormat, input.MediaType,
		input.SizeBytes, input.SHA256, input.ObjectKey, authorizedActorID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	command, err := tx.Exec(ctx, `UPDATE documents
		SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`, documentID, versionID,
		input.TenantID)
	if err != nil {
		return MessageAttachmentDocument{}, err
	}
	if command.RowsAffected() != 1 {
		return MessageAttachmentDocument{}, ErrConflict
	}
	if input.RepresentationFormat == "markdown" {
		if err := startNativeImportTx(ctx, tx, input.TenantID, documentID, versionID, false); err != nil {
			return MessageAttachmentDocument{}, err
		}
		if err := enqueueNativeImportMigrationTx(ctx, tx, documentID); err != nil {
			return MessageAttachmentDocument{}, err
		}
	}
	if err := insertPersonalDocumentPlacement(
		ctx, tx, input.TenantID, authorizedActorID, documentID, nil,
	); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES($1,$2,$3,'room',$4,'active')`, bindingID, input.TenantID, documentID,
		input.RoomID); err != nil {
		return MessageAttachmentDocument{}, err
	}
	if err := appendLifecycleEvent(
		ctx, tx, input.TenantID, documentID, authorizedActorID, versionID,
		"document_version", "document.created",
	); err != nil {
		return MessageAttachmentDocument{}, err
	}
	return MessageAttachmentDocument{DocumentID: documentID, DocumentVersionID: versionID}, nil
}
