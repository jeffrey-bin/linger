package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrInvalidMessageContext reports context Messages that are not distinct committed Messages of the Room.
var ErrInvalidMessageContext = errors.New("message context is invalid")

func forwardMessageIdempotencyKey(key, sourceMessageID, targetRoomID string) string {
	digest := sha256.Sum256([]byte(key + "\x00" + sourceMessageID + "\x00" + targetRoomID))
	return "forward_" + hex.EncodeToString(digest[:])
}

// CreateMessage commits a Human Message with its mentions, attachments and Room Event idempotently.
func (s *Service) CreateMessage(ctx context.Context, accountID, roomID string, request httpapi.MessageCreateRequest, content MessageContent, key string) (idempotency.Result, error) {
	operation := "createMessage:" + roomID
	requestHash := idempotency.HashRequest(request)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, err
	}
	defer tx.Rollback(ctx)
	if err := idempotency.Lock(ctx, tx, idempotency.AccountKey(accountID, operation, key)); err != nil {
		return idempotency.Result{}, err
	}
	queries := s.queries.WithTx(tx)
	tenantID, err := queries.GetRoomTenantID(ctx, roomID)
	if err != nil {
		return idempotency.Result{}, err
	}
	// A Thread has no members of its own: it collaborates in its parent Room.
	collaborationRoomID, _, err := mentionMembershipRoom(ctx, queries, roomID)
	if err != nil {
		return idempotency.Result{}, err
	}
	if err := roomcreation.LockMemberships(ctx, queries, roomID, collaborationRoomID); err != nil {
		return idempotency.Result{}, err
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, err
	}
	if room.TenantID != tenantID {
		return idempotency.Result{}, pgx.ErrNoRows
	}
	if !roomParticipationAllowed(ctx, queries, accountID, roomID) {
		return idempotency.Result{}, ErrRoomParticipationLeft
	}
	peerActive, err := queries.DirectRoomPeerIsActive(ctx, room.ID)
	if err != nil {
		return idempotency.Result{}, err
	}
	if !peerActive {
		return idempotency.Result{}, ErrDirectRoomPeerInactive
	}
	actor, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, err
	}
	if replay, found, err := idempotency.Replay(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash); err != nil {
		return idempotency.Result{}, err
	} else if found {
		return replay, tx.Commit(ctx)
	}
	// A managed Task is always locked before this transaction can allocate a
	// Room sequence (mention admission, attachment publication, or Message).
	// Task workers use the same Task -> Room order for execution projections.
	taskInputTarget, err := taskexecution.LockHumanTaskRoomInputTarget(ctx, queries, room.TenantID, room.ID)
	if err != nil {
		return idempotency.Result{}, err
	}
	// Canonical order: Room memberships of the Actors this Message names, then
	// the Room, then every existing Document this Message references or
	// attaches. Upload attachments create new Documents in this
	// transaction and need no lock. A not-yet-member mention admission creates
	// its membership later in this transaction and needs no prelock.
	memberTargets, err := messageMemberTargets(content)
	if err != nil {
		return idempotency.Result{}, err
	}
	missingMembers, err := messagecreation.LockMessageMembers(ctx, queries, collaborationRoomID, memberTargets)
	if err != nil {
		return idempotency.Result{}, err
	}
	// A mention admits each missing Agent, which takes its Agent lock after the
	// Room locks above. Existing members need none.
	if err := tenantmembership.LockAgents(ctx, queries, missingMembers...); err != nil {
		return idempotency.Result{}, err
	}
	// Admission of a missing Agent member rebinds its per-room meta Context, so
	// Contexts lock before the rooms lock below. Existing members take no Context lock.
	if err := agentruntimestate.LockRoomMembershipContexts(ctx, queries, missingMembers, []string{collaborationRoomID}); err != nil {
		return idempotency.Result{}, err
	}
	// A Thread Message also writes its parent's Thread summary, so both Rooms
	// lock here, in id order.
	if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{
		TenantID: room.TenantID, RoomIds: []string{room.ID, collaborationRoomID},
	}); err != nil {
		return idempotency.Result{}, err
	}
	existingDocumentIDs, err := messageDocumentIDs(content)
	if err != nil {
		return idempotency.Result{}, ErrInvalidDocumentReference
	}
	if len(content.contextDocumentVersionIDs) > 0 {
		if !actor.AccountID.Valid {
			return idempotency.Result{}, ErrInvalidMessageAttachment
		}
		contextVersions, err := queries.GetAuthorizedMessageContextDocumentVersions(ctx, store.GetAuthorizedMessageContextDocumentVersionsParams{
			Ids: content.contextDocumentVersionIDs, TenantID: room.TenantID, AccountID: actor.AccountID.String,
		})
		if err != nil {
			return idempotency.Result{}, err
		}
		for _, version := range contextVersions {
			existingDocumentIDs = append(existingDocumentIDs, version.DocumentID)
		}
	}
	if err := document.Lock(ctx, tx, existingDocumentIDs); err != nil {
		return idempotency.Result{}, err
	}
	if err := validateMessageSkills(ctx, queries, room.TenantID, collaborationRoomID, content); err != nil {
		return idempotency.Result{}, err
	}
	mentionTargets, err := resolveAndAdmitMessageMentions(ctx, queries, room.TenantID, room.ID, actor, content)
	if err != nil {
		return idempotency.Result{}, err
	}
	messageID := idgen.New("message")
	preparationDocumentIDs, err := messageDocumentIDs(content)
	if err != nil {
		return idempotency.Result{}, ErrInvalidDocumentReference
	}
	if _, err := document.EnsureRoomBindingsInTransaction(ctx, tx,
		document.EnsureRoomBindingsInTransactionInput{
			AccountID: accountID, TenantID: room.TenantID, RoomID: collaborationRoomID,
			InitiatedByActorID: actor.ID, IdempotencyKey: key, Role: "manager",
			DocumentIDs: preparationDocumentIDs,
		}); err != nil {
		if errors.Is(err, document.ErrNotFound) || errors.Is(err, document.ErrVersionConflict) {
			return idempotency.Result{}, ErrInvalidDocumentReference
		}
		return idempotency.Result{}, err
	}
	content, segments, attachments, err := s.attachMessageContent(ctx, tx, queries, room, actor, accountID, collaborationRoomID, key, messageID, content)
	if err != nil {
		return idempotency.Result{}, err
	}
	// The Human front checked the content against the Message contract and its
	// skills, and admitted the mentioned Actors above.
	message, err := messagecreation.Persist(ctx, queries, messagecreation.Draft{
		ID: messageID, TenantID: room.TenantID, RoomID: room.ID, Author: actor,
		Content:           messagecreation.Content{RawMessage: content.rawMessage, Segments: segments},
		ContextMessageIDs: content.contextMessageIDs, Attachments: attachments,
		Validated: true, Mentions: mentionTargets, SuppressMentionSignals: content.voiceLiveTurn != nil,
	})
	switch {
	case errors.Is(err, messagecreation.ErrInvalidContext):
		return idempotency.Result{}, ErrInvalidMessageContext
	case errors.Is(err, messagecreation.ErrInvalidReference):
		return idempotency.Result{}, ErrInvalidMention
	case err != nil:
		return idempotency.Result{}, err
	}
	if turn := content.voiceLiveTurn; turn != nil {
		if err := voicelive.RecordHumanTurn(ctx, queries, actor.ID, room.ID, turn.VoiceSessionId, turn.TurnId, message.Message.ID); err != nil {
			return idempotency.Result{}, err
		}
	}
	message.AfterEvent = func(ctx context.Context, roomSeq int64) (int64, error) {
		segments, err := json.Marshal(message.Message.Segments)
		if err != nil {
			return 0, err
		}
		promotion, err := taskexecution.PromoteLockedHumanTaskRoomMessage(ctx, queries, taskInputTarget, taskexecution.HumanTaskRoomMessageInput{
			TenantID: room.TenantID, RoomID: room.ID, AuthorActorID: actor.ID,
			MessageKind: message.Message.MessageKind,
			Message: taskexecution.TurnMessageInput{
				MessageID: message.Message.ID, RawMessage: message.Message.RawMessage, Segments: segments,
				Author: &taskexecution.TurnMessageAuthor{
					ActorID: actor.ID, Kind: actor.Kind, DisplayName: actor.DisplayName,
				},
			},
		})
		if err != nil || !promotion.Promoted {
			return roomSeq, err
		}
		return promotion.RoomSeq, nil
	}
	// AnotherMe reads its setup status just ahead of the Human's first own
	// Message while setup is open. A Live voice turn wakes no one, so it
	// leaves the status to the next typed Message.
	if s.typedCards != nil && content.voiceLiveTurn == nil {
		status, found, err := s.typedCards.OnboardingProgressTx(ctx, tx, queries, room, actor)
		if err != nil {
			return idempotency.Result{}, err
		}
		if found {
			if _, err := messagecreation.Publish(ctx, queries, status); err != nil {
				return idempotency.Result{}, err
			}
		}
	}
	published, err := messagecreation.Publish(ctx, queries, message)
	if err != nil {
		return idempotency.Result{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, operation, key), requestHash, idempotency.Record{ResourceID: message.Message.ID, Status: http.StatusCreated, Body: published.Payload}); err != nil {
		return idempotency.Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return idempotency.Result{}, err
	}
	return idempotency.Result{Status: http.StatusCreated, Body: published.Payload}, nil
}

func firstMessageID(items []store.ListMessagesForRoomAccountRow) string {
	if len(items) == 0 {
		return ""
	}
	return items[0].ID
}

// ErrInvalidDocumentReference reports a Document reference that is not active in the Message Context.
var ErrInvalidDocumentReference = errors.New("message Document reference is invalid")

// Forward outcomes the caller maps to their own responses.
var (
	ErrForwardSourceNotFound = errors.New("forward source Message was not found")
	ErrForwardTargetNotFound = errors.New("forward target is unavailable")
	ErrForwardTargetInvalid  = errors.New("forward target is invalid")
	ErrForwardNotAllowed     = errors.New("message could not be forwarded")
)

// Forwarded is a forwarded Message with the Room Bindings its Documents have
// in the target Room. Replay marks an idempotent replay.
type Forwarded struct {
	Result httpapi.MessageForwardResult
	Replay bool
}

// ForwardMessage copies a conversation Message into another Room, or into the
// Direct Room with an Agent, as a new Message of the caller.
func (s *Service) ForwardMessage(ctx context.Context, accountID, roomID, messageID string, request httpapi.MessageForwardRequest, idempotencyKey string) (Forwarded, error) {
	source, err := s.queries.GetMessageForAccount(ctx, store.GetMessageForAccountParams{
		ID: messageID, RoomID: roomID, AccountID: textValue(accountID),
	})
	if err != nil || source.MessageKind != "conversation" {
		if errors.Is(err, pgx.ErrNoRows) || err == nil {
			return Forwarded{}, ErrForwardSourceNotFound
		}
		return Forwarded{}, internal("read Forward source Message", err)
	}
	content, err := forwardedMessageContent(source.Body, source.Segments)
	if err != nil {
		return Forwarded{}, internal("decode Forward source Message", err)
	}
	targetRoomID := request.Target.Id
	switch request.Target.Kind {
	case httpapi.MessageForwardTargetKindRoom:
	case httpapi.MessageForwardTargetKindAgent:
		direct, err := s.OpenDirectRoom(ctx, accountID, source.TenantID, targetRoomID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, roomcreation.ErrInvalid) {
				return Forwarded{}, ErrForwardTargetNotFound
			}
			return Forwarded{}, internal("resolve Forward Direct Room", err)
		}
		targetRoomID = direct.Room.Id
	default:
		return Forwarded{}, ErrForwardTargetInvalid
	}
	createRequest := httpapi.MessageCreateRequest{
		RawMessage: content.rawMessage, Segments: content.segments,
	}
	result, err := s.CreateMessage(ctx, accountID, targetRoomID, createRequest, content,
		forwardMessageIdempotencyKey(idempotencyKey, source.ID, targetRoomID))
	if err != nil {
		if errors.Is(err, ErrInvalidDocumentReference) || errors.Is(err, pgx.ErrNoRows) {
			return Forwarded{}, ErrForwardNotAllowed
		}
		return Forwarded{}, err
	}
	var message httpapi.Message
	if err := json.Unmarshal(result.Body, &message); err != nil {
		return Forwarded{}, internal("decode Forward Message result", err)
	}
	documentIDs, err := messageDocumentIDs(content)
	if err != nil {
		return Forwarded{}, internal("decode Forward Document identities", err)
	}
	bindingIDs := make([]httpapi.Id, 0, len(documentIDs))
	for _, documentID := range documentIDs {
		bindingID, err := s.queries.GetActiveRoomDocumentBindingID(ctx, store.GetActiveRoomDocumentBindingIDParams{
			TenantID: source.TenantID, DocumentID: documentID, RoomID: targetRoomID,
		})
		if err != nil {
			return Forwarded{}, internal("read Forward Room Binding", err)
		}
		bindingIDs = append(bindingIDs, bindingID)
	}
	return Forwarded{
		Result: httpapi.MessageForwardResult{RoomId: targetRoomID, Message: message, RoomBindingIds: bindingIDs},
		Replay: result.Replay,
	}, nil
}

// hydrateRoutineMessageNames names the Routine that produced each Agent
// Message, when exactly one did.
func (s *Service) hydrateRoutineMessageNames(ctx context.Context, roomID string, messageIDs []string) (map[string]string, error) {
	names := make(map[string]string)
	if len(messageIDs) == 0 {
		return names, nil
	}
	rows, err := s.queries.ListRoutineMessageNames(ctx, store.ListRoutineMessageNamesParams{RoomID: roomID, MessageIds: messageIDs})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		names[row.MessageID] = row.RoutineName
	}
	return names, nil
}
