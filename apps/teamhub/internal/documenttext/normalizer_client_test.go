package documenttext

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestNormalizerClientMapsContractResponses(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		status     int
		body       string
		wantStatus string
		wantText   string
		wantErr    bool
	}{
		{name: "ready", status: http.StatusOK, body: "# Title\n\nbody", wantStatus: StatusReady, wantText: "# Title\n\nbody"},
		{name: "source too large", status: http.StatusRequestEntityTooLarge, body: `{"error":{"code":"DOCUMENT_SOURCE_TOO_LARGE"}}`, wantStatus: StatusTooLarge},
		{name: "unsupported", status: http.StatusUnsupportedMediaType, body: `{"error":{"code":"DOCUMENT_SOURCE_UNSUPPORTED"}}`, wantStatus: StatusUnsupported},
		{name: "no text", status: http.StatusUnprocessableEntity, body: `{"error":{"code":"DOCUMENT_SOURCE_EMPTY"}}`, wantStatus: StatusNoText},
		{name: "markdown too large", status: http.StatusUnprocessableEntity, body: `{"error":{"code":"DOCUMENT_MARKDOWN_TOO_LARGE"}}`, wantStatus: StatusTooLarge},
		// The same bytes time out again, so a timeout fails without a retry.
		{name: "timeout fails", status: http.StatusUnprocessableEntity, body: `{"error":{"code":"DOCUMENT_NORMALIZATION_TIMEOUT"}}`, wantStatus: StatusFailed},
		{name: "bad request fails", status: http.StatusBadRequest, body: `{"error":{"code":"DOCUMENT_NORMALIZATION_INVALID"}}`, wantStatus: StatusFailed},
		{name: "unavailable is retried", status: http.StatusServiceUnavailable, body: `{"error":{"code":"DOCUMENT_NORMALIZATION_UNAVAILABLE"}}`, wantErr: true},
		{name: "proxy error is retried", status: http.StatusBadGateway, body: `<html>bad gateway</html>`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var gotMediaType, gotFilename, gotFormat, gotAuthorization, gotPath string
			var gotBody []byte
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				gotPath = request.URL.Path
				gotMediaType = request.Header.Get("X-Source-Media-Type")
				gotFilename = request.Header.Get("X-Source-Filename")
				gotFormat = request.Header.Get("X-Source-Representation-Format")
				gotAuthorization = request.Header.Get("Authorization")
				gotBody, _ = io.ReadAll(request.Body)
				writer.WriteHeader(tc.status)
				_, _ = writer.Write([]byte(tc.body))
			}))
			defer server.Close()
			client, err := NewNormalizerClient(server.URL+"/", "token-1", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.Normalize(context.Background(), NormalizationSource{
				MediaType: "application/octet-stream", Filename: "Größe plan#1.ts", RepresentationFormat: "code", Bytes: []byte("%PDF"),
			})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error for River to retry, got %+v", result)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != tc.wantStatus || string(result.Markdown) != tc.wantText {
				t.Fatalf("got %q/%q, want %q/%q", result.Status, result.Markdown, tc.wantStatus, tc.wantText)
			}
			// The filename is percent-encoded UTF-8 so any name fits in a header.
			if gotPath != "/v0/document-normalizations" || gotMediaType != "application/octet-stream" ||
				gotFilename != "Gr%C3%B6%C3%9Fe%20plan%231.ts" || gotFormat != "code" ||
				gotAuthorization != "Bearer token-1" || string(gotBody) != "%PDF" {
				t.Fatalf("request not forwarded as the contract expects: path=%q media=%q filename=%q format=%q auth=%q body=%q",
					gotPath, gotMediaType, gotFilename, gotFormat, gotAuthorization, gotBody)
			}
		})
	}
}

// The normalization route rejects control characters and filenames longer
// than 255 UTF-16 code units, so the client sends what it accepts.
func TestNormalizerClientSendsSafeFilename(t *testing.T) {
	t.Parallel()
	var gotFilename string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		filename, err := url.PathUnescape(request.Header.Get("X-Source-Filename"))
		if err != nil || len(request.Header.Get("X-Source-Filename")) > 1024 || len(utf16.Encode([]rune(filename))) > 255 ||
			strings.ContainsFunc(filename, func(character rune) bool { return character <= 0x1f || character == 0x7f }) {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":{"code":"DOCUMENT_NORMALIZATION_INVALID"}}`))
			return
		}
		gotFilename = filename
		_, _ = writer.Write([]byte("body"))
	}))
	defer server.Close()
	client, err := NewNormalizerClient(server.URL, "token-1", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Normalize(context.Background(), NormalizationSource{
		MediaType: "application/pdf", Filename: strings.Repeat("€", 90) + "	.pdf", RepresentationFormat: "pdf", Bytes: []byte("%PDF"),
	})
	if err != nil || result.Status != StatusReady || gotFilename != strings.Repeat("€", 83)+".pdf" {
		t.Fatalf("result=%+v filename=%q error=%v", result, gotFilename, err)
	}
}

func TestNewNormalizerClientRejectsBadConfiguration(t *testing.T) {
	t.Parallel()
	if _, err := NewNormalizerClient("", "token", nil); err == nil {
		t.Fatal("expected error for empty base URL")
	}
	if _, err := NewNormalizerClient("http://localhost:4320", " ", nil); err == nil {
		t.Fatal("expected error for empty token")
	}
	client, err := NewNormalizerClient("http://localhost:4320/mcp", "token", nil)
	if err != nil {
		t.Fatal(err)
	}
	if client.endpoint != "http://localhost:4320/mcp/v0/document-normalizations" {
		t.Fatalf("endpoint = %q", client.endpoint)
	}
}
