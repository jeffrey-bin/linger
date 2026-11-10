package agentconnectedapps

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	stdimage "image"
	"image/draw"
	"image/jpeg"
	_ "image/png" // decode PNG inline images
	"mime"
	"mime/multipart"
	"net/mail"
	"net/textproto"
	"path"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// Gmail web drops base64 images inside HTML, so images travel as inline
// parts of a multipart/related message referenced from the HTML by cid.
const MaxInlineImageBytes = 5 << 20

// MaxMailAttachmentBytes bounds a draft's file attachments in total. The draft
// travels as one raw message through the provider proxy, well under Gmail's
// 25 MB message limit once base64 encoded.
const MaxMailAttachmentBytes = 15 << 20

var (
	// ErrMailRecipients reports a recipient that is not a plain email address.
	ErrMailRecipients = fmt.Errorf("%w: recipients", ErrInvalid)
	// ErrMailTooLarge reports images or attachments over their size limit.
	ErrMailTooLarge = fmt.Errorf("%w: too large", ErrInvalid)
)

type InlineImage struct {
	ContentID, Filename, MediaType string
	Bytes                          []byte
}

// MailAttachment is a file the email carries as an attachment.
type MailAttachment struct {
	Filename, MediaType string
	Bytes               []byte
}

type GmailDraftMessage struct {
	To, Cc      []string
	Subject     string
	HTML        string
	Images      []InlineImage
	Attachments []MailAttachment
}

type gmailDraftProvider interface {
	SaveGmailDraft(ctx context.Context, connectedAccountID, draftID, raw string) (composio.GmailDraft, error)
}

// BuildGmailDraftRaw returns the message in Gmail's raw form (base64url).
func BuildGmailDraftRaw(message GmailDraftMessage) (string, error) {
	addresses := func(values []string) (string, error) {
		parsed := make([]string, 0, len(values))
		for _, value := range values {
			address, err := mail.ParseAddress(strings.TrimSpace(value))
			if err != nil {
				return "", ErrInvalid
			}
			parsed = append(parsed, address.String())
		}
		return strings.Join(parsed, ", "), nil
	}
	// A draft may have no recipients yet; Gmail requires them only to send.
	to, err := addresses(message.To)
	if err != nil {
		return "", ErrMailRecipients
	}
	cc, err := addresses(message.Cc)
	if err != nil {
		return "", ErrMailRecipients
	}
	subject := strings.TrimSpace(message.Subject)
	if subject == "" || strings.ContainsAny(subject, "\r\n") || strings.TrimSpace(message.HTML) == "" {
		return "", ErrInvalid
	}
	total := 0
	for _, image := range message.Images {
		total += len(image.Bytes)
		if image.ContentID == "" || strings.ContainsAny(image.ContentID, "<>\r\n \"") ||
			!strings.HasPrefix(image.MediaType, "image/") {
			return "", ErrInvalid
		}
	}
	if total > MaxInlineImageBytes {
		return "", ErrMailTooLarge
	}
	attached := 0
	for _, attachment := range message.Attachments {
		attached += len(attachment.Bytes)
		if strings.TrimSpace(attachment.Filename) == "" || strings.ContainsAny(attachment.Filename, "\r\n") {
			return "", ErrInvalid
		}
		if _, _, err := mime.ParseMediaType(attachment.MediaType); err != nil {
			return "", ErrInvalid
		}
	}
	if attached > MaxMailAttachmentBytes {
		return "", ErrMailTooLarge
	}
	// The body and its inline images are one multipart/related part.
	var related bytes.Buffer
	parts := multipart.NewWriter(&related)
	html, err := parts.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"text/html; charset=UTF-8"},
		"Content-Transfer-Encoding": {"base64"},
	})
	if err != nil {
		return "", err
	}
	if err := writeBase64Lines(html, []byte(message.HTML)); err != nil {
		return "", err
	}
	for _, image := range message.Images {
		filename := image.Filename
		if filename == "" {
			filename = image.ContentID
		}
		part, err := parts.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {mime.FormatMediaType(image.MediaType, map[string]string{"name": filename})},
			"Content-Transfer-Encoding": {"base64"},
			"Content-ID":                {"<" + image.ContentID + ">"},
			"Content-Disposition":       {mime.FormatMediaType("inline", map[string]string{"filename": filename})},
		})
		if err != nil {
			return "", err
		}
		if err := writeBase64Lines(part, image.Bytes); err != nil {
			return "", err
		}
	}
	if err := parts.Close(); err != nil {
		return "", err
	}
	relatedType := fmt.Sprintf("multipart/related; type=\"text/html\"; boundary=%q", parts.Boundary())
	var header bytes.Buffer
	if to != "" {
		fmt.Fprintf(&header, "To: %s\r\n", to)
	}
	if cc != "" {
		fmt.Fprintf(&header, "Cc: %s\r\n", cc)
	}
	fmt.Fprintf(&header, "Subject: %s\r\nMIME-Version: 1.0\r\n", mime.BEncoding.Encode("UTF-8", subject))
	if len(message.Attachments) == 0 {
		fmt.Fprintf(&header, "Content-Type: %s\r\n\r\n", relatedType)
		return base64.URLEncoding.EncodeToString(append(header.Bytes(), related.Bytes()...)), nil
	}
	// Attachments sit beside the body in multipart/mixed.
	var body bytes.Buffer
	mixed := multipart.NewWriter(&body)
	fmt.Fprintf(&header, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", mixed.Boundary())
	part, err := mixed.CreatePart(textproto.MIMEHeader{"Content-Type": {relatedType}})
	if err != nil {
		return "", err
	}
	if _, err := part.Write(related.Bytes()); err != nil {
		return "", err
	}
	for _, attachment := range message.Attachments {
		part, err := mixed.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {mime.FormatMediaType(attachment.MediaType, map[string]string{"name": attachment.Filename})},
			"Content-Transfer-Encoding": {"base64"},
			"Content-Disposition":       {mime.FormatMediaType("attachment", map[string]string{"filename": attachment.Filename})},
		})
		if err != nil {
			return "", err
		}
		if err := writeBase64Lines(part, attachment.Bytes); err != nil {
			return "", err
		}
	}
	if err := mixed.Close(); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(append(header.Bytes(), body.Bytes()...)), nil
}

func writeBase64Lines(writer interface{ Write([]byte) (int, error) }, content []byte) error {
	encoded := base64.StdEncoding.EncodeToString(content)
	for len(encoded) > 76 {
		if _, err := writer.Write([]byte(encoded[:76] + "\r\n")); err != nil {
			return err
		}
		encoded = encoded[76:]
	}
	_, err := writer.Write([]byte(encoded + "\r\n"))
	return err
}

// SaveGmailDraft saves raw as a draft on a Gmail connection the Agent may use,
// under the same grant and connection checks as tool execution. It never sends.
func (s *Service) SaveGmailDraft(ctx context.Context, token, connectionID, draftID, raw string) (draft composio.GmailDraft, err error) {
	connectionID = strings.TrimSpace(connectionID)
	if !connectionIDPattern.MatchString(connectionID) || raw == "" || len(draftID) > 256 {
		return composio.GmailDraft{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.contexts == nil || s.connections == nil {
		return composio.GmailDraft{}, unavailableError(nil)
	}
	provider, ok := s.provider.(gmailDraftProvider)
	if !ok {
		return composio.GmailDraft{}, unavailableError(nil)
	}
	connection, err := s.authorizeExecution(ctx, token, connectionID)
	if err != nil {
		return composio.GmailDraft{}, err
	}
	if connection.ToolkitSlug != "gmail" {
		return composio.GmailDraft{}, ErrInvalid
	}
	defer func() { s.logCall(ctx, "gmail/canvas-draft", connection, "", "", callOutcome(err)) }()
	status, err := s.provider.GetConnectionStatusForToolkit(ctx, connection.UpstreamConnectionID, connection.ToolkitSlug)
	if err != nil {
		return composio.GmailDraft{}, mapToolError(&providerOperationError{phase: "connection_status", err: err}, "execute")
	}
	if status != composio.ConnectionActive {
		return composio.GmailDraft{}, mapToolError(externalsource.ErrNotActive, "execute")
	}
	current, err := s.authorizeExecution(ctx, token, connectionID)
	if err != nil {
		return composio.GmailDraft{}, err
	}
	if current != connection {
		return composio.GmailDraft{}, mapToolError(externalsource.ErrNotActive, "execute")
	}
	draft, err = provider.SaveGmailDraft(ctx, connection.UpstreamConnectionID, draftID, raw)
	if err != nil {
		return composio.GmailDraft{}, uncertainExecutionError(err)
	}
	return draft, nil
}

// AgentPrincipal returns who is calling, for reading the canvas they draft from.
func (s *Service) AgentPrincipal(ctx context.Context, token string) (agentauth.Authorization, error) {
	if s == nil || s.contexts == nil {
		return agentauth.Authorization{}, unavailableError(nil)
	}
	return s.contexts.Authorize(ctx, token, "execute_app_tool")
}

// compactImageThreshold is where an inline image is re-encoded: model-generated
// PNGs of 2-3 MB make the draft too large for the provider proxy to accept in time.
const compactImageThreshold = 512 << 10

// CompactInlineImage re-encodes a large PNG or JPEG as a JPEG for the email,
// flattening transparency onto white. Other images, and images the re-encoding
// would not shrink, are returned unchanged.
func CompactInlineImage(image InlineImage) InlineImage {
	if len(image.Bytes) <= compactImageThreshold ||
		(image.MediaType != "image/png" && image.MediaType != "image/jpeg") {
		return image
	}
	source, _, err := stdimage.Decode(bytes.NewReader(image.Bytes))
	if err != nil {
		return image
	}
	flat := stdimage.NewRGBA(source.Bounds())
	draw.Draw(flat, flat.Bounds(), stdimage.White, stdimage.Point{}, draw.Src)
	draw.Draw(flat, flat.Bounds(), source, source.Bounds().Min, draw.Over)
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, flat, &jpeg.Options{Quality: 85}); err != nil || encoded.Len() >= len(image.Bytes) {
		return image
	}
	image.Bytes, image.MediaType = encoded.Bytes(), "image/jpeg"
	if image.Filename != "" {
		image.Filename = strings.TrimSuffix(image.Filename, path.Ext(image.Filename)) + ".jpg"
	}
	return image
}

// NewInlineContentID returns a Content-ID unique to one message.
func NewInlineContentID(assetID string) string {
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	return assetID + "." + hex.EncodeToString(suffix) + "@linger"
}
