package agentconnectedapps

import (
	"bytes"
	"encoding/base64"
	"errors"
	stdimage "image"
	"image/jpeg"
	"image/png"
	"io"
	"math/rand/v2"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
)

func TestBuildGmailDraftRawEmbedsImagesInline(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nimage-bytes")
	raw, err := BuildGmailDraftRaw(GmailDraftMessage{
		To: []string{"lisa@acme.example"}, Cc: []string{"Sam <sam@acme.example>"},
		Subject: "Café chez nous la semaine prochaine", HTML: `<p>Hi</p><img src="cid:card.1@linger">`,
		Images: []InlineImage{{ContentID: "card.1@linger", Filename: "card.png", MediaType: "image/png", Bytes: png}},
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.URLEncoding.DecodeString(raw)
	if err != nil {
		t.Fatal(err)
	}
	message, err := mail.ReadMessage(bytes.NewReader(decoded))
	if err != nil {
		t.Fatal(err)
	}
	if message.Header.Get("To") != "<lisa@acme.example>" || message.Header.Get("Cc") != `"Sam" <sam@acme.example>` {
		t.Fatalf("recipients To=%q Cc=%q", message.Header.Get("To"), message.Header.Get("Cc"))
	}
	if subject, _ := new(mime.WordDecoder).DecodeHeader(message.Header.Get("Subject")); subject != "Café chez nous la semaine prochaine" {
		t.Fatalf("subject=%q", subject)
	}
	mediaType, params, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/related" {
		t.Fatalf("content type %q: %v", mediaType, err)
	}
	reader := multipart.NewReader(message.Body, params["boundary"])
	html, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	htmlBody, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, stripLines(html)))
	if !strings.HasPrefix(html.Header.Get("Content-Type"), "text/html") ||
		!strings.Contains(string(htmlBody), `src="cid:card.1@linger"`) {
		t.Fatalf("html part %q: %s", html.Header.Get("Content-Type"), htmlBody)
	}
	image, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	imageBody, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, stripLines(image)))
	if image.Header.Get("Content-ID") != "<card.1@linger>" ||
		!strings.HasPrefix(image.Header.Get("Content-Disposition"), "inline") ||
		!bytes.Equal(imageBody, png) {
		t.Fatalf("image part headers=%v body=%q", image.Header, imageBody)
	}
	if _, err := reader.NextPart(); err != io.EOF {
		t.Fatalf("unexpected extra part: %v", err)
	}
}

func TestBuildGmailDraftRawRejectsInvalidMessages(t *testing.T) {
	valid := GmailDraftMessage{To: []string{"lisa@acme.example"}, Subject: "Hi", HTML: "<p>Hi</p>"}
	for name, change := range map[string]func(*GmailDraftMessage){
		"bad address":       func(m *GmailDraftMessage) { m.To = []string{"not an address"} },
		"multiline subject": func(m *GmailDraftMessage) { m.Subject = "a\nBcc: x@y.example" },
		"empty body":        func(m *GmailDraftMessage) { m.HTML = " " },
		"header injection": func(m *GmailDraftMessage) {
			m.Images = []InlineImage{{ContentID: "a>\r\nX: y", MediaType: "image/png"}}
		},
		"too large": func(m *GmailDraftMessage) {
			m.Images = []InlineImage{{ContentID: "big", MediaType: "image/png", Bytes: make([]byte, MaxInlineImageBytes+1)}}
		},
	} {
		message := valid
		change(&message)
		if _, err := BuildGmailDraftRaw(message); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	if _, err := BuildGmailDraftRaw(valid); err != nil {
		t.Fatalf("valid message rejected: %v", err)
	}
	// A draft may have no recipients yet.
	valid.To = nil
	raw, err := BuildGmailDraftRaw(valid)
	if err != nil {
		t.Fatalf("draft without recipients rejected: %v", err)
	}
	decoded, _ := base64.URLEncoding.DecodeString(raw)
	if message, err := mail.ReadMessage(bytes.NewReader(decoded)); err != nil || message.Header.Get("To") != "" {
		t.Fatalf("draft without recipients has To=%q err=%v", message.Header.Get("To"), err)
	}
}

func stripLines(reader io.Reader) io.Reader {
	content, _ := io.ReadAll(reader)
	return strings.NewReader(strings.NewReplacer("\r", "", "\n", "").Replace(string(content)))
}

func TestCompactInlineImageShrinksLargeImagesOnly(t *testing.T) {
	// Noise does not compress, so the PNG is well above the threshold.
	source := stdimage.NewNRGBA(stdimage.Rect(0, 0, 600, 400))
	random := rand.New(rand.NewPCG(1, 2))
	for i := range source.Pix {
		source.Pix[i] = byte(random.UintN(256))
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	large := InlineImage{ContentID: "card.1@linger", Filename: "card.png", MediaType: "image/png", Bytes: encoded.Bytes()}
	compact := CompactInlineImage(large)
	if compact.MediaType != "image/jpeg" || compact.Filename != "card.jpg" || len(compact.Bytes) >= len(large.Bytes) {
		t.Fatalf("compact=%s %s %d bytes from %d", compact.MediaType, compact.Filename, len(compact.Bytes), len(large.Bytes))
	}
	if _, err := jpeg.Decode(bytes.NewReader(compact.Bytes)); err != nil {
		t.Fatalf("compact image is not a JPEG: %v", err)
	}
	small := InlineImage{MediaType: "image/png", Bytes: []byte("\x89PNG\r\n\x1a\nsmall")}
	if got := CompactInlineImage(small); !bytes.Equal(got.Bytes, small.Bytes) || got.MediaType != "image/png" {
		t.Fatal("a small image was re-encoded")
	}
	gif := InlineImage{MediaType: "image/gif", Bytes: bytes.Repeat([]byte{1}, compactImageThreshold+1)}
	if got := CompactInlineImage(gif); got.MediaType != "image/gif" {
		t.Fatal("a GIF, which may be animated, was re-encoded")
	}
}

func TestBuildGmailDraftRawAttachesFilesBesideTheBody(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nimage-bytes")
	pdf := []byte("%PDF-1.7 plan")
	raw, err := BuildGmailDraftRaw(GmailDraftMessage{
		To: []string{"lisa@acme.example"}, Subject: "Plan", HTML: `<p>Hi</p><img src="cid:card.1@linger">`,
		Images:      []InlineImage{{ContentID: "card.1@linger", Filename: "card.png", MediaType: "image/png", Bytes: png}},
		Attachments: []MailAttachment{{Filename: "プラン v2.pdf", MediaType: "application/pdf", Bytes: pdf}},
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := base64.URLEncoding.DecodeString(raw)
	message, err := mail.ReadMessage(bytes.NewReader(decoded))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, params, _ := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if mediaType != "multipart/mixed" {
		t.Fatalf("content type %q", mediaType)
	}
	mixed := multipart.NewReader(message.Body, params["boundary"])
	body, err := mixed.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	relatedType, relatedParams, _ := mime.ParseMediaType(body.Header.Get("Content-Type"))
	if relatedType != "multipart/related" {
		t.Fatalf("body part %q", relatedType)
	}
	related := multipart.NewReader(body, relatedParams["boundary"])
	for _, want := range []string{"text/html", "image/png"} {
		part, err := related.NextPart()
		if err != nil || !strings.HasPrefix(part.Header.Get("Content-Type"), want) {
			t.Fatalf("related part %v want %s: %v", part, want, err)
		}
	}
	attachment, err := mixed.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	disposition, dispositionParams, _ := mime.ParseMediaType(attachment.Header.Get("Content-Disposition"))
	content, _ := io.ReadAll(base64.NewDecoder(base64.StdEncoding, stripLines(attachment)))
	if disposition != "attachment" || dispositionParams["filename"] != "プラン v2.pdf" ||
		!strings.HasPrefix(attachment.Header.Get("Content-Type"), "application/pdf") || !bytes.Equal(content, pdf) {
		t.Fatalf("attachment headers=%v body=%q", attachment.Header, content)
	}
	if _, err := mixed.NextPart(); err != io.EOF {
		t.Fatalf("unexpected extra part: %v", err)
	}
}

func TestBuildGmailDraftRawNamesWhatIsWrong(t *testing.T) {
	valid := GmailDraftMessage{To: []string{"lisa@acme.example"}, Subject: "Hi", HTML: "<p>Hi</p>"}
	bad := valid
	bad.To = []string{"lisa@acme.example; sam@acme.example"}
	if _, err := BuildGmailDraftRaw(bad); !errors.Is(err, ErrMailRecipients) {
		t.Fatalf("recipients err=%v", err)
	}
	large := valid
	large.Attachments = []MailAttachment{{Filename: "big.zip", MediaType: "application/zip", Bytes: make([]byte, MaxMailAttachmentBytes+1)}}
	if _, err := BuildGmailDraftRaw(large); !errors.Is(err, ErrMailTooLarge) || errors.Is(err, ErrMailRecipients) {
		t.Fatalf("too large err=%v", err)
	}
	injected := valid
	injected.Attachments = []MailAttachment{{Filename: "a.pdf\r\nBcc: x@y.example", MediaType: "application/pdf", Bytes: []byte("x")}}
	if _, err := BuildGmailDraftRaw(injected); !errors.Is(err, ErrInvalid) {
		t.Fatalf("header injection err=%v", err)
	}
}
