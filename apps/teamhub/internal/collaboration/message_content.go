package collaboration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	// MaxMessageLength bounds a Message body in runes.
	MaxMessageLength   = 50000
	maxMessageSegments = 1000
	maxMessageContexts = 10
)

var (
	messageSegmentIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	attachmentUploadTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)
	messageSegmentSkillIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$`)
)

// MessageContent is a validated Human Message request.
type MessageContent struct {
	voiceLiveTurn             *httpapi.VoiceLiveTurnMarker
	rawMessage                string
	segments                  []httpapi.MessageSegment
	encoded                   []byte
	attachmentUploadIDs       []string
	contextDocumentVersionIDs []string
	contextMessageIDs         []string
}

// NormalizeMessageCreateRequest validates a Human Message request against the Message contract.
func NormalizeMessageCreateRequest(request httpapi.MessageCreateRequest) (MessageContent, error) {
	if request.MessageKind != nil && *request.MessageKind != httpapi.Conversation {
		return MessageContent{}, errors.New("Human messages must use conversation kind")
	}
	if request.Segments == nil {
		return MessageContent{}, errors.New("segments are required")
	}
	var content MessageContent
	if strings.TrimSpace(request.RawMessage) == "" && len(request.Segments) == 0 &&
		(request.AttachmentUploadIds != nil && len(*request.AttachmentUploadIds) > 0 ||
			request.ContextDocumentVersionIds != nil && len(*request.ContextDocumentVersionIds) > 0) {
		content = MessageContent{rawMessage: "", segments: []httpapi.MessageSegment{}, encoded: []byte("[]")}
	} else {
		var err error
		content, err = validateMessageContent(request.RawMessage, request.Segments)
		if err != nil {
			return MessageContent{}, err
		}
		for _, segment := range content.segments {
			discriminator, discErr := segment.Discriminator()
			if discErr != nil || discriminator == "html_fragment" {
				return MessageContent{}, errors.New("html_fragment segments can only be created by show_fragment")
			}
			if discriminator == "file" {
				file, fileErr := segment.AsFileSegment()
				if fileErr != nil || file.Filename != nil || file.MediaType != nil {
					return MessageContent{}, errors.New("file metadata is supplied by TeamHub")
				}
			}
		}
	}
	if request.ContextMessageIds != nil {
		if len(*request.ContextMessageIds) > maxMessageContexts {
			return MessageContent{}, errors.New("too many context messages")
		}
		seen := make(map[string]struct{}, len(*request.ContextMessageIds))
		for _, id := range *request.ContextMessageIds {
			if !messageSegmentIDPattern.MatchString(id) {
				return MessageContent{}, errors.New("context message id is invalid")
			}
			if _, exists := seen[id]; exists {
				return MessageContent{}, errors.New("context message ids must be unique")
			}
			seen[id] = struct{}{}
			content.contextMessageIDs = append(content.contextMessageIDs, id)
		}
	}
	if request.AttachmentUploadIds != nil {
		if len(*request.AttachmentUploadIds) > 5 {
			return MessageContent{}, errors.New("too many attachment uploads")
		}
		seen := make(map[string]struct{}, len(*request.AttachmentUploadIds))
		for _, id := range *request.AttachmentUploadIds {
			if len(id) > secretbox.MaxSignedLength || !attachmentUploadTokenPattern.MatchString(id) {
				return MessageContent{}, errors.New("attachment upload id is invalid")
			}
			if _, exists := seen[id]; exists {
				return MessageContent{}, errors.New("attachment upload ids must be unique")
			}
			seen[id] = struct{}{}
			content.attachmentUploadIDs = append(content.attachmentUploadIDs, id)
		}
	}
	if request.ContextDocumentVersionIds != nil {
		if len(*request.ContextDocumentVersionIds) > 5 {
			return MessageContent{}, errors.New("too many context Document Versions")
		}
		seen := make(map[string]struct{}, len(*request.ContextDocumentVersionIds))
		for _, id := range *request.ContextDocumentVersionIds {
			if !messageSegmentIDPattern.MatchString(id) {
				return MessageContent{}, errors.New("context Document Version id is invalid")
			}
			if _, exists := seen[id]; exists {
				return MessageContent{}, errors.New("context Document Version ids must be unique")
			}
			seen[id] = struct{}{}
			content.contextDocumentVersionIDs = append(content.contextDocumentVersionIDs, id)
		}
	}
	if len(content.attachmentUploadIDs) == 0 && len(content.contextDocumentVersionIDs) == 0 && strings.TrimSpace(content.rawMessage) == "" {
		return MessageContent{}, errors.New("message content is required")
	}
	fileReferences, err := messageFileReferences(content)
	if err != nil || len(fileReferences)+len(content.attachmentUploadIDs)+len(content.contextDocumentVersionIDs) > 5 {
		return MessageContent{}, errors.New("message attachments are invalid")
	}
	seenVersions := make(map[string]struct{}, len(fileReferences)+len(content.contextDocumentVersionIDs))
	versionIDs := append([]string{}, content.contextDocumentVersionIDs...)
	for _, reference := range fileReferences {
		versionIDs = append(versionIDs, reference.documentVersionID)
	}
	for _, id := range versionIDs {
		if _, exists := seenVersions[id]; exists {
			return MessageContent{}, errors.New("message attachment Versions must be unique")
		}
		seenVersions[id] = struct{}{}
	}
	content.voiceLiveTurn = request.VoiceLiveTurn
	return content, nil
}

func messageFileReferences(content MessageContent) ([]messageFileReference, error) {
	references := make([]messageFileReference, 0, 5)
	seen := make(map[string]struct{}, 5)
	for _, segment := range content.segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return nil, err
		}
		if discriminator != "file" {
			continue
		}
		file, err := segment.AsFileSegment()
		if err != nil {
			return nil, err
		}
		if _, exists := seen[file.DocumentVersionId]; exists {
			return nil, errors.New("file segments must reference unique versions")
		}
		seen[file.DocumentVersionId] = struct{}{}
		references = append(references, messageFileReference{
			documentID: file.DocumentId, documentVersionID: file.DocumentVersionId,
		})
	}
	return references, nil
}

func (content MessageContent) appendAttachment(filename, documentID string) (MessageContent, error) {
	if content.rawMessage != "" {
		separator := httpapi.MessageSegment{}
		if err := separator.FromTextSegment(httpapi.TextSegment{Type: "text", Content: "\n"}); err != nil {
			return MessageContent{}, err
		}
		content.segments = append(content.segments, separator)
		content.rawMessage += "\n"
	}
	segment := httpapi.MessageSegment{}
	presentation := httpapi.DocumentSegmentPresentationCard
	if err := segment.FromDocumentSegment(httpapi.DocumentSegment{
		Type: "document", Content: filename, DocumentId: documentID, Presentation: &presentation,
	}); err != nil {
		return MessageContent{}, err
	}
	content.segments = append(content.segments, segment)
	content.rawMessage += filename
	if len(content.rawMessage) > MaxMessageLength || len(content.segments) > maxMessageSegments {
		return MessageContent{}, errors.New("attachment content exceeds message limits")
	}
	encoded, err := json.Marshal(content.segments)
	if err != nil {
		return MessageContent{}, err
	}
	content.encoded = encoded
	return content, nil
}

func storedMessageContent(rawMessage string, encoded []byte) (MessageContent, error) {
	var segments []httpapi.MessageSegment
	if err := json.Unmarshal(encoded, &segments); err != nil {
		return MessageContent{}, err
	}
	content, err := validateMessageContent(rawMessage, segments)
	if err != nil {
		return MessageContent{}, err
	}
	return content, nil
}

func forwardedMessageContent(rawMessage string, encoded []byte) (MessageContent, error) {
	stored, err := storedMessageContent(rawMessage, encoded)
	if err != nil {
		return MessageContent{}, err
	}
	segments := make([]httpapi.MessageSegment, 0, len(stored.segments))
	for _, segment := range stored.segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return MessageContent{}, err
		}
		if discriminator == "text" || discriminator == "file" || discriminator == "document" {
			segments = append(segments, segment)
			continue
		}
		content, err := validateMessageSegment(segment)
		if err != nil {
			return MessageContent{}, err
		}
		plain := httpapi.MessageSegment{}
		if err := plain.FromTextSegment(httpapi.TextSegment{Type: "text", Content: content}); err != nil {
			return MessageContent{}, err
		}
		segments = append(segments, plain)
	}
	content, err := validateMessageContent(rawMessage, segments)
	if err != nil {
		return MessageContent{}, err
	}
	return content, nil
}

func validateMessageContent(rawMessage string, segments []httpapi.MessageSegment) (MessageContent, error) {
	if strings.TrimSpace(rawMessage) == "" || len(rawMessage) > MaxMessageLength {
		return MessageContent{}, errors.New("raw_message is invalid")
	}
	if len(segments) == 0 || len(segments) > maxMessageSegments {
		return MessageContent{}, errors.New("segments length is invalid")
	}

	var reconstructed strings.Builder
	reconstructed.Grow(len(rawMessage))
	for _, segment := range segments {
		content, err := validateMessageSegment(segment)
		if err != nil {
			return MessageContent{}, err
		}
		reconstructed.WriteString(content)
		if reconstructed.Len() > MaxMessageLength {
			return MessageContent{}, errors.New("segment content exceeds message length")
		}
	}
	if reconstructed.String() != rawMessage {
		return MessageContent{}, errors.New("segment content does not reconstruct raw_message")
	}
	encoded, err := json.Marshal(segments)
	if err != nil {
		return MessageContent{}, err
	}
	return MessageContent{rawMessage: rawMessage, segments: segments, encoded: encoded}, nil
}

func validateMessageSegment(segment httpapi.MessageSegment) (string, error) {
	encoded, err := segment.MarshalJSON()
	if err != nil {
		return "", err
	}
	discriminator, err := segment.Discriminator()
	if err != nil {
		return "", err
	}
	switch discriminator {
	case "text":
		var value httpapi.TextSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "text" || value.Content == "" || len(value.Content) > MaxMessageLength {
			return "", errors.New("text segment is invalid")
		}
		return value.Content, nil
	case "reference":
		var value httpapi.ReferenceSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "reference" || value.Content == "" || len(value.Content) > MaxMessageLength || !messageSegmentIDPattern.MatchString(value.Target) || !value.TargetType.Valid() {
			return "", errors.New("reference segment is invalid")
		}
		return value.Content, nil
	case "file":
		var value httpapi.FileSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "file" || value.Content == "" || len(value.Content) > MaxMessageLength || !messageSegmentIDPattern.MatchString(value.DocumentId) || !messageSegmentIDPattern.MatchString(value.DocumentVersionId) {
			return "", errors.New("file segment is invalid")
		}
		return value.Content, nil
	case "html_fragment":
		var value httpapi.HtmlFragmentSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "html_fragment" || value.Content == "" || len(value.Content) > 1024 || strings.TrimSpace(value.Html) == "" || len(value.Html) > 2<<20 {
			return "", errors.New("html fragment segment is invalid")
		}
		return value.Content, nil
	case "document":
		var value httpapi.DocumentSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "document" || value.Content == "" || len(value.Content) > MaxMessageLength || !messageSegmentIDPattern.MatchString(value.DocumentId) || value.Presentation != nil && !value.Presentation.Valid() {
			return "", errors.New("document segment is invalid")
		}
		return value.Content, nil
	case "skill":
		var value httpapi.SkillSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil || value.Type != "skill" || !validSkillToken(value.Content) || !messageSegmentIDPattern.MatchString(value.Target) || !messageSegmentSkillIDPattern.MatchString(value.SkillId) {
			return "", errors.New("skill segment is invalid")
		}
		return value.Content, nil
	case "artifact_tree":
		var value httpapi.ArtifactTreeSegment
		if err := decodeStrictJSON(bytes.NewReader(encoded), &value, "segment must contain one JSON object"); err != nil ||
			value.Type != "artifact_tree" || value.Content == "" || len(value.Content) > MaxMessageLength ||
			!messageSegmentIDPattern.MatchString(value.PublicationGroupId) ||
			strings.TrimSpace(value.RootPath) == "" || len(value.RootPath) > 1024 ||
			value.FileCount < 1 || value.FileCount > 64 ||
			value.DirectoryCount < 1 || value.DirectoryCount > 10001 ||
			value.TotalBytes < 0 || value.TotalBytes > 512<<20 ||
			(value.EntryDocumentId == nil) != (value.EntryDocumentVersionId == nil) ||
			value.EntryDocumentId != nil && !messageSegmentIDPattern.MatchString(*value.EntryDocumentId) ||
			value.EntryDocumentVersionId != nil && !messageSegmentIDPattern.MatchString(*value.EntryDocumentVersionId) {
			return "", errors.New("artifact tree segment is invalid")
		}
		return value.Content, nil
	default:
		return "", errors.New("message segment type is invalid")
	}
}

func messageDocumentIDs(content MessageContent) ([]string, error) {
	seen := make(map[string]struct{})
	ids := make([]string, 0)
	for _, segment := range content.segments {
		discriminator, err := segment.Discriminator()
		if err != nil {
			return nil, err
		}
		var documentID string
		switch discriminator {
		case "document":
			value, err := segment.AsDocumentSegment()
			if err != nil {
				return nil, err
			}
			documentID = value.DocumentId
		case "file":
			value, err := segment.AsFileSegment()
			if err != nil {
				return nil, err
			}
			documentID = value.DocumentId
		default:
			continue
		}
		if _, exists := seen[documentID]; exists {
			continue
		}
		seen[documentID] = struct{}{}
		ids = append(ids, documentID)
	}
	return ids, nil
}

func validSkillToken(value string) bool {
	return strings.HasPrefix(value, "/") && len(value) > 1 && len(value) <= MaxMessageLength && !strings.ContainsFunc(value, unicode.IsSpace)
}

type messageFileReference struct {
	documentID, documentVersionID string
}

func decodeStrictJSON(reader io.Reader, target any, multipleValueMessage string) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New(multipleValueMessage)
	}
	return nil
}
