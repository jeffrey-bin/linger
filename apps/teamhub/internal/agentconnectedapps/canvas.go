package agentconnectedapps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	gmtext "github.com/yuin/goldmark/text"
)

var (
	// The canvas header uses the syntax Web edits it with (canvas-document.ts):
	// a first line "canvas: <target>", then "key: value" lines, case-insensitive.
	canvasHeaderLine = regexp.MustCompile(`(?i)^canvas:\s*([a-z0-9][a-z0-9_-]{0,63})\s*$`)
	canvasFieldLine  = regexp.MustCompile(`(?i)^([a-z][a-z0-9_]{0,63}):\s?(.*)$`)
	// CanvasHeaderFence matches the header code block as the Markdown export
	// writes it: the leading fenced block.
	CanvasHeaderFence = regexp.MustCompile("^\\s*(```|~~~)[^\\n]*\\n(?s:.*?)\\n[ \\t]*(```|~~~)[ \\t]*(\\n|$)")
	canvasAssetImage  = regexp.MustCompile(`\(document-asset:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\)`)
	canvasAssetURL    = regexp.MustCompile(`^document-asset:([A-Za-z0-9][A-Za-z0-9_-]{0,63})$`)
	// An inline image as goldmark renders it, capturing the Asset its Content-ID names.
	mailInlineImage = regexp.MustCompile(`<img src="cid:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.[0-9a-f]{8}@linger"`)
	// ErrMailRawHTML reports mail Markdown that contains raw HTML.
	ErrMailRawHTML = errors.New("raw HTML in mail Markdown")
)

// defaultMailImageWidth is the usual email body width, for images the canvas
// shows at their natural size.
const defaultMailImageWidth = 600

// CanvasDraftError is a canvas that cannot become a Gmail draft; path names
// the request field at fault, or is empty for the canvas as a whole.
type CanvasDraftError struct{ Path, Code, Message string }

func (e *CanvasDraftError) Error() string { return e.Message }

// CanvasDraft is a canvas built as a Gmail draft.
type CanvasDraft struct {
	Raw string
	// InlineImages counts the images shown in the body.
	InlineImages int
	// Attachments names the files the email carries, in canvas order.
	Attachments []string
}

// GmailCanvasDraftRaw builds the Gmail draft of a canvas: its images show in
// the body and its file blocks go as attachments. Recipients and subject left
// nil come from the canvas header.
func (s *Canvas) GmailCanvasDraftRaw(ctx context.Context, tenantID, agentID, documentID string, to, cc *[]string, subject *string) (CanvasDraft, error) {
	blocks, err := s.canvasBlocks(ctx, tenantID, agentID, documentID)
	if err != nil {
		return CanvasDraft{}, err
	}
	header, isCanvas := ReadCanvasHeader(blocks)
	if to == nil || cc == nil || subject == nil {
		if !isCanvas || header.Target != "gmail" {
			return CanvasDraft{}, &CanvasDraftError{"document_id", "not_gmail_canvas", "This Document is not a Gmail canvas; pass --to, --cc and --subject"}
		}
		if to == nil {
			to = commaList(header.Fields["to"])
		}
		if cc == nil {
			cc = commaList(header.Fields["cc"])
		}
		if subject == nil {
			subject = ptr(header.Fields["subject"])
		}
	}
	// A draft may have no recipients yet; Gmail requires them only to send.
	if strings.TrimSpace(*subject) == "" {
		return CanvasDraft{}, &CanvasDraftError{"subject", "subject_required", "The canvas needs a subject; fill it in or pass --subject"}
	}
	markdown, err := s.canvasMarkdown(ctx, tenantID, agentID, documentID, isCanvas)
	if err != nil {
		return CanvasDraft{}, err
	}
	// File blocks become attachments; their link lines leave the body.
	files := canvasFileAssets(blocks)
	attachments := []MailAttachment{}
	attached := 0
	for _, assetID := range files {
		markdown = regexp.MustCompile(`(?m)^[ \t]*\[[^\n]*\]\(document-asset:`+regexp.QuoteMeta(assetID)+`\)[ \t]*\n?`).ReplaceAllString(markdown, "")
		data, asset, err := s.assetBytes(ctx, tenantID, agentID, documentID, assetID, MaxMailAttachmentBytes)
		if err != nil {
			return CanvasDraft{}, err
		}
		attached += len(data)
		if attached > MaxMailAttachmentBytes {
			return CanvasDraft{}, &CanvasDraftError{Message: "Canvas attachments exceed 15 MiB in total; remove or shrink some first"}
		}
		attachments = append(attachments, MailAttachment{Filename: asset.Filename, MediaType: asset.MediaType, Bytes: data})
	}
	images := []InlineImage{}
	contentIDs := map[string]string{}
	total := 0
	for _, match := range canvasAssetImage.FindAllStringSubmatch(markdown, -1) {
		assetID := match[1]
		if _, seen := contentIDs[assetID]; seen {
			continue
		}
		data, asset, err := s.assetBytes(ctx, tenantID, agentID, documentID, assetID, document.MaxAgentAssetBytes)
		if err != nil {
			return CanvasDraft{}, err
		}
		if !strings.HasPrefix(asset.MediaType, "image/") {
			return CanvasDraft{}, &CanvasDraftError{Message: "Canvas shows " + asset.Filename + " as an image, but it is not one; put it in a file block to attach it"}
		}
		contentIDs[assetID] = NewInlineContentID(assetID)
		image := CompactInlineImage(InlineImage{
			ContentID: contentIDs[assetID], Filename: asset.Filename,
			MediaType: asset.MediaType, Bytes: data,
		})
		total += len(image.Bytes)
		if total > MaxInlineImageBytes {
			return CanvasDraft{}, &CanvasDraftError{Message: "Canvas images exceed 5 MiB in total; make them smaller first"}
		}
		images = append(images, image)
	}
	markdown = canvasAssetImage.ReplaceAllStringFunc(markdown, func(reference string) string {
		return "(cid:" + contentIDs[canvasAssetImage.FindStringSubmatch(reference)[1]] + ")"
	})
	html, err := MailMarkdownHTML(markdown)
	if err != nil {
		return CanvasDraft{}, &CanvasDraftError{Message: "Canvas body could not be converted to an email"}
	}
	if len(images) > 0 {
		html = sizeMailImages(html, canvasImageWidths(blocks))
	}
	raw, err := BuildGmailDraftRaw(GmailDraftMessage{
		To: *to, Cc: *cc, Subject: *subject, HTML: html, Images: images, Attachments: attachments,
	})
	switch {
	case errors.Is(err, ErrMailRecipients):
		return CanvasDraft{}, &CanvasDraftError{"to", "invalid_recipients", "Recipients must be plain email addresses separated by commas"}
	case errors.Is(err, ErrMailTooLarge):
		return CanvasDraft{}, &CanvasDraftError{Message: "Canvas images or attachments are too large for one email"}
	case err != nil:
		return CanvasDraft{}, &CanvasDraftError{Message: "Canvas could not be built as an email: the subject must be one line and the body must not be empty"}
	}
	names := make([]string, len(attachments))
	for i, attachment := range attachments {
		names[i] = attachment.Filename
	}
	return CanvasDraft{Raw: raw, InlineImages: len(images), Attachments: names}, nil
}

// assetBytes reads one canvas Asset, at most limit bytes.
func (s *Canvas) assetBytes(ctx context.Context, tenantID, agentID, documentID, assetID string, limit int) ([]byte, document.Asset, error) {
	content, err := s.documents.OpenAgentAssetContent(ctx, tenantID, agentID, documentID, assetID)
	if err != nil {
		return nil, document.Asset{}, err
	}
	defer func() { _ = content.Reader.Close() }()
	data, err := io.ReadAll(io.LimitReader(content.Reader, int64(limit)+1))
	if err != nil {
		return nil, document.Asset{}, err
	}
	if len(data) > limit {
		return nil, document.Asset{}, &CanvasDraftError{Message: content.Asset.Filename + " is too large for an email"}
	}
	return data, content.Asset, nil
}

// canvasFileAssets lists the Assets of the canvas's file, video and audio
// blocks, in order and once each: what the email attaches.
func canvasFileAssets(blocks []CanvasBlock) []string {
	assets := []string{}
	seen := map[string]bool{}
	var visit func([]CanvasBlock)
	visit = func(blocks []CanvasBlock) {
		for _, block := range blocks {
			if block.Type == "file" || block.Type == "video" || block.Type == "audio" {
				if match := canvasAssetURL.FindStringSubmatch(block.Props.URL); match != nil && !seen[match[1]] {
					seen[match[1]] = true
					assets = append(assets, match[1])
				}
			}
			visit(block.Children)
		}
	}
	visit(blocks)
	return assets
}

// CanvasExport reads the canvas in one export format, up to 1 MiB.
func (s *Canvas) CanvasExport(ctx context.Context, tenantID, agentID, documentID, format string) ([]byte, error) {
	download, err := s.documents.DownloadAgentFileAs(ctx, tenantID, agentID, documentID, format)
	if err != nil {
		return nil, err
	}
	content := download.InlineBytes
	if content == nil {
		object, err := s.artifacts.Open(ctx, download.ObjectKey)
		if err != nil {
			return nil, err
		}
		defer func() { _ = object.Close() }()
		if content, err = io.ReadAll(io.LimitReader(object, 1<<20+1)); err != nil {
			return nil, err
		}
	}
	if len(content) > 1<<20 {
		return nil, document.ErrInvalidInput
	}
	return content, nil
}

// canvasBlocks reads the canvas as blocks, for its header and image widths.
func (s *Canvas) canvasBlocks(ctx context.Context, tenantID, agentID, documentID string) ([]CanvasBlock, error) {
	content, err := s.CanvasExport(ctx, tenantID, agentID, documentID, "blocks")
	if err != nil {
		return nil, err
	}
	var export struct {
		Blocks []CanvasBlock `json:"blocks"`
	}
	if err := json.Unmarshal(content, &export); err != nil {
		return nil, document.ErrInvalidInput
	}
	return export.Blocks, nil
}

// CanvasHeader is the header code block of a canvas: its target app and fields.
type CanvasHeader struct {
	Target string
	Fields map[string]string
}

// ReadCanvasHeader reads the canvas header from the first block, a code block,
// as Web does: later fields replace earlier ones, unknown fields are kept.
func ReadCanvasHeader(blocks []CanvasBlock) (CanvasHeader, bool) {
	if len(blocks) == 0 || blocks[0].Type != "codeBlock" {
		return CanvasHeader{}, false
	}
	var items []struct {
		Text string `json:"text"`
	}
	var text strings.Builder
	if json.Unmarshal(blocks[0].Content, &items) == nil {
		for _, item := range items {
			text.WriteString(item.Text)
		}
	}
	lines := strings.Split(text.String(), "\n")
	match := canvasHeaderLine.FindStringSubmatch(strings.TrimSpace(lines[0]))
	if match == nil {
		return CanvasHeader{}, false
	}
	header := CanvasHeader{Target: strings.ToLower(match[1]), Fields: map[string]string{}}
	for _, line := range lines[1:] {
		if field := canvasFieldLine.FindStringSubmatch(strings.TrimSpace(line)); field != nil {
			header.Fields[strings.ToLower(field[1])] = strings.TrimSpace(field[2])
		}
	}
	return header, true
}

// commaList splits a header address field; commas are the only separator.
func commaList(value string) *[]string {
	list := []string{}
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			list = append(list, item)
		}
	}
	return &list
}

// canvasImageWidths maps each canvas image's Asset to the width it shows at in
// the canvas, so the email shows it at the same size.
func canvasImageWidths(blocks []CanvasBlock) map[string]int {
	widths := map[string]int{}
	var visit func([]CanvasBlock)
	visit = func(blocks []CanvasBlock) {
		for _, block := range blocks {
			if block.Type == "image" && block.Props.PreviewWidth > 0 {
				if match := canvasAssetURL.FindStringSubmatch(block.Props.URL); match != nil {
					widths[match[1]] = int(block.Props.PreviewWidth)
				}
			}
			visit(block.Children)
		}
	}
	visit(blocks)
	return widths
}

// CanvasBlock is one block of a canvas Document as its block export writes it.
type CanvasBlock struct {
	Type  string `json:"type"`
	Props struct {
		URL          string  `json:"url"`
		PreviewWidth float64 `json:"previewWidth"`
	} `json:"props"`
	// Content is inline text, or table content in another shape.
	Content  json.RawMessage `json:"content"`
	Children []CanvasBlock   `json:"children"`
}

// sizeMailImages gives each inline image the width it has in the canvas, or the
// usual email body width when the canvas leaves it at its natural size, and
// never wider than the email.
func sizeMailImages(html string, widths map[string]int) string {
	return mailInlineImage.ReplaceAllStringFunc(html, func(tag string) string {
		width := defaultMailImageWidth
		if canvas, ok := widths[mailInlineImage.FindStringSubmatch(tag)[1]]; ok {
			width = canvas
		}
		return strings.Replace(tag, "<img ",
			`<img width="`+strconv.Itoa(width)+`" style="max-width:100%;height:auto" `, 1)
	})
}

// canvasMarkdown is the canvas body: the current Markdown without its header block.
func (s *Canvas) canvasMarkdown(ctx context.Context, tenantID, agentID, documentID string, hasHeader bool) (string, error) {
	content, err := s.CanvasExport(ctx, tenantID, agentID, documentID, "markdown")
	if err != nil {
		return "", err
	}
	body := string(content)
	if hasHeader {
		body = CanvasHeaderFence.ReplaceAllString(body, "")
	}
	if strings.TrimSpace(body) == "" {
		return "", document.ErrInvalidInput
	}
	return body, nil
}

// MailMarkdownHTML converts mail Markdown with GFM and rejects raw HTML.
func MailMarkdownHTML(content string) (string, error) {
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
	parsed := parser.Parser().Parse(gmtext.NewReader([]byte(content)))
	containsHTML := false
	_ = ast.Walk(parsed, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch node.(type) {
			case *ast.RawHTML, *ast.HTMLBlock:
				containsHTML = true
			}
		}
		return ast.WalkContinue, nil
	})
	if containsHTML {
		return "", ErrMailRawHTML
	}
	var output bytes.Buffer
	if err := parser.Convert([]byte(content), &output); err != nil {
		return "", err
	}
	return output.String(), nil
}

func ptr[T any](value T) *T { return &value }

// Canvas reads a Document canvas the way the Gmail draft and the live voice
// see it: its header, blocks and Markdown with inline images.
type Canvas struct {
	documents *document.Service
	artifacts artifactstore.ObjectStore
}

// NewCanvas builds the canvas reader.
func NewCanvas(documents *document.Service, artifacts artifactstore.ObjectStore) *Canvas {
	return &Canvas{documents: documents, artifacts: artifacts}
}
