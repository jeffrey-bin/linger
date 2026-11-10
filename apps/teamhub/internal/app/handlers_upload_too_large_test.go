package app

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// The multipart parser must surface *http.MaxBytesError so handlers map an
// oversized body to PAYLOAD_TOO_LARGE without matching error text.
func TestMultipartUploadsMapOversizedBodyToPayloadTooLarge(t *testing.T) {
	t.Parallel()
	const maxBytes = 16
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("filename", "big.md"); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("content", "big.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(strings.Repeat("x", maxBytes+(1<<20)+1))); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	contentType := writer.FormDataContentType()

	for name, handle := range map[string]func(*App, *gin.Context){
		"document":           func(a *App, c *gin.Context) { a.uploadDocumentToTarget(c, "key", "", "", "") },
		"document version":   func(a *App, c *gin.Context) { a.uploadDocumentVersion(c, "key") },
		"message attachment": func(a *App, c *gin.Context) { a.uploadMessageAttachment(c) },
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(recorder)
			context.Set("request_id", "request-upload-too-large")
			context.Request = httptest.NewRequest(http.MethodPost, "/upload", bytes.NewReader(body.Bytes()))
			context.Request.Header.Set("Content-Type", contentType)
			context.Request.Header.Set("Idempotency-Key", "upload-too-large-key")
			handle(&App{cfg: config.ForTest(func(c *config.Config) {
				c.ArtifactMaxBytes = maxBytes
			})}, context)
			if recorder.Code != http.StatusRequestEntityTooLarge || !strings.Contains(recorder.Body.String(), `"code":"PAYLOAD_TOO_LARGE"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
