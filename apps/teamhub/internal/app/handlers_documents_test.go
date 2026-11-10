package app

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentModelProjectsWikiPageKey(t *testing.T) {
	model := documentModel(document.Document{From: []document.Source{
		{BindingKind: "wiki_page", ContextID: "wiki-personal", Label: "Personal Wiki", PageKey: "projects/lev8.md"},
		{BindingKind: "room", ContextID: "room-1", Label: "Room"},
	}})
	if model.From[0].PageKey == nil || *model.From[0].PageKey != "projects/lev8.md" {
		t.Fatalf("wiki page key=%v want projects/lev8.md", model.From[0].PageKey)
	}
	if model.From[1].PageKey != nil {
		t.Fatalf("non-Wiki page key=%v want nil", *model.From[1].PageKey)
	}
}

func TestParseDocumentUploadRejectsUnknownOrRepeatedMultipartFields(t *testing.T) {
	tests := []struct {
		name        string
		fields      map[string][]string
		contentName string
		wantInvalid bool
	}{
		{name: "valid", fields: documentUploadFields(), contentName: "content"},
		{name: "unknown value", fields: map[string][]string{
			"filename": {"file.txt"}, "representation_format": {"plain_text"},
			"media_type": {"text/plain"}, "unknown": {"rejected"},
		}, contentName: "content", wantInvalid: true},
		{name: "repeated filename", fields: map[string][]string{
			"filename": {"file.txt", "other.txt"}, "representation_format": {"plain_text"},
			"media_type": {"text/plain"},
		}, contentName: "content", wantInvalid: true},
		{name: "unknown file", fields: documentUploadFields(), contentName: "attachment", wantInvalid: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context := documentUploadMultipartContext(t, test.fields, test.contentName)
			upload, err := (&App{cfg: config.ForTest(func(c *config.Config) {
				c.ArtifactMaxBytes = 1 << 20
			})}).parseDocumentUpload(context)
			if context.Request.MultipartForm != nil {
				t.Cleanup(func() { _ = context.Request.MultipartForm.RemoveAll() })
			}
			if test.wantInvalid {
				if !errors.Is(err, document.ErrInvalidInput) {
					t.Fatalf("parse error=%v want ErrInvalidInput", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = upload.Content.Close() })
			if upload.Filename != "file.txt" || upload.RepresentationFormat != "plain_text" || upload.MediaType != "text/plain" {
				t.Fatalf("upload=%+v", upload)
			}
		})
	}
}

func TestUploadParsersExtendServerReadDeadline(t *testing.T) {
	tests := []struct {
		name      string
		fields    map[string][]string
		fileField string
		parse     func(*App, *gin.Context) (io.Reader, error)
	}{
		{
			name:   "Document upload",
			fields: documentUploadFields(),
			parse: func(app *App, context *gin.Context) (io.Reader, error) {
				upload, err := app.parseDocumentUpload(context)
				return upload.Content, err
			},
		},
		{
			name: "Document Version upload",
			fields: map[string][]string{
				"expected_current_version_id": {"document-version-current"},
				"filename":                    {"file.txt"},
				"representation_format":       {"plain_text"},
				"media_type":                  {"text/plain"},
			},
			parse: func(app *App, context *gin.Context) (io.Reader, error) {
				upload, _, err := app.parseDocumentVersionUpload(context)
				return upload.Content, err
			},
		},
		{
			name:   "Message attachment upload",
			fields: map[string][]string{"filename": {"file.txt"}, "media_type": {"text/plain"}},
			parse: func(app *App, context *gin.Context) (io.Reader, error) {
				upload, err := app.parseMessageAttachmentUpload(context)
				return upload.Content, err
			},
		},
		{
			name:      "Skill package upload",
			fileField: "package",
			parse: func(app *App, context *gin.Context) (io.Reader, error) {
				// The bytes are not a package; reaching package parsing means the
				// whole body arrived after the server read timeout.
				if _, err := app.parseAgentSkillPackageUpload(context); errors.Is(err, agentregistry.ErrSkillPackageTooLarge) {
					return nil, err
				}
				return strings.NewReader("slow-content"), nil
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reader, writer := io.Pipe()
			defer reader.Close()
			form := multipart.NewWriter(writer)
			application := &App{cfg: config.ForTest(func(c *config.Config) {
				c.ArtifactMaxBytes = 1 << 20
				c.SkillPackageMaxArchiveBytes = 1 << 20
			})}
			router := gin.New()
			router.POST("/uploads", func(context *gin.Context) {
				content, err := test.parse(application, context)
				if context.Request.MultipartForm != nil {
					defer context.Request.MultipartForm.RemoveAll()
				}
				if err != nil {
					context.String(http.StatusBadRequest, "%v", err)
					return
				}
				if closer, ok := content.(io.Closer); ok {
					defer closer.Close()
				}
				body, err := io.ReadAll(content)
				if err != nil {
					context.String(http.StatusInternalServerError, "%v", err)
					return
				}
				context.Data(http.StatusOK, "application/octet-stream", body)
			})

			server := httptest.NewUnstartedServer(router)
			server.Config.ReadTimeout = 50 * time.Millisecond
			server.Start()
			defer server.Close()

			request, err := http.NewRequest(http.MethodPost, server.URL+"/uploads", reader)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", form.FormDataContentType())
			writeResult := make(chan error, 1)
			go func() {
				writeResult <- writeDelayedMultipart(writer, form, test.fields, test.fileField, 150*time.Millisecond)
			}()

			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			responseBody, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			writeErr := <-writeResult
			if response.StatusCode != http.StatusOK {
				t.Fatalf("status=%d body=%s write_error=%v", response.StatusCode, responseBody, writeErr)
			}
			if writeErr != nil {
				t.Fatal(writeErr)
			}
			if string(responseBody) != "slow-content" {
				t.Fatalf("content=%q", responseBody)
			}
		})
	}
}

// writeDelayedMultipart writes fields and then a file part that pauses longer
// than the server read timeout. The file part defaults to a Document "content" file.
func writeDelayedMultipart(
	writer *io.PipeWriter,
	form *multipart.Writer,
	fields map[string][]string,
	fileField string,
	delay time.Duration,
) (resultErr error) {
	defer func() {
		if closeErr := writer.CloseWithError(resultErr); resultErr == nil {
			resultErr = closeErr
		}
	}()
	for name, values := range fields {
		for _, value := range values {
			if err := form.WriteField(name, value); err != nil {
				return err
			}
		}
	}
	if fileField == "" {
		fileField = "content"
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename="file.txt"`, fileField))
	header.Set("Content-Type", "application/octet-stream")
	part, err := form.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err = part.Write([]byte("slow-")); err != nil {
		return err
	}
	time.Sleep(delay)
	if _, err = part.Write([]byte("content")); err != nil {
		return err
	}
	return form.Close()
}

func documentUploadFields() map[string][]string {
	return map[string][]string{
		"filename": {"file.txt"}, "representation_format": {"plain_text"}, "media_type": {"text/plain"},
	}
}

func documentUploadMultipartContext(t *testing.T, fields map[string][]string, contentName string) *gin.Context {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, values := range fields {
		for _, value := range values {
			if err := writer.WriteField(name, value); err != nil {
				t.Fatal(err)
			}
		}
	}
	part, err := writer.CreateFormFile(contentName, "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write([]byte("content")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/documents/uploads", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = request
	return context
}

func TestWikiOversizedRefreshErrorAsksToRemoveSources(t *testing.T) {
	for _, testCase := range []struct {
		err  *document.WikiRefreshTooLargeError
		want []string
	}{
		{err: &document.WikiRefreshTooLargeError{EstimatedBytes: 348 << 20}, want: []string{"348 MiB", "256 MiB"}},
		{err: &document.WikiRefreshTooLargeError{ChangedSources: 1001}, want: []string{"1001 sources", "1000 limit"}},
	} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Set("request_id", "wiki-refresh-size-test")
		handled := (&App{}).writeMemoryWikiRefreshError(c, "refresh Wiki", testCase.err)
		if !handled || recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "WIKI_REFRESH_TOO_LARGE") ||
			!strings.Contains(recorder.Body.String(), testCase.want[0]) || !strings.Contains(recorder.Body.String(), testCase.want[1]) {
			t.Fatalf("unhelpful refresh size error: %d %s", recorder.Code, recorder.Body.String())
		}
	}
}
