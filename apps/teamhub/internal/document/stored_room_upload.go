package document

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

type StoredRoomUploadInput struct {
	AccountID, RoomID, CommandID              string
	ReservedDocumentID, ReservedVersionID     string
	Filename, RepresentationFormat, MediaType string
	Object                                    artifactstore.Object
	// NativeDocument turns a Markdown upload into an editable Document where
	// the upload becomes an Agent attachment, in a direct Room.
	NativeDocument bool
}

func StoredRoomUploadIDs(ownerActorID, commandID, contentSHA256 string) (string, string) {
	documentID := stableCreateID("document_", ownerActorID, uploadRoomDocumentOperation, commandID)
	return documentID, stableCreateID("document_version_", documentID, contentSHA256)
}

func (s *Service) CreateStoredRoomUploadTx(
	ctx context.Context,
	tx pgx.Tx,
	input StoredRoomUploadInput,
) (Version, error) {
	input.Filename = strings.TrimSpace(input.Filename)
	input.RepresentationFormat = strings.TrimSpace(input.RepresentationFormat)
	input.MediaType = strings.TrimSpace(input.MediaType)
	if s == nil || tx == nil || input.AccountID == "" || input.RoomID == "" ||
		input.CommandID == "" || input.Filename == "" || len(input.Filename) > 255 ||
		input.RepresentationFormat == "" || len(input.RepresentationFormat) > 120 ||
		input.MediaType == "" || len(input.MediaType) > 255 || input.Object.Key == "" ||
		len(input.Object.Key) > 255 || input.Object.Size < 0 {
		return Version{}, ErrInvalidInput
	}
	tenantID, actorID, roomID, err := resolveUploadOwner(ctx, tx, input.AccountID, nil, uploadDocumentTarget{
		Kind: uploadDocumentContextRoom, ContextID: input.RoomID,
	})
	if err != nil {
		return Version{}, err
	}
	sha256 := hex.EncodeToString(input.Object.SHA256[:])
	documentID, versionID := StoredRoomUploadIDs(actorID, input.CommandID, sha256)
	if input.ReservedDocumentID != "" || input.ReservedVersionID != "" {
		reservedVersionSuffix := strings.TrimPrefix(input.ReservedVersionID, "document_version_")
		decodedVersionID, decodeErr := hex.DecodeString(reservedVersionSuffix)
		if input.ReservedDocumentID != documentID || len(decodedVersionID) != 16 ||
			decodeErr != nil || "document_version_"+reservedVersionSuffix != input.ReservedVersionID {
			return Version{}, ErrInvalidInput
		}
		versionID = input.ReservedVersionID
	}
	var directAgentID, directHumanID string
	directErr := tx.QueryRow(ctx, `SELECT direct_agent_actor_id,direct_human_actor_id FROM rooms WHERE id=$1 AND tenant_id=$2 AND direct_agent_actor_id IS NOT NULL`, roomID, tenantID).Scan(&directAgentID, &directHumanID)
	if directErr != nil && !errors.Is(directErr, pgx.ErrNoRows) {
		return Version{}, directErr
	}
	if directErr == nil {
		if directHumanID != actorID {
			return Version{}, ErrNotFound
		}
		_, err := s.createAgentMessageAttachmentWithIdentityTx(ctx, tx, CreateAgentMessageAttachmentInput{
			TenantID: tenantID, RoomID: roomID, AgentActorID: directAgentID, AttachmentKey: input.CommandID, SourceInvocationID: input.CommandID,
			Filename: input.Filename, RepresentationFormat: input.RepresentationFormat, MediaType: input.MediaType, ObjectKey: input.Object.Key, SizeBytes: input.Object.Size, SHA256: sha256,
			NativeDocument: input.NativeDocument,
		}, MessageAttachmentDocument{DocumentID: documentID, DocumentVersionID: versionID})
		if err != nil {
			return Version{}, err
		}
		return getVersionTx(ctx, tx, versionID)
	}
	if err := insertStoredUpload(ctx, tx, tenantID, actorID, documentID, versionID, input.Filename, input.RepresentationFormat, input.MediaType, input.Object); err != nil {
		return Version{}, err
	}
	bindingID := stableCreateID("document_binding_", documentID, uploadDocumentContextRoom, roomID)
	if _, err := tx.Exec(ctx, `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES($1,$2,$3,'room',$4,'active')`, bindingID, tenantID, documentID, roomID); err != nil {
		return Version{}, err
	}
	if err := appendLifecycleEvent(
		ctx, tx, tenantID, documentID, actorID, versionID, "document_version", "document.created",
	); err != nil {
		return Version{}, err
	}
	return getVersionTx(ctx, tx, versionID)
}

// insertStoredUpload creates a Human-owned Document whose only Version is an
// already stored object, placed in the owner's personal Documents.
func insertStoredUpload(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, actorID, documentID, versionID, filename, representationFormat, mediaType string,
	object artifactstore.Object,
) error {
	sha256 := hex.EncodeToString(object.SHA256[:])
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,$4,$5,'human',$5,'human','active')`,
		documentID, tenantID, filename, representationFormat, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'ordinary_upload',$10)`,
		versionID, tenantID, documentID, filename, representationFormat,
		mediaType, object.Size, sha256, object.Key, actorID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`, documentID, versionID, tenantID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrConflict
	}
	if err := insertPersonalDocumentPlacement(ctx, tx, tenantID, actorID, documentID, nil); err != nil {
		return err
	}
	return nil
}
