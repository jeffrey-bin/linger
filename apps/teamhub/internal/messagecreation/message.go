package messagecreation

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	maxMessageLength         = 50000
	maxHtmlFragmentBytes     = 2 << 20
	maxHtmlFragmentStubRunes = 1024
	maxMessageSegments       = 1000
	maxMessageAttachments    = 5
)

var (
	ErrInvalid          = errors.New("message input is invalid")
	ErrInvalidReference = errors.New("message reference is invalid")
	ErrInvalidDocument  = errors.New("message Document reference is invalid")
	ErrInvalidSkill     = errors.New("message skill target is invalid")
	identifierPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	skillIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
	manifestPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
)

type Segment struct {
	Type               string `json:"type"`
	Content            string `json:"content"`
	Html               string `json:"html,omitempty"`
	Target             string `json:"target,omitempty"`
	TargetType         string `json:"target_type,omitempty"`
	DocumentID         string `json:"document_id,omitempty"`
	DocumentVersionID  string `json:"document_version_id,omitempty"`
	Presentation       string `json:"presentation,omitempty"`
	Filename           string `json:"filename,omitempty"`
	MediaType          string `json:"media_type,omitempty"`
	SkillID            string `json:"skill_id,omitempty"`
	ManifestVersion    string `json:"manifest_version,omitempty"`
	PublicationGroupID string `json:"publication_group_id,omitempty"`
	RootPath           string `json:"root_path,omitempty"`
	FileCount          int    `json:"file_count,omitempty"`
	DirectoryCount     int    `json:"directory_count,omitempty"`
	// TotalBytes is a pointer so an empty tree keeps its required zero.
	TotalBytes             *int64 `json:"total_bytes,omitempty"`
	EntryDocumentID        string `json:"entry_document_id,omitempty"`
	EntryDocumentVersionID string `json:"entry_document_version_id,omitempty"`
}

// ValidDocumentPresentation reports whether a document segment may carry
// presentation. canvas references a Room Document like inline does (it is
// not an attachment); clients render it as a card and open it in the panel.
func ValidDocumentPresentation(presentation string) bool {
	switch presentation {
	case "", "inline", "card", "canvas":
		return true
	}
	return false
}

type skillReference struct {
	Target          string
	ContextTarget   string
	SkillID         string
	ManifestVersion string
}

func ValidateRoomDocumentReferences(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	segments []Segment,
) error {
	for _, documentID := range distinctDocumentIDs(segments) {
		resolved, err := queries.LockRoomDocumentMessageReference(ctx, store.LockRoomDocumentMessageReferenceParams{
			DocumentID: documentID, TenantID: tenantID, RoomID: roomID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidDocument
		}
		if err != nil {
			return err
		}
		if resolved != documentID {
			return ErrInvalidDocument
		}
	}
	return nil
}

func distinctDocumentIDs(segments []Segment) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, segment := range segments {
		if segment.Type != "document" {
			continue
		}
		if _, exists := seen[segment.DocumentID]; exists {
			continue
		}
		seen[segment.DocumentID] = struct{}{}
		result = append(result, segment.DocumentID)
	}
	return result
}

type Content struct {
	Segments   []Segment `json:"message_segments"`
	RawMessage string    `json:"raw_message"`
}

const maxCardTitleRunes = 120

// validCardTitle reports whether a Message of messageKind may carry title as
// its card title. An empty title is an ordinary Message.
func validCardTitle(title, messageKind string) bool {
	if title == "" {
		return true
	}
	return messageKind == "conversation" && strings.TrimSpace(title) == title &&
		utf8.RuneCountInString(title) <= maxCardTitleRunes && !strings.ContainsAny(title, "\r\n")
}

type Result struct {
	Message Message
	// RoomSeq is the Room sequence of message.created.
	RoomSeq int64
	// Payload is the Message as message.created carries it.
	Payload json.RawMessage
}

type Message struct {
	ID               string
	RoomID           string
	Author           store.Actor
	MessageKind      string
	RawMessage       string
	Segments         []Segment
	CreatedAt        time.Time
	ReplyToMessageID string
	// LocalRunID is the Run that wrote the Message, when one is known.
	LocalRunID string
}

type actorRef struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
}

// Attachment is one immutable Document Version a Message carries.
type Attachment struct {
	ID                string `json:"id"`
	DocumentID        string `json:"document_id"`
	DocumentVersionID string `json:"document_version_id"`
	SourceRoomID      string `json:"source_room_id,omitempty"`
	Filename          string `json:"filename"`
	MediaType         string `json:"media_type"`
	SizeBytes         int64  `json:"size_bytes"`
	SHA256            string `json:"sha256"`
	Available         bool   `json:"available"`
}

func Normalize(segments []Segment) (Content, error) {
	return normalizeSegments(segments, validateSegment)
}

// MentionToken is the text of a server-written mention: @ and the display
// name with its spaces joined by underscores.
func MentionToken(displayName string) string {
	name := strings.TrimLeft(strings.TrimSpace(displayName), "@")
	return "@" + strings.Join(strings.Fields(name), "_")
}

// NormalizeFileRequest validates MCP message intent before TeamHub resolves
// every file Document to the current immutable Version in the write transaction.
func NormalizeFileRequest(segments []Segment) (Content, error) {
	return normalizeSegments(segments, validateFileRequestSegment)
}

func normalizeSegments(segments []Segment, validate func(Segment) error) (Content, error) {
	if len(segments) == 0 || len(segments) > maxMessageSegments {
		return Content{}, ErrInvalid
	}
	var raw strings.Builder
	messageLength := 0
	for _, segment := range segments {
		if err := validate(segment); err != nil {
			return Content{}, err
		}
		raw.WriteString(segment.Content)
		messageLength += utf8.RuneCountInString(segment.Content)
		if messageLength > maxMessageLength {
			return Content{}, ErrInvalid
		}
	}
	if strings.TrimSpace(raw.String()) == "" {
		return Content{}, ErrInvalid
	}
	return Content{Segments: append([]Segment(nil), segments...), RawMessage: raw.String()}, nil
}

func ResolveLatestFileVersionsForRoom(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	request Content,
) (Content, error) {
	documentIDs := distinctFileDocumentIDs(request.Segments)
	if len(documentIDs) == 0 {
		return Normalize(request.Segments)
	}
	versions, err := queries.LockCurrentMessageFileDocumentVersions(ctx, store.LockCurrentMessageFileDocumentVersionsParams{
		RoomID: roomID, DocumentIds: documentIDs, TenantID: tenantID,
	})
	if err != nil {
		return Content{}, err
	}
	if len(versions) != len(documentIDs) {
		return Content{}, ErrInvalidDocument
	}
	resolved := make(map[string]store.LockCurrentMessageFileDocumentVersionsRow, len(versions))
	for index, version := range versions {
		if version.DocumentID != documentIDs[index] || version.DocumentVersionID == "" ||
			version.Filename == "" || version.MediaType == "" {
			return Content{}, ErrInvalidDocument
		}
		resolved[version.DocumentID] = version
	}
	segments := append([]Segment(nil), request.Segments...)
	for index := range segments {
		if segments[index].Type == "file" {
			version := resolved[segments[index].DocumentID]
			segments[index].DocumentVersionID = version.DocumentVersionID
			segments[index].Filename = version.Filename
			segments[index].MediaType = version.MediaType
		}
	}
	return Normalize(segments)
}

func distinctFileDocumentIDs(segments []Segment) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0)
	for _, segment := range segments {
		if segment.Type != "file" {
			continue
		}
		if _, found := seen[segment.DocumentID]; found {
			continue
		}
		seen[segment.DocumentID] = struct{}{}
		result = append(result, segment.DocumentID)
	}
	return result
}

// ValidateAgentReplySource checks business visibility without consulting an execution Run.
// The caller holds current Room membership authorization in the same transaction.
func ValidateAgentReplySource(ctx context.Context, queries *store.Queries, tenantID, roomID, agentActorID, sourceMessageID string) error {
	if sourceMessageID == "" {
		return nil
	}
	if !identifierPattern.MatchString(sourceMessageID) {
		return ErrInvalidReference
	}
	valid, err := queries.IsAgentReplySourceMessage(ctx, store.IsAgentReplySourceMessageParams{
		TenantID: tenantID, RoomID: roomID, MessageID: sourceMessageID, AgentActorID: agentActorID,
	})
	if err != nil {
		return err
	}
	if !valid {
		return ErrInvalidReference
	}
	return nil
}

func normalizeAttachments(segments []Segment, attachments []Attachment, maxAttachments int) ([]Attachment, error) {
	if len(attachments) == 0 {
		return []Attachment{}, nil
	}
	if len(attachments) > maxAttachments {
		return nil, ErrInvalid
	}
	attachmentReferences := make([]Segment, 0, len(attachments))
	for _, segment := range segments {
		if segment.Type == "file" || segment.Type == "document" && segment.Presentation == "card" {
			attachmentReferences = append(attachmentReferences, segment)
		}
	}
	if len(attachmentReferences) != len(attachments) {
		return nil, ErrInvalid
	}
	values := make([]Attachment, 0, len(attachments))
	seen := make(map[string]struct{}, len(attachments))
	for index, attachment := range attachments {
		if attachment.DocumentID == "" || attachment.DocumentVersionID == "" ||
			attachment.Filename == "" || attachment.MediaType == "" || attachment.SizeBytes < 0 ||
			attachment.SHA256 == "" || attachmentReferences[index].DocumentID != attachment.DocumentID ||
			attachmentReferences[index].Type == "file" && attachmentReferences[index].DocumentVersionID != attachment.DocumentVersionID {
			return nil, ErrInvalid
		}
		if _, exists := seen[attachment.DocumentVersionID]; exists {
			return nil, ErrInvalid
		}
		seen[attachment.DocumentVersionID] = struct{}{}
		values = append(values, attachment)
	}
	return values, nil
}

func normalizeAttachmentsWithLiveDocumentCards(
	segments []Segment,
	attachments []Attachment,
	maxAttachments int,
) ([]Attachment, error) {
	if len(attachments) == 0 {
		return []Attachment{}, nil
	}
	if len(attachments) > maxAttachments {
		return nil, ErrInvalid
	}
	values := make([]Attachment, 0, len(attachments))
	seen := make(map[string]struct{}, len(attachments))
	for _, attachment := range attachments {
		if attachment.DocumentID == "" || attachment.DocumentVersionID == "" ||
			attachment.Filename == "" || attachment.MediaType == "" || attachment.SizeBytes < 0 ||
			attachment.SHA256 == "" {
			return nil, ErrInvalid
		}
		if _, exists := seen[attachment.DocumentVersionID]; exists {
			return nil, ErrInvalid
		}
		seen[attachment.DocumentVersionID] = struct{}{}
		values = append(values, attachment)
	}
	nextAttachment := 0
	for _, segment := range segments {
		switch {
		case segment.Type == "file":
			if nextAttachment >= len(values) ||
				segment.DocumentID != values[nextAttachment].DocumentID ||
				segment.DocumentVersionID != values[nextAttachment].DocumentVersionID {
				return nil, ErrInvalid
			}
			nextAttachment++
		case segment.Type == "document" && segment.Presentation == "card" &&
			nextAttachment < len(values) && segment.DocumentID == values[nextAttachment].DocumentID:
			nextAttachment++
		}
	}
	if nextAttachment != len(values) {
		return nil, ErrInvalid
	}
	return values, nil
}

func validateSegment(segment Segment) error {
	if segment.Content == "" || utf8.RuneCountInString(segment.Content) > maxMessageLength {
		return ErrInvalid
	}
	hasArtifactTreeMetadata := segment.PublicationGroupID != "" || segment.RootPath != "" ||
		segment.FileCount != 0 || segment.DirectoryCount != 0 || segment.TotalBytes != nil ||
		segment.EntryDocumentID != "" || segment.EntryDocumentVersionID != ""
	if segment.Type != "artifact_tree" && hasArtifactTreeMetadata {
		return ErrInvalid
	}
	hasFileMetadata := segment.Filename != "" || segment.MediaType != ""
	if segment.Type != "file" && hasFileMetadata {
		return ErrInvalid
	}
	switch segment.Type {
	case "text":
		if segment.Target != "" || segment.TargetType != "" || segment.DocumentID != "" || segment.DocumentVersionID != "" || segment.Presentation != "" || segment.SkillID != "" || segment.ManifestVersion != "" || segment.Html != "" {
			return ErrInvalid
		}
	case "reference":
		if !identifierPattern.MatchString(segment.Target) || segment.TargetType != "user" && segment.TargetType != "agent" || segment.DocumentID != "" || segment.DocumentVersionID != "" || segment.Presentation != "" || segment.SkillID != "" || segment.ManifestVersion != "" || segment.Html != "" {
			return ErrInvalidReference
		}
	case "file":
		if !identifierPattern.MatchString(segment.DocumentID) || !identifierPattern.MatchString(segment.DocumentVersionID) ||
			(segment.Filename == "") != (segment.MediaType == "") || len(segment.Filename) > 1024 || len(segment.MediaType) > 255 ||
			segment.Presentation != "" || segment.Target != "" || segment.TargetType != "" || segment.SkillID != "" || segment.ManifestVersion != "" || segment.Html != "" {
			return ErrInvalid
		}
	case "document":
		if !identifierPattern.MatchString(segment.DocumentID) || segment.DocumentVersionID != "" ||
			!ValidDocumentPresentation(segment.Presentation) ||
			segment.Target != "" || segment.TargetType != "" || segment.SkillID != "" || segment.ManifestVersion != "" || segment.Html != "" {
			return ErrInvalid
		}
	case "html_fragment":
		if utf8.RuneCountInString(segment.Content) > maxHtmlFragmentStubRunes ||
			strings.TrimSpace(segment.Html) == "" || len(segment.Html) > maxHtmlFragmentBytes ||
			segment.Target != "" || segment.TargetType != "" || segment.DocumentID != "" ||
			segment.DocumentVersionID != "" || segment.Presentation != "" || segment.SkillID != "" || segment.ManifestVersion != "" {
			return ErrInvalid
		}
	case "skill":
		if !validSkillToken(segment.Content) || !identifierPattern.MatchString(segment.Target) || !skillIDPattern.MatchString(segment.SkillID) || !manifestPattern.MatchString(segment.ManifestVersion) || segment.TargetType != "" || segment.DocumentID != "" || segment.DocumentVersionID != "" || segment.Presentation != "" || segment.Html != "" {
			return ErrInvalid
		}
	case "artifact_tree":
		hasEntry := segment.EntryDocumentID != "" || segment.EntryDocumentVersionID != ""
		if !identifierPattern.MatchString(segment.PublicationGroupID) || strings.TrimSpace(segment.RootPath) == "" ||
			len(segment.RootPath) > 1024 || segment.FileCount < 1 || segment.FileCount > 64 ||
			segment.DirectoryCount < 1 || segment.DirectoryCount > 10001 || segment.TotalBytes == nil ||
			*segment.TotalBytes < 0 || *segment.TotalBytes > 512<<20 ||
			hasEntry && (!identifierPattern.MatchString(segment.EntryDocumentID) || !identifierPattern.MatchString(segment.EntryDocumentVersionID)) ||
			segment.Target != "" || segment.TargetType != "" || segment.DocumentID != "" ||
			segment.DocumentVersionID != "" || segment.Presentation != "" || segment.SkillID != "" || segment.ManifestVersion != "" || segment.Html != "" {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}

func validateFileRequestSegment(segment Segment) error {
	if segment.Type != "file" {
		return validateSegment(segment)
	}
	if segment.Content == "" || utf8.RuneCountInString(segment.Content) > maxMessageLength ||
		!identifierPattern.MatchString(segment.DocumentID) || segment.DocumentVersionID != "" ||
		segment.Filename != "" || segment.MediaType != "" ||
		segment.Presentation != "" || segment.Target != "" || segment.TargetType != "" || segment.SkillID != "" ||
		segment.ManifestVersion != "" || segment.Html != "" {
		return ErrInvalid
	}
	return nil
}

func validSkillToken(value string) bool {
	return strings.HasPrefix(value, "/") && len(value) > 1 && !strings.ContainsFunc(value, unicode.IsSpace)
}

func messageSkillReferences(segments []Segment) []skillReference {
	references := make([]skillReference, 0)
	contextTarget := ""
	for _, segment := range segments {
		switch segment.Type {
		case "reference":
			if segment.TargetType == "agent" {
				contextTarget = segment.Target
			} else {
				contextTarget = ""
			}
		case "skill":
			references = append(references, skillReference{
				Target: segment.Target, ContextTarget: contextTarget,
				SkillID: segment.SkillID, ManifestVersion: segment.ManifestVersion,
			})
		}
	}
	return references
}

// A Thread Room carries no membership of its own, so ListRoomMentionTargets
// resolves the Room to its collaboration Room. A Thread Mention therefore
// admits nobody and only accepts an Actor the parent Room already has.
func resolveMentions(ctx context.Context, queries *store.Queries, roomID string, segments []Segment) ([]store.Actor, error) {
	expectedKinds := map[string]string{}
	for _, segment := range segments {
		if segment.Type != "reference" {
			continue
		}
		expected := "human"
		if segment.TargetType == "agent" {
			expected = "agent"
		}
		if current, found := expectedKinds[segment.Target]; found && current != expected {
			return nil, ErrInvalidReference
		}
		expectedKinds[segment.Target] = expected
	}
	if len(expectedKinds) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(expectedKinds))
	for actorID := range expectedKinds {
		ids = append(ids, actorID)
	}
	sort.Strings(ids)
	targets, err := queries.ListRoomMentionTargets(ctx, store.ListRoomMentionTargetsParams{RoomID: roomID, ActorIds: ids})
	if err != nil {
		return nil, err
	}
	if len(targets) != len(ids) {
		return nil, ErrInvalidReference
	}
	for _, target := range targets {
		if expectedKinds[target.ID] != target.Kind {
			return nil, ErrInvalidReference
		}
	}
	return targets, nil
}
