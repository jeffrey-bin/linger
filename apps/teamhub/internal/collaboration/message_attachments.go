package collaboration

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// MessageAttachmentUpload is one file a Human uploads for a later Message.
type MessageAttachmentUpload struct {
	Filename, MediaType string
	Content             multipart.File
}

const (
	messageAttachmentUploadTTL = 24 * time.Hour
	// The expiry job runs this long after a credential expires, so a send that
	// verified the credential just before expiry has committed.
	messageAttachmentExpiryGrace  = time.Minute
	messageAttachmentUploadDomain = "teamhub/message-attachment-upload/v1"
)

// messageAttachmentCredential is the signed upload credential a client sends
// back as an attachment upload ID. Its object key is the upload's identity.
type messageAttachmentCredential struct {
	TenantID        string    `json:"t"`
	RoomID          string    `json:"r"`
	UploaderActorID string    `json:"u"`
	Filename        string    `json:"f"`
	MediaType       string    `json:"m"`
	SizeBytes       int64     `json:"s"`
	SHA256          string    `json:"h"`
	ObjectKey       string    `json:"o"`
	CreatedAt       time.Time `json:"c"`
	ExpiresAt       time.Time `json:"e"`
}

// messageAttachmentExpiryArgs deletes an upload's object once its credential
// has expired, unless a Message attached it.
type messageAttachmentExpiryArgs struct {
	TenantID  string `json:"tenant_id"`
	ObjectKey string `json:"object_key"`
}

func (messageAttachmentExpiryArgs) Kind() string { return "message_attachment.expiry" }

func (messageAttachmentExpiryArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault}
}

// MessageAttachmentExpiryWorker returns the River worker that deletes an
// upload's object once its credential expired unless a Message attached it.
func (s *Service) MessageAttachmentExpiryWorker() *messageAttachmentExpiryWorker {
	return &messageAttachmentExpiryWorker{service: s}
}

type messageAttachmentExpiryWorker struct {
	river.WorkerDefaults[messageAttachmentExpiryArgs]
	service *Service
}

func (w *messageAttachmentExpiryWorker) Work(ctx context.Context, job *river.Job[messageAttachmentExpiryArgs]) error {
	_, err := w.service.deleteUnattachedMessageAttachmentObject(ctx, job.Args.TenantID, job.Args.ObjectKey)
	return err
}

// ErrAttachmentUploadUnavailable reports an upload that expired, was cancelled or was attached already.
var ErrAttachmentUploadUnavailable = errors.New("message attachment upload is unavailable")

// ErrInvalidMessageAttachment reports an attachment the Human may not attach.
var ErrInvalidMessageAttachment = errors.New("message attachment is invalid")

// Object storage and PostgreSQL cannot commit atomically. Preserve the object
// when PostgreSQL may have committed its metadata despite returning an error.
var errMessageAttachmentCommitOutcomeUnknown = errors.New("message attachment metadata commit outcome is unknown")

// KeepMessageAttachmentObject reports whether an uploaded object must stay after its upload transaction.
func KeepMessageAttachmentObject(replay bool, err error) bool {
	return (!replay && err == nil) || errors.Is(err, errMessageAttachmentCommitOutcomeUnknown)
}

// UploadMessageAttachment issues the upload credential of a stored object idempotently. It reports whether the result is a replay.
func (s *Service) UploadMessageAttachment(ctx context.Context, accountID, roomID string, upload MessageAttachmentUpload, object artifactstore.Object, key string) (idempotency.Result, bool, error) {
	operation := "uploadMessageAttachment:" + roomID
	requestHash := idempotency.HashRequest(map[string]any{"filename": upload.Filename, "media_type": upload.MediaType, "size": object.Size, "sha256": hex.EncodeToString(object.SHA256[:])})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err := idempotency.Lock(ctx, tx, idempotency.AccountKey(accountID, operation, key)); err != nil {
		return idempotency.Result{}, false, err
	}
	if replay, found, err := idempotency.Replay(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash); err != nil {
		return idempotency.Result{}, false, err
	} else if found {
		return replay, true, tx.Commit(ctx)
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	actor, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if _, err := queries.LockActiveRoomForMutation(ctx, room.ID); err != nil {
		return idempotency.Result{}, false, err
	}
	createdAt := time.Now().UTC().Truncate(time.Second)
	credential := messageAttachmentCredential{
		TenantID: room.TenantID, RoomID: room.ID, UploaderActorID: actor.ID,
		Filename: upload.Filename, MediaType: upload.MediaType, SizeBytes: object.Size,
		SHA256: hex.EncodeToString(object.SHA256[:]), ObjectKey: object.Key,
		CreatedAt: createdAt, ExpiresAt: createdAt.Add(messageAttachmentUploadTTL),
	}
	token, err := secretbox.Sign(s.signingKey, messageAttachmentUploadDomain, credential)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if err := jobs.InsertTx(ctx, tx, messageAttachmentExpiryArgs{TenantID: room.TenantID, ObjectKey: object.Key}, &river.InsertOpts{
		ScheduledAt: credential.ExpiresAt.Add(messageAttachmentExpiryGrace),
	}); err != nil {
		return idempotency.Result{}, false, err
	}
	body, err := json.Marshal(messageAttachmentUploadModel(token, credential))
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash, idempotency.Record{ResourceID: object.Key, Status: http.StatusCreated, Body: body}); err != nil {
		return idempotency.Result{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Result{}, false, errors.Join(errMessageAttachmentCommitOutcomeUnknown, err)
	}
	return idempotency.Result{Status: http.StatusCreated, Body: body}, false, nil
}

// verifyMessageAttachmentCredential accepts an unexpired credential that the
// actor was issued in this Room.
func (s *Service) verifyMessageAttachmentCredential(token string, room store.Room, actorID string) (messageAttachmentCredential, bool) {
	var credential messageAttachmentCredential
	return credential, secretbox.Verify(s.signingKey, messageAttachmentUploadDomain, token, &credential) &&
		credential.TenantID == room.TenantID && credential.RoomID == room.ID &&
		credential.UploaderActorID == actorID && time.Now().Before(credential.ExpiresAt)
}

// lockMessageAttachmentObject orders a send, a cancellation and the expiry
// job for one upload.
func lockMessageAttachmentObject(ctx context.Context, tx pgx.Tx, objectKey string) error {
	return store.New(tx).LockMessageAttachmentUpload(ctx, objectKey)
}

// messageAttachmentAvailable reports whether an upload's object is stored
// and no Message attached it yet: attaching creates the Document whose ID
// derives from the object key. The caller holds the upload's lock.
func (s *Service) messageAttachmentAvailable(ctx context.Context, tx pgx.Tx, tenantID, objectKey string) (bool, error) {
	attached, err := store.New(tx).DocumentExists(ctx, document.MessageAttachmentDocumentID(tenantID, objectKey))
	if err != nil {
		return false, err
	}
	if attached {
		return false, nil
	}
	stored, err := s.artifacts.Open(ctx, objectKey)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, stored.Close()
}

// deleteUnattachedMessageAttachmentObject deletes an upload's object unless a
// Message attached it. It reports whether it deleted a stored object.
func (s *Service) deleteUnattachedMessageAttachmentObject(ctx context.Context, tenantID, objectKey string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := lockMessageAttachmentObject(ctx, tx, objectKey); err != nil {
		return false, err
	}
	available, err := s.messageAttachmentAvailable(ctx, tx, tenantID, objectKey)
	if err != nil || !available {
		return false, err
	}
	if err := s.artifacts.Delete(ctx, objectKey); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func messageAttachmentUploadModel(token string, credential messageAttachmentCredential) httpapi.MessageAttachmentUpload {
	return httpapi.MessageAttachmentUpload{
		Id: token, RoomId: credential.RoomID, Filename: credential.Filename, MediaType: credential.MediaType,
		SizeBytes: credential.SizeBytes, Sha256: credential.SHA256, Status: "available",
		ExpiresAt: credential.ExpiresAt, CreatedAt: credential.CreatedAt,
	}
}

func (s *Service) hydrateMessageAttachments(ctx context.Context, messageIDs []string) (map[string][]httpapi.MessageAttachment, error) {
	result := make(map[string][]httpapi.MessageAttachment, len(messageIDs))
	for _, messageID := range messageIDs {
		result[messageID] = []httpapi.MessageAttachment{}
	}
	if len(messageIDs) == 0 {
		return result, nil
	}
	rows, err := s.queries.ListMessageAttachments(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.MessageID] = append(result[row.MessageID], messageAttachmentModel(row))
	}
	return result, nil
}

func (s *Service) prepareMessageAttachments(ctx context.Context, tx pgx.Tx, queries *store.Queries, room store.Room, actor store.Actor, messageID string, content MessageContent) (MessageContent, []httpapi.MessageAttachment, error) {
	fileReferences, err := messageFileReferences(content)
	if err != nil {
		return MessageContent{}, nil, err
	}
	prepared := make([]httpapi.MessageAttachment, 0, len(fileReferences)+len(content.contextDocumentVersionIDs)+len(content.attachmentUploadIDs))
	if len(fileReferences) > 0 {
		versionIDs := make([]string, 0, len(fileReferences))
		for _, reference := range fileReferences {
			versionIDs = append(versionIDs, reference.documentVersionID)
		}
		versions, err := queries.GetMessageAttachmentDocumentVersions(ctx, store.GetMessageAttachmentDocumentVersionsParams{
			Ids: versionIDs, TenantID: room.TenantID, RoomID: room.ID,
		})
		if err != nil {
			return MessageContent{}, nil, err
		}
		if len(versions) != len(fileReferences) {
			return MessageContent{}, nil, ErrInvalidMessageAttachment
		}
		for index, version := range versions {
			if version.ID != fileReferences[index].documentVersionID ||
				version.DocumentID != fileReferences[index].documentID {
				return MessageContent{}, nil, ErrInvalidMessageAttachment
			}
			var sourceRoomID *httpapi.Id
			if version.SourceRoomID.Valid {
				value := version.SourceRoomID.String
				sourceRoomID = &value
			}
			prepared = append(prepared, httpapi.MessageAttachment{
				Id: idgen.New("message_attachment"), DocumentId: version.DocumentID,
				DocumentVersionId: version.ID, SourceRoomId: sourceRoomID,
				Filename: version.Filename, MediaType: version.MediaType, SizeBytes: version.SizeBytes,
				Sha256: version.Sha256, Available: true,
			})
		}
	}
	if len(content.contextDocumentVersionIDs) > 0 {
		if !actor.AccountID.Valid {
			return MessageContent{}, nil, ErrInvalidMessageAttachment
		}
		versions, err := queries.GetAuthorizedMessageContextDocumentVersions(ctx, store.GetAuthorizedMessageContextDocumentVersionsParams{
			Ids: content.contextDocumentVersionIDs, TenantID: room.TenantID, AccountID: actor.AccountID.String,
		})
		if err != nil {
			return MessageContent{}, nil, err
		}
		if len(versions) != len(content.contextDocumentVersionIDs) {
			return MessageContent{}, nil, ErrInvalidMessageAttachment
		}
		for index, version := range versions {
			if version.ID != content.contextDocumentVersionIDs[index] {
				return MessageContent{}, nil, ErrInvalidMessageAttachment
			}
			content, err = content.appendAttachment(version.Filename, version.DocumentID)
			if err != nil {
				return MessageContent{}, nil, err
			}
			var sourceRoomID *httpapi.Id
			if version.SourceRoomID.Valid {
				value := version.SourceRoomID.String
				sourceRoomID = &value
			}
			prepared = append(prepared, httpapi.MessageAttachment{
				Id: idgen.New("message_attachment"), DocumentId: version.DocumentID,
				DocumentVersionId: version.ID, SourceRoomId: sourceRoomID,
				Filename: version.Filename, MediaType: version.MediaType, SizeBytes: version.SizeBytes,
				Sha256: version.Sha256, Available: true,
			})
		}
	}
	if len(content.attachmentUploadIDs) == 0 {
		return content, prepared, nil
	}
	uploads := make([]messageAttachmentCredential, 0, len(content.attachmentUploadIDs))
	for _, token := range content.attachmentUploadIDs {
		upload, ok := s.verifyMessageAttachmentCredential(token, room, actor.ID)
		if !ok {
			return MessageContent{}, nil, ErrAttachmentUploadUnavailable
		}
		uploads = append(uploads, upload)
	}
	// An upload attaches once: its Document ID derives from its object key,
	// and a cancelled or expired upload has no stored object. The lock orders
	// the send before a cancellation or the upload's expiry job.
	for _, upload := range uploads {
		if err := lockMessageAttachmentObject(ctx, tx, upload.ObjectKey); err != nil {
			return MessageContent{}, nil, err
		}
		available, err := s.messageAttachmentAvailable(ctx, tx, upload.TenantID, upload.ObjectKey)
		if err != nil {
			return MessageContent{}, nil, err
		}
		if !available {
			return MessageContent{}, nil, ErrAttachmentUploadUnavailable
		}
	}
	for _, upload := range uploads {
		created, err := s.documents.CreateMessageAttachmentTx(ctx, tx, document.CreateMessageAttachmentInput{
			TenantID: room.TenantID, RoomID: room.ID, ActorID: actor.ID, UploadID: upload.ObjectKey,
			Filename: upload.Filename, RepresentationFormat: messageAttachmentRepresentationFormat(upload.Filename, upload.MediaType),
			MediaType: upload.MediaType, ObjectKey: upload.ObjectKey, SizeBytes: upload.SizeBytes,
			SHA256: upload.SHA256,
		})
		if err != nil {
			return MessageContent{}, nil, err
		}
		if _, err := roomevent.Append(ctx, queries, roomevent.Input{
			TenantID: room.TenantID, RoomID: room.ID, EventType: "document.created",
			ActorID: actor.ID, ResourceID: created.DocumentID,
			Payload: map[string]any{
				"kind": "document.created", "document_id": created.DocumentID,
				"document_version_id": created.DocumentVersionID,
			},
		}); err != nil {
			return MessageContent{}, nil, err
		}
		content, err = content.appendAttachment(upload.Filename, created.DocumentID)
		if err != nil {
			return MessageContent{}, nil, err
		}
		sourceRoomID := room.ID
		prepared = append(prepared, httpapi.MessageAttachment{
			Id: idgen.New("message_attachment"), DocumentId: created.DocumentID,
			DocumentVersionId: created.DocumentVersionID, SourceRoomId: &sourceRoomID,
			Filename: upload.Filename, MediaType: upload.MediaType, SizeBytes: upload.SizeBytes,
			Sha256: upload.SHA256, Available: true,
		})
	}
	return content, prepared, nil
}

// attachMessageContent prepares a Human Message's attachments, binds their
// Documents to the collaboration Room and returns the Message's segments and
// attachments. The caller has locked the Room's delivery row; uploads lock
// here and create new Documents.
func (s *Service) attachMessageContent(
	ctx context.Context, tx pgx.Tx, queries *store.Queries, room store.Room, actor store.Actor,
	accountID, collaborationRoomID, key, messageID string, content MessageContent,
) (MessageContent, []messagecreation.Segment, []messagecreation.Attachment, error) {
	content, preparedAttachments, err := s.prepareMessageAttachments(ctx, tx, queries, room, actor, messageID, content)
	if err != nil {
		return MessageContent{}, nil, nil, err
	}
	documentIDs, err := messageDocumentIDs(content)
	if err != nil {
		return MessageContent{}, nil, nil, ErrInvalidDocumentReference
	}
	if _, err := document.EnsureRoomBindingsInTransaction(ctx, tx,
		document.EnsureRoomBindingsInTransactionInput{
			AccountID: accountID, TenantID: room.TenantID, RoomID: collaborationRoomID,
			InitiatedByActorID: actor.ID, IdempotencyKey: key, Role: "manager",
			DocumentIDs: documentIDs,
		}); err != nil {
		if errors.Is(err, document.ErrNotFound) || errors.Is(err, document.ErrVersionConflict) {
			return MessageContent{}, nil, nil, ErrInvalidDocumentReference
		}
		return MessageContent{}, nil, nil, err
	}
	var segments []messagecreation.Segment
	if err := json.Unmarshal(content.encoded, &segments); err != nil {
		return MessageContent{}, nil, nil, err
	}
	attachments := make([]messagecreation.Attachment, 0, len(preparedAttachments))
	for _, prepared := range preparedAttachments {
		attachments = append(attachments, messagecreation.Attachment{
			ID: prepared.Id, DocumentID: prepared.DocumentId,
			DocumentVersionID: prepared.DocumentVersionId, SourceRoomID: optionalStringValue(prepared.SourceRoomId),
			Filename: prepared.Filename, MediaType: prepared.MediaType,
			SizeBytes: prepared.SizeBytes, SHA256: prepared.Sha256, Available: prepared.Available,
		})
	}
	return content, segments, attachments, nil
}

// WriteOnboardingHandoff is the typedcard OnboardingHandoffWriter: the hidden
// Message that wakes AnotherMe once its setup cards are answered, carrying the
// sources card's uploads with the same rules as an ordinary Human Message, in
// the decision's transaction. Lock order: the decision holds the idempotency
// key, Tenant membership, Room membership, the Interaction and card rows and
// the Room's delivery row; the uploads lock in prepareMessageAttachments,
// after the Room as in createMessageTx, and their Documents are new, so no
// existing Document lock (document.Lock) is taken.
func (s *Service) WriteOnboardingHandoff(ctx context.Context, tx pgx.Tx, queries *store.Queries, handoff typedcard.OnboardingHandoff) (messagecreation.Persisted, error) {
	var segment httpapi.MessageSegment
	if err := segment.FromTextSegment(httpapi.TextSegment{Type: "text", Content: handoff.Text}); err != nil {
		return messagecreation.Persisted{}, err
	}
	request := httpapi.MessageCreateRequest{RawMessage: handoff.Text, Segments: []httpapi.MessageSegment{segment}}
	if len(handoff.AttachmentUploadIDs) > 0 {
		request.AttachmentUploadIds = &handoff.AttachmentUploadIDs
	}
	content, err := NormalizeMessageCreateRequest(request)
	if err != nil {
		return messagecreation.Persisted{}, typedcard.ErrInvalid
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: handoff.RoomID, AccountID: textValue(handoff.AccountID)})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	messageID := idgen.New("message")
	_, _, attachments, err := s.attachMessageContent(ctx, tx, queries, room, handoff.Human,
		handoff.AccountID, room.ID, handoff.IdempotencyKey, messageID, content)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	return messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		ID: messageID, TenantID: handoff.TenantID, RoomID: room.ID, Author: handoff.Human,
		CardContextMessageID: handoff.CardMessageID, Attachments: attachments,
	}, handoff.Agent, " "+handoff.Text)
}

func messageAttachmentRepresentationFormat(filename, mediaType string) string {
	lowerFilename := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lowerFilename, ".md") || strings.HasSuffix(lowerFilename, ".markdown"):
		return "markdown"
	case strings.HasSuffix(lowerFilename, ".html") || strings.HasSuffix(lowerFilename, ".htm"):
		return "html"
	case strings.HasPrefix(strings.ToLower(mediaType), "text/"):
		return "plain_text"
	case strings.EqualFold(mediaType, "application/pdf"):
		return "pdf"
	default:
		return "binary"
	}
}

// NormalizeMessageAttachmentMediaType maps legacy Markdown media types to text/markdown.
func NormalizeMessageAttachmentMediaType(filename, mediaType string) string {
	normalized, _, err := mime.ParseMediaType(mediaType)
	if err != nil {
		return mediaType
	}
	extension := strings.ToLower(filepath.Ext(filename))
	if (extension == ".md" || extension == ".markdown") &&
		(strings.EqualFold(normalized, "text/x-markdown") ||
			strings.EqualFold(normalized, "application/x-markdown")) {
		return "text/markdown"
	}
	return mediaType
}
