package app

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/html/charset"
)

func TestDocumentPreviewAllowsPresentationInsideOpaqueSandbox(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	writeDocumentPreviewHeaders(context, immutableObjectContent{
		filename: "page.html", mediaType: "text/html", sha256: strings.Repeat("a", 64), sizeBytes: 42,
	})
	csp := response.Header().Get("Content-Security-Policy")
	for _, directive := range []string{
		"sandbox allow-scripts", "script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline' https:",
		"font-src 'self' data: https:", "connect-src 'self'", "frame-src 'none'",
	} {
		if !strings.Contains(csp, directive) {
			t.Fatalf("missing %q in preview CSP: %s", directive, csp)
		}
	}
	if strings.Contains(csp, "allow-same-origin") {
		t.Fatal("HTML preview must retain an opaque origin even when opened directly")
	}
}

func TestDocumentPreviewDecodesUTF8HTMLFragment(t *testing.T) {
	// Generated fragments can put more than 1024 bytes of CSS before the first non-ASCII text.
	fragment := "<style>" + strings.Repeat(" ", 1100) + "</style><div>Café déjà vu → Größe 🧭</div>"
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	writeDocumentPreviewHeaders(context, immutableObjectContent{
		filename: "visual-fragment.html", mediaType: "text/html", sha256: strings.Repeat("a", 64), sizeBytes: int64(len(fragment)),
	})
	if _, err := response.WriteString(fragment); err != nil {
		t.Fatal(err)
	}
	reader, err := charset.NewReader(response.Body, response.Header().Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != fragment {
		t.Fatalf("HTML preview decoded as %q, want %q", decoded, fragment)
	}
}

func TestDocumentPreviewContentType(t *testing.T) {
	for _, test := range []struct{ name, mediaType, want string }{
		{"HTML defaults to UTF-8", "text/html", "text/html; charset=utf-8"},
		{"HTML parameters retained", "Text/HTML; profile=preview", "text/html; charset=utf-8; profile=preview"},
		{"explicit charset retained", "text/html; charset=gbk", "text/html; charset=gbk"},
		{"image unchanged", "image/png", "image/png"},
		{"CSS unchanged", "text/css", "text/css"},
		{"invalid media type unchanged", "text/html; broken", "text/html; broken"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			writeDocumentPreviewHeaders(context, immutableObjectContent{filename: "file", mediaType: test.mediaType})
			if got := response.Header().Get("Content-Type"); got != test.want {
				t.Fatalf("Content-Type = %q, want %q", got, test.want)
			}
		})
	}
}

func TestDocumentPreviewGenericHTMLContentType(t *testing.T) {
	for _, test := range []struct{ filename, mediaType, want string }{
		{"index.html", "application/octet-stream", "text/html; charset=utf-8"},
		{"INDEX.HTM", "application/octet-stream", "text/html; charset=utf-8"},
		{"index.html", "application/octet-stream; charset=gbk", "text/html; charset=gbk"},
		{"index.html", "text/plain", "text/plain"},
		{"notes.txt", "application/octet-stream", "application/octet-stream"},
	} {
		t.Run(test.filename+test.mediaType, func(t *testing.T) {
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			writeDocumentPreviewHeaders(context, immutableObjectContent{filename: test.filename, mediaType: test.mediaType})
			if got := response.Header().Get("Content-Type"); got != test.want {
				t.Fatalf("Content-Type=%q want=%q", got, test.want)
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("preview must retain nosniff")
			}
		})
	}
}
