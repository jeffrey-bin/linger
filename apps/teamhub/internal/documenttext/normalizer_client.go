package documenttext

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// Status values persisted in document_texts.status.
const (
	StatusReady       = "ready"
	StatusTooLarge    = "too_large"
	StatusNoText      = "no_text"
	StatusUnsupported = "unsupported"
	StatusFailed      = "failed"
)

// MaxNormalizedMarkdownBytes mirrors the normalization contract's 32 MiB output limit.
const MaxNormalizedMarkdownBytes = 32 * 1024 * 1024

// NormalizationSource is one immutable file Version as the normalizer sees it.
// The filename and representation format pick the extractor when the stored
// media type is generic, such as application/octet-stream for a .ts upload.
type NormalizationSource struct {
	MediaType            string
	Filename             string
	RepresentationFormat string
	Bytes                []byte
}

// NormalizedDocument is one normalization outcome that needs no retry.
// Markdown is set only when Status is StatusReady.
type NormalizedDocument struct {
	Status   string
	Markdown []byte
}

// NormalizerClient calls the document normalization contract
// (POST /v0/document-normalizations): raw source bytes in, Markdown out.
type NormalizerClient struct {
	endpoint   string
	token      string
	httpClient *http.Client
}

// NewNormalizerClient targets the service base URL that serves the
// normalization contract, for example http://localhost:4319.
func NewNormalizerClient(baseURL, token string, httpClient *http.Client) (*NormalizerClient, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("normalizer base URL %q is invalid", baseURL)
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("normalizer service token is required")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + "/v0/document-normalizations"
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return &NormalizerClient{endpoint: parsed.String(), token: token, httpClient: httpClient}, nil
}

// Normalize converts one immutable source. Outcomes that the same bytes would
// repeat are statuses: a timeout and a rejected request are failed, the
// contract's terminal errors keep their own status. Only an unavailable
// normalizer, another 5xx and a transport failure return an error for River
// to retry.
func (c *NormalizerClient) Normalize(ctx context.Context, source NormalizationSource) (NormalizedDocument, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(source.Bytes))
	if err != nil {
		return NormalizedDocument{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Source-Media-Type", source.MediaType)
	request.Header.Set("X-Source-Filename", url.PathEscape(document.SafeSourceFilename(source.Filename)))
	request.Header.Set("X-Source-Representation-Format", source.RepresentationFormat)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return NormalizedDocument{}, fmt.Errorf("call document normalizer: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		markdown, err := io.ReadAll(io.LimitReader(response.Body, MaxNormalizedMarkdownBytes+1))
		if err != nil {
			return NormalizedDocument{}, fmt.Errorf("read normalized Markdown: %w", err)
		}
		if len(markdown) > MaxNormalizedMarkdownBytes {
			return NormalizedDocument{Status: StatusTooLarge}, nil
		}
		return NormalizedDocument{Status: StatusReady, Markdown: markdown}, nil
	}
	code := readErrorCode(response.Body)
	switch {
	case response.StatusCode == http.StatusRequestEntityTooLarge, code == "DOCUMENT_MARKDOWN_TOO_LARGE":
		return NormalizedDocument{Status: StatusTooLarge}, nil
	case response.StatusCode == http.StatusUnsupportedMediaType:
		return NormalizedDocument{Status: StatusUnsupported}, nil
	case response.StatusCode == http.StatusBadRequest, code == "DOCUMENT_NORMALIZATION_TIMEOUT":
		return NormalizedDocument{Status: StatusFailed}, nil
	case response.StatusCode == http.StatusUnprocessableEntity:
		return NormalizedDocument{Status: StatusNoText}, nil
	default:
		return NormalizedDocument{}, fmt.Errorf("normalizer returned %d %s", response.StatusCode, code)
	}
}

func readErrorCode(body io.Reader) string {
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(body, 64*1024)).Decode(&payload); err != nil {
		return ""
	}
	return payload.Error.Code
}
