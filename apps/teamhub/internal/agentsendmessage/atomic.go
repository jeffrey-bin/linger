package agentsendmessage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

type PreparedUpload struct {
	UploadID             string `json:"upload_id"`
	Filename             string `json:"filename"`
	RepresentationFormat string `json:"representation_format"`
	MediaType            string `json:"media_type"`
	SizeBytes            int64  `json:"size_bytes"`
	SHA256               string `json:"sha256"`
	ObjectKey            string `json:"-"`
}
type PreparedTreeEntry struct {
	Kind         string `json:"kind"`
	RelativePath string `json:"relative_path"`
	UploadID     string `json:"upload_id,omitempty"`
}
type PreparedSegment struct {
	presentFields []string
	Type          string              `json:"type"`
	Content       string              `json:"content,omitempty"`
	Title         string              `json:"title,omitempty"`
	Target        string              `json:"target,omitempty"`
	TargetType    string              `json:"target_type,omitempty"`
	DocumentID    string              `json:"document_id,omitempty"`
	Presentation  string              `json:"presentation,omitempty"`
	UploadID      string              `json:"upload_id,omitempty"`
	Mode          string              `json:"mode,omitempty"`
	RootName      string              `json:"root_name,omitempty"`
	Entries       []PreparedTreeEntry `json:"entries,omitempty"`
}

// Keep property presence so an empty forbidden field cannot disappear through
// omitempty before branch validation.
func (s *PreparedSegment) UnmarshalJSON(data []byte) error {
	type plain PreparedSegment
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*s = PreparedSegment(value)
	for key := range fields {
		s.presentFields = append(s.presentFields, key)
	}
	return nil
}

type AtomicInput struct {
	Segments []PreparedSegment `json:"segments"`
	Uploads  []PreparedUpload  `json:"uploads"`
}
type Resource struct {
	Kind                   string                 `json:"kind"`
	SegmentIndex           int                    `json:"segment_index"`
	Status                 string                 `json:"status"`
	DocumentID             string                 `json:"document_id,omitempty"`
	VersionID              string                 `json:"version_id,omitempty"`
	RevisionID             string                 `json:"revision_id,omitempty"`
	Name                   string                 `json:"name,omitempty"`
	PublicationGroupID     string                 `json:"publication_group_id,omitempty"`
	RootPlacementPath      string                 `json:"root_placement_path,omitempty"`
	FileCount              *int                   `json:"file_count,omitempty"`
	DirectoryCount         *int                   `json:"directory_count,omitempty"`
	TotalBytes             *int64                 `json:"total_bytes,omitempty"`
	Documents              []TreeResourceDocument `json:"documents,omitempty"`
	EntryDocumentID        string                 `json:"entry_document_id,omitempty"`
	EntryDocumentVersionID string                 `json:"entry_document_version_id,omitempty"`
}
type TreeResourceDocument struct {
	RelativePath      string `json:"relative_path"`
	DocumentID        string `json:"document_id"`
	DocumentVersionID string `json:"document_version_id"`
}

const (
	// A fragment segment also needs the Context's show_fragment grant.
	showFragmentToolName = "show_fragment"
	// A fragment's title is one short line, shown in previews and quotes.
	maxFragmentTitleRunes = 120
)

var uploadIDPattern = regexp.MustCompile(`^upload_[0-9]+$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ValidateAtomicInput runs before staging any request bytes. Object keys are
// transport identities and deliberately excluded from the business receipt.
func ValidateAtomicInput(input Input) error { _, err := normalizeAtomicInput(input); return err }
func normalizeAtomicInput(input Input) (normalizedInput, error) {
	if input.Atomic == nil || len(input.messageSegments) > 0 || len(input.Atomic.Segments) < 1 || len(input.Atomic.Segments) > 1000 || len(input.Atomic.Uploads) > 1000 {
		return normalizedInput{}, ErrInvalid
	}
	uploads := map[string]PreparedUpload{}
	var total int64
	for _, u := range input.Atomic.Uploads {
		if !uploadIDPattern.MatchString(u.UploadID) || u.Filename == "" || len(u.Filename) > 255 || path.Base(u.Filename) != u.Filename || strings.ContainsAny(u.Filename, "\\\x00") || u.RepresentationFormat == "" || len(u.RepresentationFormat) > 120 || u.MediaType == "" || len(u.MediaType) > 255 || u.SizeBytes < 0 || u.SizeBytes > 50<<20 || !digestPattern.MatchString(u.SHA256) {
			return normalizedInput{}, ErrInvalid
		}
		if _, ok := uploads[u.UploadID]; ok {
			return normalizedInput{}, ErrInvalid
		}
		uploads[u.UploadID] = u
		total += u.SizeBytes
	}
	if total > 512<<20 {
		return normalizedInput{}, ErrInvalid
	}
	used := map[string]bool{}
	segments := make([]messagecreation.Segment, 0, len(input.Atomic.Segments))
	fragmentBytes := 0
	use := func(uploadID string) bool {
		_, ok := uploads[uploadID]
		if ok {
			used[uploadID] = true
		}
		return ok
	}
	for _, s := range input.Atomic.Segments {
		allowed := map[string]bool{"type": true}
		var required []string
		switch s.Type {
		case "text":
			allowed["content"] = true
			required = []string{"content"}
			segments = append(segments, messagecreation.Segment{Type: "text", Content: s.Content})
		case "reference":
			for _, k := range []string{"content", "target", "target_type"} {
				allowed[k] = true
			}
			required = []string{"content", "target", "target_type"}
			if strings.ContainsAny(s.Content, "\r\n") || utf8.RuneCountInString(s.Content) > 120 {
				return normalizedInput{}, ErrInvalid
			}
			segments = append(segments, messagecreation.Segment{Type: "reference", Content: s.Content, Target: s.Target, TargetType: s.TargetType})
		case "document":
			allowed["content"] = true
			if s.Mode == "tree" {
				for _, k := range []string{"mode", "root_name", "entries"} {
					allowed[k] = true
				}
				required = []string{"mode", "root_name", "entries"}
				if s.RootName == "" || path.Base(s.RootName) != s.RootName || strings.ContainsAny(s.RootName, "\\\x00") || len(s.Entries) < 1 || len(s.Entries) > 10000 {
					return normalizedInput{}, ErrInvalid
				}
				files := 0
				seen := map[string]bool{}
				for _, e := range s.Entries {
					if !safeTreePath(e.RelativePath) || seen[e.RelativePath] {
						return normalizedInput{}, ErrInvalid
					}
					seen[e.RelativePath] = true
					if e.Kind == "file" {
						files++
						if !use(e.UploadID) {
							return normalizedInput{}, ErrInvalid
						}
					} else if e.Kind != "directory" || e.UploadID != "" {
						return normalizedInput{}, ErrInvalid
					}
				}
				if files < 1 || files > 64 {
					return normalizedInput{}, ErrInvalid
				}
			} else if s.UploadID != "" {
				allowed["upload_id"] = true
				allowed["mode"] = true
				required = []string{"upload_id"}
				if !use(s.UploadID) || s.Mode != "" && s.Mode != "file" && s.Mode != "document" || s.Mode == "document" && uploads[s.UploadID].RepresentationFormat != "markdown" {
					return normalizedInput{}, ErrInvalid
				}
			} else {
				allowed["document_id"] = true
				allowed["presentation"] = true
				required = []string{"document_id", "content"}
				if !roomIDPattern.MatchString(s.DocumentID) || !messagecreation.ValidDocumentPresentation(s.Presentation) {
					return normalizedInput{}, ErrInvalid
				}
			}
			if s.DocumentID != "" {
				segments = append(segments, messagecreation.Segment{Type: "document", Content: s.Content, DocumentID: s.DocumentID, Presentation: s.Presentation})
			} else {
				segments = append(segments, messagecreation.Segment{Type: "text", Content: "Resource"})
			}
		case "fragment":
			allowed["content"] = true
			allowed["upload_id"] = true
			allowed["title"] = true
			required = []string{"title"}
			if (s.Content == "") == (s.UploadID == "") || !validFragmentTitle(s.Title) {
				return normalizedInput{}, ErrInvalid
			}
			if s.UploadID != "" {
				if !use(s.UploadID) {
					return normalizedInput{}, ErrInvalid
				}
				fragmentBytes += int(uploads[s.UploadID].SizeBytes)
			} else {
				fragmentBytes += len(s.Content)
				if !utf8.ValidString(s.Content) || strings.TrimSpace(s.Content) == "" {
					return normalizedInput{}, ErrInvalid
				}
			}
			segments = append(segments, messagecreation.Segment{Type: "text", Content: s.Title})
		default:
			return normalizedInput{}, ErrInvalid
		}
		encoded, _ := json.Marshal(s)
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			return normalizedInput{}, ErrInvalid
		}
		if s.presentFields != nil {
			fields = map[string]json.RawMessage{}
			for _, key := range s.presentFields {
				fields[key] = nil
			}
		}
		if _, present := fields["content"]; present && (strings.TrimSpace(s.Content) == "" || !utf8.ValidString(s.Content) || s.Type != "fragment" && utf8.RuneCountInString(s.Content) > 50000) {
			return normalizedInput{}, ErrInvalid
		}
		for k := range fields {
			if !allowed[k] {
				return normalizedInput{}, ErrInvalid
			}
		}
		for _, k := range required {
			if _, ok := fields[k]; !ok {
				return normalizedInput{}, ErrInvalid
			}
		}
	}
	if len(used) != len(uploads) || fragmentBytes > 2<<20 {
		return normalizedInput{}, ErrInvalid
	}
	plain := input
	plain.Atomic = nil
	plain.messageSegments = segments
	// Existing canonical validation also fences IDs, sources and total body length.
	normalized, err := normalizeInput(plain)
	if err != nil {
		return normalizedInput{}, err
	}
	canonical, err := json.Marshal(struct {
		InboxID, SourceMessageID string
		SourceInboxIDs           []string
		Intent                   *AtomicInput
		Continues                bool   `json:",omitempty"`
		CardTitle                string `json:",omitempty"`
		CardKind                 string `json:",omitempty"`
	}{normalized.target.raw, input.SourceMessageID, append([]string{}, input.SourceInboxIDs...), input.Atomic, input.Continues, input.CardTitle, input.CardKind})
	if err != nil {
		return normalizedInput{}, ErrInvalid
	}
	normalized.canonicalRequestHash = sha256.Sum256(canonical)
	return normalized, nil
}
func safeTreePath(value string) bool {
	if value == "" || len(value) > 1024 || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") {
		return false
	}
	parts := strings.Split(value, "/")
	if len(parts) > 32 {
		return false
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}
func validFragmentTitle(title string) bool {
	return strings.TrimSpace(title) == title && title != "" && utf8.ValidString(title) &&
		utf8.RuneCountInString(title) <= maxFragmentTitleRunes && !strings.ContainsAny(title, "\r\n")
}
func hasFragment(input *AtomicInput) bool {
	for _, s := range input.Segments {
		if s.Type == "fragment" {
			return true
		}
	}
	return false
}

func (s *Service) prepareAtomic(ctx context.Context, tx pgx.Tx, authorization agentauth.Authorization, target resolvedTarget, input Input, idempotencyKey string) (messagecreation.Content, []Resource, []string, error) {
	if s.documents == nil || s.objects == nil {
		return messagecreation.Content{}, nil, nil, ErrUnavailable
	}
	uploads := map[string]PreparedUpload{}
	for _, u := range input.Atomic.Uploads {
		object, err := s.objects.Head(ctx, u.ObjectKey)
		if err != nil || object.Size != u.SizeBytes || hex.EncodeToString(object.SHA256[:]) != u.SHA256 {
			return messagecreation.Content{}, nil, nil, ErrInvalid
		}
		uploads[u.UploadID] = u
	}
	segments := make([]messagecreation.Segment, 0, len(input.Atomic.Segments))
	resources := []Resource{}
	versions := []string{}
	seenVersions := map[string]bool{}
	addVersion := func(value string) {
		if !seenVersions[value] {
			versions = append(versions, value)
			seenVersions[value] = true
		}
	}
	for index, prepared := range input.Atomic.Segments {
		if prepared.Type == "text" || prepared.Type == "reference" {
			segments = append(segments, messagecreation.Segment{Type: prepared.Type, Content: prepared.Content, Target: prepared.Target, TargetType: prepared.TargetType})
			continue
		}
		if prepared.Mode == "tree" {
			treeInput := document.AgentTreePublicationInput{Principal: authorization.Principal, TenantID: target.tenantID, AgentID: authorization.AgentID, ContextKind: "room", ContextID: target.documentRoomID(), OperationID: fmt.Sprintf("message-tree:%s:%d", idempotencyKey, index), DirectoryPath: target.documentRoomID() + "/" + prepared.RootName}
			files := []document.AgentTreeStableFile{}
			for _, e := range prepared.Entries {
				entry := document.AgentTreeManifestEntry{Kind: e.Kind, RelativePath: e.RelativePath}
				if e.Kind == "file" {
					u := uploads[e.UploadID]
					entry.MediaType = u.MediaType
					entry.SHA256 = u.SHA256
					entry.SizeBytes = u.SizeBytes
					files = append(files, document.AgentTreeStableFile{RelativePath: e.RelativePath, MediaType: u.MediaType, SHA256: u.SHA256, SizeBytes: u.SizeBytes, ObjectKey: u.ObjectKey})
				}
				treeInput.Entries = append(treeInput.Entries, entry)
			}
			tree, err := s.documents.CreateMessageTreeTx(ctx, tx, treeInput, files)
			if err != nil {
				return messagecreation.Content{}, nil, nil, err
			}
			resource := Resource{Kind: "tree", SegmentIndex: index, Status: "published", PublicationGroupID: tree.PublicationGroupID, RootPlacementPath: tree.RootPlacementPath, FileCount: &tree.FileCount, DirectoryCount: &tree.DirectoryCount, TotalBytes: &tree.TotalBytes, EntryDocumentID: tree.EntryDocumentID, EntryDocumentVersionID: tree.EntryDocumentVersionID, Documents: []TreeResourceDocument{}}
			for _, d := range tree.Documents {
				resource.Documents = append(resource.Documents, TreeResourceDocument{RelativePath: d.RelativePath, DocumentID: d.DocumentID, DocumentVersionID: d.DocumentVersionID})
			}
			resources = append(resources, resource)
			label := prepared.Content
			if label == "" {
				label = prepared.RootName
			}
			segments = append(segments, messagecreation.Segment{Type: "artifact_tree", Content: label, PublicationGroupID: tree.PublicationGroupID, RootPath: tree.RootPlacementPath, FileCount: tree.FileCount, DirectoryCount: tree.DirectoryCount, TotalBytes: &tree.TotalBytes, EntryDocumentID: tree.EntryDocumentID, EntryDocumentVersionID: tree.EntryDocumentVersionID})
			continue
		}
		upload := uploads[prepared.UploadID]
		html := ""
		newResource := prepared.UploadID != ""
		native := prepared.Type == "document" && prepared.Mode != "file" && (upload.RepresentationFormat == "markdown")
		if prepared.Type == "fragment" {
			html = prepared.Content
			if prepared.UploadID != "" {
				reader, err := s.objects.Open(ctx, upload.ObjectKey)
				if err != nil {
					return messagecreation.Content{}, nil, nil, err
				}
				data, readErr := io.ReadAll(io.LimitReader(reader, 2<<20+1))
				_ = reader.Close()
				if readErr != nil || len(data) > 2<<20 || !utf8.Valid(data) {
					return messagecreation.Content{}, nil, nil, ErrInvalid
				}
				html = string(data)
			} else {
				object, err := s.objects.Put(ctx, strings.NewReader(html))
				if err != nil {
					return messagecreation.Content{}, nil, nil, err
				}
				input.Atomic.Uploads = append(input.Atomic.Uploads, PreparedUpload{ObjectKey: object.Key})
				upload = PreparedUpload{Filename: "visual-fragment.html", RepresentationFormat: "html", MediaType: "text/html", SizeBytes: object.Size, SHA256: hex.EncodeToString(object.SHA256[:]), ObjectKey: object.Key}
				newResource = true
			}
			if strings.TrimSpace(html) == "" {
				return messagecreation.Content{}, nil, nil, ErrInvalid
			}
			upload.Filename = "visual-fragment.html"
			upload.RepresentationFormat = "html"
			upload.MediaType = "text/html"
			native = false
		}
		resource := Resource{Kind: "document", SegmentIndex: index, Status: "reused", DocumentID: prepared.DocumentID}
		var filename, mediaType string
		if newResource {
			attachment, err := s.documents.CreateAgentMessageAttachmentTx(ctx, tx, document.CreateAgentMessageAttachmentInput{TenantID: target.tenantID, RoomID: target.documentRoomID(), AgentActorID: target.author.ID, AttachmentKey: fmt.Sprintf("%s:%d", idempotencyKey, index), SourceInvocationID: fmt.Sprintf("%s:%d", input.InvocationID, index), Filename: upload.Filename, RepresentationFormat: upload.RepresentationFormat, MediaType: upload.MediaType, ObjectKey: upload.ObjectKey, SizeBytes: upload.SizeBytes, SHA256: upload.SHA256, NativeDocument: native})
			if err != nil {
				return messagecreation.Content{}, nil, nil, err
			}
			resource.Status = "published"
			resource.DocumentID = attachment.DocumentID
			resource.VersionID = attachment.DocumentVersionID
			filename = upload.Filename
			mediaType = upload.MediaType
		} else {
			// Resolve the current content head inside the same target-authorized transaction.
			err := tx.QueryRow(ctx, `SELECT d.title,coalesce(d.current_version_id,''),coalesce(snapshot_document_body(d.id),''),coalesce(v.filename,d.title),coalesce(v.media_type,'') FROM documents d LEFT JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=$1 AND d.tenant_id=$2 AND d.status='active'`, prepared.DocumentID, target.tenantID).Scan(&resource.Name, &resource.VersionID, &resource.RevisionID, &filename, &mediaType)
			if errors.Is(err, pgx.ErrNoRows) {
				return messagecreation.Content{}, nil, nil, ErrInvalid
			}
			if err != nil {
				return messagecreation.Content{}, nil, nil, err
			}
			if resource.VersionID == "" && resource.RevisionID == "" {
				return messagecreation.Content{}, nil, nil, ErrInvalid
			}
		}
		if resource.Name == "" {
			resource.Name = filename
		}
		label := prepared.Content
		if label == "" {
			label = filename
		}
		switch {
		case prepared.Type == "fragment":
			// The title is what previews and quotes show; the Document stays
			// readable through the Message's resource references.
			segments = append(segments, messagecreation.Segment{Type: "html_fragment", Content: prepared.Title, Html: html})
			addVersion(resource.VersionID)
		case prepared.Type == "document" && (native || prepared.DocumentID != ""):
			presentation := prepared.Presentation
			if presentation == "" && newResource {
				presentation = "card"
			}
			segments = append(segments, messagecreation.Segment{Type: "document", Content: label, DocumentID: resource.DocumentID, Presentation: presentation})
		default:
			if resource.VersionID == "" {
				return messagecreation.Content{}, nil, nil, ErrInvalid
			}
			segments = append(segments, messagecreation.Segment{Type: "file", Content: label, DocumentID: resource.DocumentID, DocumentVersionID: resource.VersionID, Filename: filename, MediaType: mediaType})
			addVersion(resource.VersionID)
		}
		resources = append(resources, resource)
	}
	content, err := messagecreation.Normalize(segments)
	if err != nil {
		return messagecreation.Content{}, nil, nil, ErrInvalid
	}
	return content, resources, versions, nil
}
