package agentconnectedapps

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFileUploadSchemaDetectionOnlyAcceptsExplicitFileInputs(t *testing.T) {
	for _, input := range []struct {
		schema any
		want   bool
	}{
		{map[string]any{"type": "object", "properties": map[string]any{"attachment": map[string]any{"anyOf": []any{map[string]any{"file_uploadable": true}}}}}, true},
		{map[string]any{"description": "file_uploadable", "file_uploadable": "true"}, false},
		{map[string]any{"properties": map[string]any{"content": map[string]any{"type": "string"}}}, false},
	} {
		if got := hasFileUploadInput(input.schema, 0); got != input.want {
			t.Errorf("file input detection got %v, expected %v", got, input.want)
		}
	}
}

func TestTransferFilePutsTheBytesOnlyWhereTheProviderSaid(t *testing.T) {
	var got struct {
		method, contentType, body string
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/stored", http.StatusFound)
		case "/broken":
			w.WriteHeader(http.StatusForbidden)
		default:
			body, _ := io.ReadAll(r.Body)
			got.method, got.contentType, got.body = r.Method, r.Header.Get("Content-Type"), string(body)
		}
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = fileTransferClient.CheckRedirect
	if err := transferFile(t.Context(), client, server.URL+"/stored", "text/markdown", []byte("# Report")); err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodPut || got.contentType != "text/markdown" || got.body != "# Report" {
		t.Fatalf("upload=%+v", got)
	}
	got.body = ""
	for _, path := range []string{"/moved", "/broken"} {
		if err := transferFile(t.Context(), client, server.URL+path, "text/markdown", []byte("x")); err == nil {
			t.Fatalf("%s accepted", path)
		}
	}
	if got.body != "" {
		t.Fatal("a redirect was followed")
	}
}
