package composio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientFileUploadRequestUsesOfficialSingleFileContract(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3.1/files/upload/request" || r.Header.Get("x-api-key") != "test-project-key" {
			t.Error("invalid upload request route or credential boundary")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body) != 5 || body["filename"] != "report.pdf" || body["mimetype"] != "application/pdf" || body["md5"] != "d41d8cd98f00b204e9800998ecf8427e" || body["tool_slug"] != "GMAIL_SEND_EMAIL" || body["toolkit_slug"] != "gmail" {
			t.Error("upload request fields do not match the Files API")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"key":"files/report","new_presigned_url":"https://fixture.s3.amazonaws.com/report"}`))
	}))
	defer server.Close()
	client, err := newTestClient(Config{BaseURL: server.URL, APIKey: "test-project-key", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	target, err := client.RequestFileUpload(context.Background(), FileUploadRequest{Filename: "report.pdf", Mimetype: "application/pdf", MD5: "d41d8cd98f00b204e9800998ecf8427e", ToolSlug: "GMAIL_SEND_EMAIL", ToolkitSlug: "gmail"})
	if err != nil || target.Key != "files/report" || calls != 1 {
		t.Fatalf("target=%+v calls=%d error=%v", target, calls, err)
	}
}
