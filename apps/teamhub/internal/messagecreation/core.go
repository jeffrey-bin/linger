// Package messagecreation is the shared Message write path: it validates,
// persists and publishes Messages, and writes the card changes and room
// notices that are announced as Messages.
package messagecreation

import (
	"context"
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// ErrInvalidContext rejects context Messages that are not committed Messages
// of the same Room or exceed the quoted text budget.
var ErrInvalidContext = errors.New("message context is invalid")

const maxContextCharacters = 100000

// AttachmentRule names how Document Version attachments must line up with the
// file and Document card segments of a Draft.
type AttachmentRule int

const (
	// FileAttachments pairs every attachment with one file or Document card
	// segment, at most 5.
	FileAttachments AttachmentRule = iota
	// DocumentCardAttachments pairs every file segment with an attachment and
	// lets a Document card segment show its live Document without one, at most 5.
	DocumentCardAttachments
	// PreparedAttachments accepts CLI resources: HTML fragment and SVG
	// attachments may have no file segment and stay out of the payload, at
	// most 1000.
	PreparedAttachments
)

// Draft is one Message as its writer describes it. Fields left zero keep the
// defaults: a random ID, a conversation Message, mention signals on and no
// attachments.
type Draft struct {
	// ID names a Message its writer must create at most once.
	ID       string
	TenantID string
	RoomID   string
	Author   store.Actor
	Content  Content
	// Kind is conversation, agent_runtime, task_terminal_notice or room_notice.
	Kind                 string
	ReplyToMessageID     string
	CardContextMessageID string
	// ContextMessageIDs quote earlier Messages of the same Room.
	ContextMessageIDs []string
	// AttachmentVersionIDs are resolved among the Document Versions bound to
	// AttachmentRoomID, which defaults to RoomID, and checked by AttachmentRule.
	AttachmentVersionIDs []string
	AttachmentRoomID     string
	AttachmentRule       AttachmentRule
	// Attachments are already resolved and checked by the writer.
	Attachments []Attachment
	// Validated reports that the writer checked Content by its own rules: the
	// Human front by the public Message contract and its skills before it
	// admits mentioned Actors, a handoff by its own text bounds. Persist then
	// skips the Agent input limits of Normalize and the skill check.
	Validated bool
	// Mentions, when set, are the targets of the reference segments as the
	// writer resolved them: the Human front admits them itself, and a handoff
	// names the Agent it wakes by its card's authority. Unset, the references
	// must name current members of the collaboration Room.
	Mentions []store.Actor
	// SuppressMentionSignals keeps a conversation's mentions from waking or
	// obliging anyone.
	SuppressMentionSignals bool
	Card                   *Card
	// CardTitle presents a conversation Message as a light card with this
	// title (teamhub message card); empty for an ordinary Message.
	CardTitle string
	// CardKind names what the light card is, only "profile" (the Human's
	// Personal Profile delivery); empty for any other card or Message.
	CardKind string
	// FiredRoutine is the Routine whose fire this agent_runtime wake is; only
	// the Routine scheduler sets it.
	FiredRoutine *FiredRoutine
	// TrustedRunID is the Local Run a writer knows wrote the Message: a runtime
	// callback, a delayed bubble or a published directory. Without it, the Run
	// an Agent request names in its header is checked by ResolveRunClaim.
	TrustedRunID string
	// Notice is the structured line a room_notice Message announces, and is
	// set exactly for that kind. A notice has no card, relation or attachment.
	Notice json.RawMessage
}

// FiredRoutine is the Routine a wake came from and the instruction it fired,
// recorded on the Message so readers never parse the wake's text.
type FiredRoutine struct {
	ID          string
	Instruction string
}

// Card is the typed card row a card Message carries. The writer records the
// card's owner row after Persist and projects the card into Persisted.Card.
type Card struct {
	WorkItemID           string
	DecisionOwnerActorID string
	CardType             string
	Intent               string
}

// Persisted is a stored Message that Publish has not announced yet.
type Persisted struct {
	Message Message
	// Card is the projected card that message.created carries.
	Card json.RawMessage
	// AfterEvent runs right after message.created and returns the Room
	// sequence the author has read through; the Human front records a Task
	// Room input there.
	AfterEvent func(ctx context.Context, roomSeq int64) (int64, error)

	tenantID               string
	thread                 *store.GetThreadRoomByRoomIDRow
	body                   string
	segments               json.RawMessage
	attachments            []Attachment
	contexts               []contextMessage
	mentionIDs             []string
	suppressMentionSignals bool
	cardContextMessageID   string
	notice                 json.RawMessage
	cardTitle              string
	cardKind               string
}

// Create persists and publishes one Message in the caller's transaction.
func Create(ctx context.Context, queries *store.Queries, draft Draft) (Result, error) {
	persisted, err := Persist(ctx, queries, draft)
	if err != nil {
		return Result{}, err
	}
	return Publish(ctx, queries, persisted)
}

// Persist checks a Draft and writes the Message row, which carries its
// attachments, reply target and context Messages, and its card row. It
// allocates no Room sequence; Publish announces the Message.
func Persist(ctx context.Context, queries *store.Queries, draft Draft) (Persisted, error) {
	kind := draft.Kind
	if kind == "" {
		kind = "conversation"
	}
	if draft.TenantID == "" || draft.RoomID == "" || draft.Author.TenantID != draft.TenantID ||
		kind != "conversation" && kind != "agent_runtime" && kind != "task_terminal_notice" && kind != "room_notice" ||
		!validCardTitle(draft.CardTitle, kind) || draft.CardKind != "" && (draft.CardKind != "profile" || draft.CardTitle == "") ||
		draft.FiredRoutine != nil && (kind != "agent_runtime" || draft.FiredRoutine.ID == "" || draft.FiredRoutine.Instruction == "") {
		return Persisted{}, ErrInvalid
	}
	var firedRoutineID, firedRoutineInstruction pgtype.Text
	if draft.FiredRoutine != nil {
		firedRoutineID = pgtype.Text{String: draft.FiredRoutine.ID, Valid: true}
		firedRoutineInstruction = pgtype.Text{String: draft.FiredRoutine.Instruction, Valid: true}
	}
	if (kind == "room_notice") != (len(draft.Notice) > 0) || kind == "room_notice" &&
		(draft.Card != nil || draft.ReplyToMessageID != "" || draft.CardContextMessageID != "" ||
			len(draft.ContextMessageIDs) > 0 || len(draft.AttachmentVersionIDs) > 0 || len(draft.Attachments) > 0) {
		return Persisted{}, ErrInvalid
	}
	content := draft.Content
	if !draft.Validated {
		normalized, err := Normalize(content.Segments)
		if err != nil || normalized.RawMessage != content.RawMessage {
			return Persisted{}, ErrInvalid
		}
		content = normalized
	}
	thread, err := queries.GetThreadRoomByRoomID(ctx, draft.RoomID)
	var threadRoom *store.GetThreadRoomByRoomIDRow
	collaborationRoomID := draft.RoomID
	switch {
	case err == nil:
		threadRoom, collaborationRoomID = &thread, thread.ParentRoomID
	case !errors.Is(err, pgx.ErrNoRows):
		return Persisted{}, err
	}
	attachments, visible, err := draftAttachments(ctx, queries, draft, content)
	if err != nil {
		return Persisted{}, err
	}
	mentions := draft.Mentions
	if mentions == nil {
		mentions, err = resolveMentions(ctx, queries, draft.RoomID, content.Segments)
		if err != nil {
			return Persisted{}, err
		}
	} else if !mentionsMatch(content.Segments, mentions) {
		return Persisted{}, ErrInvalidReference
	}
	// A Thread has no members of its own; its skills belong to the parent Room.
	if !draft.Validated {
		if err := ValidateSkills(ctx, queries, draft.TenantID, collaborationRoomID, content.Segments); err != nil {
			return Persisted{}, err
		}
	}
	segments, err := json.Marshal(content.Segments)
	if err != nil {
		return Persisted{}, err
	}
	messageID := draft.ID
	if messageID == "" {
		messageID = idgen.New("message")
	}
	localRunID, err := messageRun(ctx, queries, draft)
	if err != nil {
		return Persisted{}, err
	}
	contexts, contextMessageIDs, err := resolveContexts(ctx, queries, draft.RoomID, draft.ContextMessageIDs)
	if err != nil {
		return Persisted{}, err
	}
	storedAttachments, err := encodeAttachments(attachments)
	if err != nil {
		return Persisted{}, err
	}
	message, err := queries.CreateMessage(ctx, store.CreateMessageParams{
		ID: messageID, TenantID: draft.TenantID, RoomID: draft.RoomID,
		AuthorActorID: draft.Author.ID, Body: content.RawMessage, Segments: segments,
		CardContextMessageID: pgtype.Text{String: draft.CardContextMessageID, Valid: draft.CardContextMessageID != ""},
		MessageKind:          kind, LocalRunID: localRunID,
		Notice:                  draft.Notice,
		CardTitle:               pgtype.Text{String: draft.CardTitle, Valid: draft.CardTitle != ""},
		CardKind:                pgtype.Text{String: draft.CardKind, Valid: draft.CardKind != ""},
		ReplyToMessageID:        pgtype.Text{String: draft.ReplyToMessageID, Valid: draft.ReplyToMessageID != ""},
		ContextMessageIds:       contextMessageIDs,
		Attachments:             storedAttachments,
		FiredRoutineID:          firedRoutineID,
		FiredRoutineInstruction: firedRoutineInstruction,
	})
	if err != nil {
		return Persisted{}, err
	}
	if draft.Card != nil {
		if err := queries.CreateMessageCard(ctx, store.CreateMessageCardParams{
			MessageID: message.ID, TenantID: draft.TenantID, RoomID: draft.RoomID,
			WorkItemID:           pgtype.Text{String: draft.Card.WorkItemID, Valid: draft.Card.WorkItemID != ""},
			DecisionOwnerActorID: draft.Card.DecisionOwnerActorID,
			CardType:             draft.Card.CardType, Intent: draft.Card.Intent,
		}); err != nil {
			return Persisted{}, err
		}
	}
	mentionIDs := make([]string, 0, len(mentions))
	for _, target := range mentions {
		mentionIDs = append(mentionIDs, target.ID)
	}
	return Persisted{
		Message: Message{
			ID: message.ID, RoomID: message.RoomID, Author: draft.Author, MessageKind: kind,
			RawMessage: message.Body, Segments: append([]Segment(nil), content.Segments...),
			CreatedAt: message.CreatedAt.Time, ReplyToMessageID: draft.ReplyToMessageID,
			LocalRunID: message.LocalRunID.String,
		},
		tenantID: draft.TenantID, thread: threadRoom, body: message.Body, segments: segments,
		attachments: visible, contexts: contexts, mentionIDs: mentionIDs,
		suppressMentionSignals: draft.SuppressMentionSignals, cardContextMessageID: draft.CardContextMessageID,
		notice:    draft.Notice,
		cardTitle: draft.CardTitle,
		cardKind:  draft.CardKind,
	}, nil
}

// Publish announces a persisted Message: it appends message.created and stamps
// the Message with that Room sequence and its mentions, advances the author's
// read state or Thread visibility and updates the parent Room's Thread summary.
// The Room Event itself wakes every browser stream. A Thread locks its own and
// its parent Room in id order before either sequence moves.
func Publish(ctx context.Context, queries *store.Queries, message Persisted) (Result, error) {
	roomID, author := message.Message.RoomID, message.Message.Author
	if message.thread != nil {
		if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{
			TenantID: message.tenantID, RoomIds: []string{roomID, message.thread.ParentRoomID},
		}); err != nil {
			return Result{}, err
		}
	}
	payload, err := json.Marshal(message.payload())
	if err != nil {
		return Result{}, err
	}
	kind := message.Message.MessageKind
	mentioned := []string{}
	if kind == "agent_runtime" || kind == "conversation" && !message.suppressMentionSignals {
		mentioned = message.mentionIDs
	}
	roomSeq, err := roomevent.AppendMessageCreated(ctx, queries, roomevent.Input{
		TenantID: message.tenantID, RoomID: roomID,
		ActorID: author.ID, ResourceID: message.Message.ID,
		Payload: map[string]any{"kind": "message.created", "message": json.RawMessage(payload)},
	}, mentioned)
	if err != nil {
		return Result{}, err
	}
	result := Result{Message: message.Message, RoomSeq: roomSeq, Payload: payload}
	if kind != "conversation" {
		return result, nil
	}
	readThrough := roomSeq
	if message.AfterEvent != nil {
		if readThrough, err = message.AfterEvent(ctx, roomSeq); err != nil {
			return Result{}, err
		}
	}
	if message.thread != nil {
		mentionIDs := message.mentionIDs
		if message.suppressMentionSignals {
			mentionIDs = nil
		}
		if err := recordThreadReadState(ctx, queries, *message.thread, author.ID, roomSeq, readThrough, mentionIDs); err != nil {
			return Result{}, err
		}
		if err := appendThreadSummary(ctx, queries, *message.thread, author.ID); err != nil {
			return Result{}, err
		}
	} else if author.Kind == "human" {
		if _, err := queries.AdvanceRoomMemberReadState(ctx, store.AdvanceRoomMemberReadStateParams{
			RoomID: roomID, ActorID: author.ID, ReadThroughRoomSeq: readThrough,
		}); err != nil {
			return Result{}, err
		}
	}
	return result, nil
}

// payloadMessage is the one message.created Message shape. Relations appear
// only when set, and a card Message carries its card.
type payloadMessage struct {
	ID                   string           `json:"id"`
	TenantID             string           `json:"tenant_id"`
	RoomID               string           `json:"room_id"`
	Author               actorRef         `json:"author"`
	MessageKind          string           `json:"message_kind"`
	RawMessage           string           `json:"raw_message"`
	Segments             json.RawMessage  `json:"segments"`
	Attachments          []Attachment     `json:"attachments"`
	ContextMessages      []contextMessage `json:"context_messages,omitempty"`
	ReplyToMessageID     string           `json:"reply_to_message_id,omitempty"`
	CardContextMessageID string           `json:"card_context_message_id,omitempty"`
	Card                 json.RawMessage  `json:"card,omitempty"`
	Notice               json.RawMessage  `json:"notice,omitempty"`
	CardTitle            string           `json:"card_title,omitempty"`
	CardKind             string           `json:"card_kind,omitempty"`
	CreatedAt            time.Time        `json:"created_at"`
}

type contextMessage struct {
	MessageID  string          `json:"message_id"`
	Author     actorRef        `json:"author"`
	RawMessage string          `json:"raw_message"`
	Segments   json.RawMessage `json:"segments"`
	CreatedAt  time.Time       `json:"created_at"`
}

func (message Persisted) payload() payloadMessage {
	author := message.Message.Author
	attachments := message.attachments
	if attachments == nil {
		attachments = []Attachment{}
	}
	return payloadMessage{
		ID: message.Message.ID, TenantID: message.tenantID, RoomID: message.Message.RoomID,
		Author:      actorRef{ID: author.ID, TenantID: author.TenantID, Kind: author.Kind, DisplayName: author.DisplayName},
		MessageKind: message.Message.MessageKind, RawMessage: message.body,
		Segments: message.segments, Attachments: attachments, ContextMessages: message.contexts,
		ReplyToMessageID: message.Message.ReplyToMessageID, CardContextMessageID: message.cardContextMessageID,
		Card: message.Card, Notice: message.notice, CardTitle: message.cardTitle, CardKind: message.cardKind, CreatedAt: message.Message.CreatedAt,
	}
}

func draftAttachments(ctx context.Context, queries *store.Queries, draft Draft, content Content) ([]Attachment, []Attachment, error) {
	if len(draft.Attachments) > 0 {
		if len(draft.AttachmentVersionIDs) > 0 {
			return nil, nil, ErrInvalid
		}
		return draft.Attachments, draft.Attachments, nil
	}
	maxAttachments := maxMessageAttachments
	if draft.AttachmentRule == PreparedAttachments {
		maxAttachments = 1000
	}
	if len(draft.AttachmentVersionIDs) > maxAttachments {
		return nil, nil, ErrInvalid
	}
	roomID := draft.AttachmentRoomID
	if roomID == "" {
		roomID = draft.RoomID
	}
	attachments := make([]Attachment, 0, len(draft.AttachmentVersionIDs))
	if len(draft.AttachmentVersionIDs) > 0 {
		versions, err := queries.GetMessageAttachmentDocumentVersions(ctx, store.GetMessageAttachmentDocumentVersionsParams{
			Ids: draft.AttachmentVersionIDs, TenantID: draft.TenantID, RoomID: roomID,
		})
		if err != nil {
			return nil, nil, err
		}
		if len(versions) != len(draft.AttachmentVersionIDs) {
			return nil, nil, ErrInvalidDocument
		}
		for index, version := range versions {
			if version.ID != draft.AttachmentVersionIDs[index] {
				return nil, nil, ErrInvalidDocument
			}
			attachments = append(attachments, Attachment{
				ID: idgen.New("message_attachment"), DocumentID: version.DocumentID,
				DocumentVersionID: version.ID, SourceRoomID: version.SourceRoomID.String,
				Filename: version.Filename, MediaType: version.MediaType,
				SizeBytes: version.SizeBytes, SHA256: version.Sha256, Available: true,
			})
		}
	}
	var err error
	switch draft.AttachmentRule {
	case DocumentCardAttachments:
		attachments, err = normalizeAttachmentsWithLiveDocumentCards(content.Segments, attachments, maxAttachments)
	case PreparedAttachments:
		if attachments, err = normalizePreparedAttachments(content.Segments, attachments); err == nil {
			return attachments, preparedVisibleAttachments(content.Segments, attachments), nil
		}
	default:
		attachments, err = normalizeAttachments(content.Segments, attachments, maxAttachments)
	}
	return attachments, attachments, err
}

// mentionsMatch checks writer-resolved mentions against the reference
// segments: each named Actor once, with the kind the segment names.
func mentionsMatch(segments []Segment, mentions []store.Actor) bool {
	expected := map[string]string{}
	for _, segment := range segments {
		if segment.Type != "reference" {
			continue
		}
		kind := "human"
		if segment.TargetType == "agent" {
			kind = "agent"
		}
		if current, found := expected[segment.Target]; found && current != kind {
			return false
		}
		expected[segment.Target] = kind
	}
	if len(expected) != len(mentions) {
		return false
	}
	for _, target := range mentions {
		if expected[target.ID] != target.Kind {
			return false
		}
	}
	return true
}

// resolveContexts checks the quoted Messages before the Message exists: each
// a committed Message of the same Room, in the caller's order, within the
// quoted text budget. It returns their payloads and IDs.
func resolveContexts(ctx context.Context, queries *store.Queries, roomID string, contextMessageIDs []string) ([]contextMessage, []string, error) {
	if len(contextMessageIDs) == 0 {
		return nil, []string{}, nil
	}
	rows, err := queries.ListMessageContextsForCreate(ctx, store.ListMessageContextsForCreateParams{
		RoomID: roomID, ContextMessageIds: contextMessageIDs,
	})
	if err != nil {
		return nil, nil, err
	}
	// Unknown, other-Room and repeated IDs return fewer rows.
	if len(rows) != len(contextMessageIDs) {
		return nil, nil, ErrInvalidContext
	}
	contexts := make([]contextMessage, 0, len(rows))
	ids := make([]string, 0, len(rows))
	characters := 0
	for _, row := range rows {
		characters += utf8.RuneCountInString(row.Body)
		if characters > maxContextCharacters {
			return nil, nil, ErrInvalidContext
		}
		ids = append(ids, row.ContextMessageID)
		contexts = append(contexts, contextMessage{
			MessageID: row.ContextMessageID, RawMessage: row.Body, Segments: row.Segments,
			Author: actorRef{
				ID: row.AuthorActorID, TenantID: row.AuthorTenantID,
				Kind: row.AuthorKind, DisplayName: row.AuthorDisplayName,
			},
			CreatedAt: row.CreatedAt.Time,
		})
	}
	return contexts, ids, nil
}

// storedAttachment is one element of messages.attachments; the array order is
// the attachment order.
type storedAttachment struct {
	ID                string `json:"id"`
	DocumentID        string `json:"document_id"`
	DocumentVersionID string `json:"document_version_id"`
}

func encodeAttachments(attachments []Attachment) ([]byte, error) {
	stored := make([]storedAttachment, 0, len(attachments))
	for _, attachment := range attachments {
		stored = append(stored, storedAttachment{
			ID: attachment.ID, DocumentID: attachment.DocumentID, DocumentVersionID: attachment.DocumentVersionID,
		})
	}
	return json.Marshal(stored)
}

// appendThreadSummary refreshes the parent Room's view of a Thread after any
// Thread conversation Message, Human or Agent.
func appendThreadSummary(ctx context.Context, queries *store.Queries, thread store.GetThreadRoomByRoomIDRow, actorID string) error {
	stats, err := queries.GetThreadReplyStats(ctx, thread.RoomID)
	if err != nil {
		return err
	}
	authors, err := queries.ListLatestThreadReplyAuthors(ctx, thread.RoomID)
	if err != nil {
		return err
	}
	summary := httpapi.MessageThreadSummary{RoomId: thread.RoomID, ReplyCount: stats.ReplyCount}
	switch latest := stats.LatestReplyAt.(type) {
	case time.Time:
		summary.LatestReplyAt = &latest
	case pgtype.Timestamptz:
		if latest.Valid {
			summary.LatestReplyAt = &latest.Time
		}
	}
	if len(authors) > 0 {
		refs := make([]httpapi.ActorRef, 0, len(authors))
		for _, author := range authors {
			refs = append(refs, httpapi.ActorRef{
				Id: author.ID, TenantId: author.TenantID,
				Kind: httpapi.ActorKind(author.Kind), DisplayName: author.DisplayName,
			})
		}
		summary.LatestReplyAuthors = &refs
	}
	_, err = roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: thread.TenantID, RoomID: thread.ParentRoomID, EventType: "message.thread_summary.updated",
		ActorID: actorID, ResourceID: thread.RootMessageID,
		Payload: map[string]any{
			"kind": "message.thread_summary.updated", "message_id": thread.RootMessageID, "thread": summary,
		},
	})
	return err
}

// recordThreadReadState records Thread read state; the published Message and
// its mentions already list the author and the mentioned Actors. The author
// has read through readThrough; a mentioned Actor starts just before this
// Message so it reads as unread.
func recordThreadReadState(
	ctx context.Context,
	queries *store.Queries,
	thread store.GetThreadRoomByRoomIDRow,
	authorActorID string,
	messageSeq, readThrough int64,
	mentionActorIDs []string,
) error {
	if _, err := queries.AdvanceRoomMemberReadState(ctx, store.AdvanceRoomMemberReadStateParams{
		RoomID: thread.RoomID, ActorID: authorActorID, ReadThroughRoomSeq: readThrough,
	}); err != nil {
		return err
	}
	mentionReadThrough := max(messageSeq-1, 0)
	seen := map[string]struct{}{authorActorID: {}}
	for _, actorID := range mentionActorIDs {
		if _, duplicate := seen[actorID]; duplicate || actorID == "" {
			continue
		}
		seen[actorID] = struct{}{}
		if err := queries.CreateRoomMemberState(ctx, store.CreateRoomMemberStateParams{
			RoomID: thread.RoomID, ActorID: actorID, ReadThroughRoomSeq: mentionReadThrough,
		}); err != nil {
			return err
		}
	}
	return nil
}
