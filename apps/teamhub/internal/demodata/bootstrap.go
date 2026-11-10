// Package demodata seeds the local Playground's development sample data through the public HTTP API.
package demodata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

const demoTenantID = "tenant_acme"

// Config describes the TeamHub API and login identity used by development data seeding.
type Config struct {
	BaseURL  string
	Email    string
	Password string
	Client   *http.Client
}

type bootstrapper struct {
	baseURL string
	client  *http.Client
}

type resource struct {
	ID string `json:"id"`
}

type documentResource struct {
	ID             string `json:"id"`
	CurrentVersion *struct {
		ID string `json:"id"`
	} `json:"current_version"`
}

// Bootstrap creates the fixed Playground sample resources.
// Callers must check the development-data switch first; this function does not check the runtime environment itself. The flow is made of several independent
// HTTP writes and is not a single transaction, so a failure may leave prerequisite resources that were already created.
func Bootstrap(ctx context.Context, cfg Config) error {
	base, err := url.Parse(strings.TrimRight(cfg.BaseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return fmt.Errorf("invalid TeamHub API URL %q", cfg.BaseURL)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return err
	}
	client := cfg.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	} else {
		clone := *client
		client = &clone
	}
	client.Jar = jar
	b := bootstrapper{baseURL: base.String(), client: client}

	// Fixed resource identities and stable idempotency keys make a rerun after a mid-way failure converge on the same sample resources.
	// Documents always go to disk through the real API and the configured service storage, never bypassing the business boundary to write tables or files directly.
	if err := b.json(ctx, http.MethodPost, "/v0/auth/login", "", map[string]string{"identifier": cfg.Email, "password": cfg.Password}, http.StatusOK, nil); err != nil {
		return fmt.Errorf("login development account: %w", err)
	}
	var room resource
	if err := b.json(ctx, http.MethodPost, "/v0/tenants/"+demoTenantID+"/rooms", "playground-demo-room-v1", map[string]string{
		"name": "Artifact & Skill Lab", "description": "Development workspace for Artifact and Skill capabilities.",
	}, http.StatusCreated, &room); err != nil {
		return fmt.Errorf("create demo room: %w", err)
	}
	var brief documentResource
	if err := b.upload(ctx, "/v0/rooms/"+room.ID+"/documents/uploads", "playground-demo-brief-v1", "project-brief.md", "text/markdown", "markdown", "", projectBriefV1, &brief); err != nil {
		return fmt.Errorf("upload demo brief: %w", err)
	}
	if brief.CurrentVersion == nil || brief.CurrentVersion.ID == "" {
		return fmt.Errorf("upload demo brief: response omitted current Document Version")
	}
	if err := b.upload(ctx, "/v0/documents/"+brief.ID+"/versions", "playground-demo-brief-v2", "project-brief.md", "text/markdown", "markdown", brief.CurrentVersion.ID, projectBriefV2, nil); err != nil {
		return fmt.Errorf("upload demo brief version: %w", err)
	}
	if err := b.upload(ctx, "/v0/rooms/"+room.ID+"/documents/uploads", "playground-demo-notes-v1", "customer-notes.txt", "text/plain", "binary", "", customerNotes, nil); err != nil {
		return fmt.Errorf("upload demo notes: %w", err)
	}
	return nil
}

func (b bootstrapper) json(ctx context.Context, method, path, key string, input any, wantStatus int, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.baseURL+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return b.do(req, wantStatus, output)
}

func (b bootstrapper) upload(
	ctx context.Context,
	path, key, filename, mediaType, representationFormat, expectedCurrentVersionID, content string,
	output any,
) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("filename", filename); err != nil {
		return err
	}
	if err := writer.WriteField("media_type", mediaType); err != nil {
		return err
	}
	if err := writer.WriteField("representation_format", representationFormat); err != nil {
		return err
	}
	if expectedCurrentVersionID != "" {
		if err := writer.WriteField("expected_current_version_id", expectedCurrentVersionID); err != nil {
			return err
		}
	}
	part, err := writer.CreateFormFile("content", filename)
	if err != nil {
		return err
	}
	if _, err = io.WriteString(part, content); err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+path, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Idempotency-Key", key)
	return b.do(req, http.StatusCreated, output)
}

func (b bootstrapper) do(req *http.Request, wantStatus int, output any) error {
	response, err := b.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != wantStatus {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("%s %s returned %d: %s", req.Method, req.URL.Path, response.StatusCode, strings.TrimSpace(string(body)))
	}
	if output == nil {
		_, err = io.Copy(io.Discard, response.Body)
		return err
	}
	if err := json.NewDecoder(response.Body).Decode(output); err != nil {
		return fmt.Errorf("decode %s %s: %w", req.Method, req.URL.Path, err)
	}
	return nil
}

const projectBriefV1 = `# Document & Skill Lab

This brief is a Human-authored Document stored through the TeamHub API.

- Inspect its immutable version metadata.
- Download the exact stored bytes.
`

const projectBriefV2 = `# Document & Skill Lab

Version 2 adds a second immutable revision while preserving Version 1.

- Inspect both entries in version history.
- Download either exact revision.
`

const customerNotes = `A customer asked for a shared workspace where Human and Agent outputs retain clear provenance.
The first Playground slice demonstrates Human uploads and Skill policy without running an Agent.
`
