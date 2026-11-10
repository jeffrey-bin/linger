package demodata

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBootstrapCreatesDocumentDemoThroughHTTP(t *testing.T) {
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.URL.Path != "/v0/auth/login" {
			if cookie, err := r.Cookie("teamhub_session"); err != nil || cookie.Value != "demo-session" {
				http.Error(w, "missing session", http.StatusUnauthorized)
				return
			}
			if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Idempotency-Key"), "playground-demo-") {
				http.Error(w, "missing stable idempotency key", http.StatusBadRequest)
				return
			}
		}
		switch r.Method + " " + r.URL.Path {
		case "POST /v0/auth/login":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["identifier"] != "alice@example.com" || body["password"] != "teamhub-dev-alice" {
				http.Error(w, "bad login", http.StatusBadRequest)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "teamhub_session", Value: "demo-session", Path: "/"})
			writeTestJSON(w, http.StatusOK, map[string]any{"identity": map[string]any{}})
		case "POST /v0/tenants/tenant_acme/rooms":
			writeTestJSON(w, http.StatusCreated, map[string]any{"id": "room_demo"})
		case "POST /v0/rooms/room_demo/documents/uploads":
			fields, content := readTestUpload(t, r)
			if fields["representation_format"] == "" || fields["expected_current_version_id"] != "" {
				t.Fatalf("unexpected Document upload fields: %+v", fields)
			}
			switch fields["filename"] {
			case "project-brief.md":
				if fields["representation_format"] != "markdown" || !strings.Contains(content, "Document & Skill Lab") {
					t.Fatalf("unexpected project brief fields=%+v content=%q", fields, content)
				}
				writeTestJSON(w, http.StatusCreated, map[string]any{
					"id": "document_brief", "current_version": map[string]any{"id": "version_brief_1"},
				})
			case "customer-notes.txt":
				if fields["representation_format"] != "binary" || !strings.Contains(content, "customer") {
					t.Fatalf("unexpected customer notes fields=%+v content=%q", fields, content)
				}
				writeTestJSON(w, http.StatusCreated, map[string]any{
					"id": "document_notes", "current_version": map[string]any{"id": "version_notes_1"},
				})
			default:
				t.Fatalf("unexpected demo upload %q", fields["filename"])
			}
		case "POST /v0/documents/document_brief/versions":
			fields, content := readTestUpload(t, r)
			if fields["filename"] != "project-brief.md" || fields["representation_format"] != "markdown" ||
				fields["expected_current_version_id"] != "version_brief_1" || !strings.Contains(content, "Version 2") {
				t.Fatalf("unexpected replacement Version fields=%+v content=%q", fields, content)
			}
			writeTestJSON(w, http.StatusCreated, map[string]any{"id": "version_brief_2", "document_id": "document_brief"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	for range 2 {
		err := Bootstrap(context.Background(), Config{
			BaseURL:  server.URL,
			Email:    "alice@example.com",
			Password: "teamhub-dev-alice",
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	wantOnce := []string{
		"POST /v0/auth/login",
		"POST /v0/tenants/tenant_acme/rooms",
		"POST /v0/rooms/room_demo/documents/uploads",
		"POST /v0/documents/document_brief/versions",
		"POST /v0/rooms/room_demo/documents/uploads",
	}
	want := append(append([]string{}, wantOnce...), wantOnce...)
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s\nwant:\n%s", strings.Join(calls, "\n"), strings.Join(want, "\n"))
	}
}

func readTestUpload(t *testing.T, r *http.Request) (map[string]string, string) {
	t.Helper()
	fields := map[string]string{}
	content := ""
	reader, err := r.MultipartReader()
	if err != nil {
		t.Fatal(err)
	}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		if part.FormName() == "content" {
			content = string(data)
		} else {
			fields[part.FormName()] = string(data)
		}
	}
	return fields, content
}

func writeTestJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
